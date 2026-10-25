-- Trust model (src/auth/trust.ts): clients on probation until trusted, IP bans, distinct reporters per layout and
-- per comp cell, per-client daily caps on what the aggregates and the estimator take from one client.

ALTER TABLE clients ADD COLUMN trusted_at TEXT;   -- NULL = on probation: stored, not aggregated or estimated
-- Clients from before the trust model (the repository was private) that uploaded usable data are trusted.
UPDATE clients SET trusted_at = '2026-10-25T00:00:00Z'
  WHERE banned_at IS NULL AND EXISTS (SELECT 1 FROM observations o WHERE o.client_id = clients.id AND o.quarantine IS NULL);

-- Banned salted IP hashes (clients.ip_hash or the request's): no registration, no uploads, no promotion.
CREATE TABLE banned_ips (
  ip_hash TEXT PRIMARY KEY,
  reason TEXT,
  banned_at TEXT NOT NULL
);

-- Distinct reporters (clients.ip_hash) per layout and per comp cell, written by the aggregation fold.
CREATE TABLE poi_layout_reporters (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  PRIMARY KEY (map_id, layout, ip_hash)
) WITHOUT ROWID;
CREATE TABLE poi_cell_reporters (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  cell_no INTEGER NOT NULL,
  difficulty INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  PRIMARY KEY (map_id, layout, cell_no, difficulty, ip_hash)
) WITHOUT ROWID;

-- The map's current layout, chosen when its comp sets are materialised: the newest layout with enough distinct
-- reporters, else the layout most reporters saw (the oldest on a tie). The version order alone was spoofable.
ALTER TABLE poi_layouts ADD COLUMN current INTEGER NOT NULL DEFAULT 0;
-- poi-observed sets: distinct reporters of the set's encounters (NULL for other sources).
ALTER TABLE enemy_comp_sets ADD COLUMN reporters INTEGER;

-- Observations folded per client, map, cell (-1: sorties) and upload day; battles counted per client, enemy
-- ship and upload day. Observations beyond the caps are marked agg_error 'client_cap' / not counted.
CREATE TABLE poi_client_days (
  client_id TEXT NOT NULL,
  map_id INTEGER NOT NULL,
  cell_no INTEGER NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (client_id, map_id, cell_no, day)
) WITHOUT ROWID;
CREATE TABLE estimator_client_days (
  client_id TEXT NOT NULL,
  ship_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (client_id, ship_id, day)
) WITHOUT ROWID;

-- The aggregates have no reporters yet: clear them and refold every observation (as POST /admin/aggregate/rebuild).
DELETE FROM poi_layouts;
DELETE FROM poi_cells;
DELETE FROM poi_edge_counts;
DELETE FROM poi_comp_counts;
DELETE FROM poi_drop_counts;
DELETE FROM poi_sorties;
DELETE FROM poi_graph_mismatches;
DELETE FROM enemy_comp_ships WHERE comp_id IN (SELECT id FROM enemy_comps WHERE set_id IN
  (SELECT id FROM enemy_comp_sets WHERE source_id = (SELECT id FROM sources WHERE key = 'poi-observed')));
DELETE FROM enemy_comps WHERE set_id IN (SELECT id FROM enemy_comp_sets WHERE source_id = (SELECT id FROM sources WHERE key = 'poi-observed'));
DELETE FROM enemy_comp_sets WHERE source_id = (SELECT id FROM sources WHERE key = 'poi-observed');
UPDATE observations SET aggregated_at = NULL, agg_error = NULL;
UPDATE kv_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version';
