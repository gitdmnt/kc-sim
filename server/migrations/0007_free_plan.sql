-- Workers Free plan (10 ms CPU per invocation, docs/DEPLOY.md "CPU budget"): uploads are staged and processed
-- by the cron in budgeted steps; the estimator counts rolls per signature before folding them into the grids;
-- the grids are base64 TEXT (D1 hands BLOBs to the worker as JSON number arrays, ~1 ms per 80 KB grid).

-- POST /api/v1/observations stores the body's items here (split by SQLite json_each, never parsed by the
-- worker). The cron validates them oldest first (ingest/upload.ts ingestPending) and deletes them in the
-- same batch that stores the observation (or its rejection).
CREATE TABLE upload_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  client_obs_id TEXT,                      -- NULL when the item has no string clientObsId (rejected later)
  received_at TEXT NOT NULL,               -- ISO time of the request; becomes observations.uploaded_at
  item TEXT NOT NULL,                      -- the observation JSON as uploaded
  bytes INTEGER NOT NULL,
  UNIQUE (client_id, client_obs_id)
);

-- One upload body while its batch splits it (inserted and deleted in the same batch).
CREATE TABLE upload_bodies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL
);

-- Maps whose poi-observed comp sets are older than their counters. Re-materialising rewrites every comp row of
-- the map, so it happens once the map's pending observations are folded in, or after 30 min of a steady stream
-- (observed/aggregate.ts), not after every aggregation step: D1 Free allows 100 000 written rows a day.
CREATE TABLE poi_dirty_maps (
  map_id INTEGER PRIMARY KEY,
  since TEXT NOT NULL
);

-- Estimator rolls not yet folded into the grids, counted per (ship, role, canonical query signature). A fold
-- costs one forward-model grid per row, however many rolls the row holds. WITHOUT ROWID: the key is the table,
-- so an upsert writes one row instead of a row plus its key index.
CREATE TABLE estimator_rolls (
  ship_id INTEGER NOT NULL,
  role TEXT NOT NULL,                      -- evasion | accuracy
  sig TEXT NOT NULL,                       -- canonical AttackQuery JSON (shared/estimate/forward.ts signature)
  miss INTEGER NOT NULL,
  hit INTEGER NOT NULL,
  crit INTEGER NOT NULL,
  PRIMARY KEY (ship_id, role, sig)
) WITHOUT ROWID;

-- Grids as base64 of Float32 little-endian (NULL = no rolls of that role yet). The old BLOB grids are dropped
-- and every observation is queued again.
DROP TABLE estimator_accum;
CREATE TABLE estimator_accum (
  ship_id INTEGER PRIMARY KEY,
  axes TEXT NOT NULL,                      -- JSON GridSpec {ev, acc, luck: {min, max, step}} of the grids
  ll_ev TEXT,                              -- ev × luck
  ll_acc TEXT,                             -- luck × acc
  n_ev INTEGER NOT NULL,
  n_acc INTEGER NOT NULL,
  dirty_since TEXT,                        -- first fold since the last summary; NULL = estimator_posteriors / estimates current
  updated_at TEXT NOT NULL
);
CREATE INDEX estimator_accum_dirty ON estimator_accum(dirty_since) WHERE dirty_since IS NOT NULL;
DELETE FROM estimator_posteriors;
DELETE FROM estimates WHERE source_id = (SELECT id FROM sources WHERE key = 'estimator:server');

-- The estimator queue again, every pair pending. WITHOUT ROWID and a partial pending index: a queued pair
-- writes the row and one index entry, and folding it removes that entry. observation_ships_ship is gone; only
-- the rare per-ship reset (admin rebuild / client deletion) scanned by ship.
CREATE TABLE observation_ships_new (
  observation_id INTEGER NOT NULL,
  ship_id INTEGER NOT NULL,
  est_at TEXT,
  PRIMARY KEY (observation_id, ship_id)
) WITHOUT ROWID;
INSERT INTO observation_ships_new (observation_id, ship_id) SELECT observation_id, ship_id FROM observation_ships;
DROP TABLE observation_ships;
ALTER TABLE observation_ships_new RENAME TO observation_ships;
CREATE INDEX observation_ships_pending ON observation_ships(observation_id) WHERE est_at IS NULL;

-- One lease for the scheduled jobs (ingest, aggregation, estimator), replacing estimator_lock_until.
INSERT INTO kv_state (key, value) VALUES ('jobs_lock_until', '0');
DELETE FROM kv_state WHERE key = 'estimator_lock_until';
UPDATE kv_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version';
