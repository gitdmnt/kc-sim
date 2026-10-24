-- Deployment hardening (docs/API.md §3, §4, private deployment notes): per-install tokens, validation records,
-- server-side estimation, GET cache versioning.

-- Per-install upload clients. The bearer token is stored only as its SHA-256 (hex); the issuing IP only as
-- HMAC-SHA-256(IP_HASH_SALT, CF-Connecting-IP) (hex), for the per-IP issuance limits.
CREATE TABLE clients (
  id TEXT PRIMARY KEY,                     -- "c_" + 16 random bytes (base64url)
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,             -- epoch ms
  last_post_at INTEGER NOT NULL DEFAULT 0, -- epoch ms of the last admitted POST /observations (1 per 60 s gate)
  banned_at TEXT,
  ban_reason TEXT
);
CREATE INDEX clients_ip ON clients(ip_hash, created_at);

-- Every validation outcome other than a clean accept: rejected (not stored), quarantined (stored, excluded
-- from aggregation and estimation) or flagged (stored and used).
CREATE TABLE observation_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  client_obs_id TEXT,
  kind TEXT,
  map_id INTEGER,
  rule TEXT NOT NULL,
  action TEXT NOT NULL,                    -- reject | quarantine | flag
  detail TEXT,
  observation_id INTEGER,                  -- stored observation (quarantine / flag)
  created_at TEXT NOT NULL
);
CREATE INDEX observation_rejections_client ON observation_rejections(client_id);
CREATE INDEX observation_rejections_rule ON observation_rejections(action, rule);

ALTER TABLE observations ADD COLUMN quarantine TEXT;     -- quarantining rules; NULL = usable
-- Uploads before this migration were never validated: keep them for inspection only.
UPDATE observations SET quarantine = 'legacy_unvalidated';

-- Estimator work queue: one row per (battle observation, enemy master id). est_at NULL = the ship's
-- log-likelihood grids do not contain this observation yet.
CREATE TABLE observation_ships (
  observation_id INTEGER NOT NULL,
  ship_id INTEGER NOT NULL,
  est_at TEXT,
  PRIMARY KEY (observation_id, ship_id)
);
CREATE INDEX observation_ships_pending ON observation_ships(est_at, observation_id);
CREATE INDEX observation_ships_ship ON observation_ships(ship_id);

-- Accumulated log-likelihood grids per enemy ship (shared/estimate/posterior.ts ShipPosterior), Float32
-- little-endian, each grid shifted so that its maximum is 0 (constant shifts cancel in the marginals).
CREATE TABLE estimator_accum (
  ship_id INTEGER PRIMARY KEY,
  axes TEXT NOT NULL,                      -- JSON GridSpec {ev, acc, luck: {min, max, step}} of the grids
  ll_ev BLOB NOT NULL,                     -- ev × luck
  ll_acc BLOB NOT NULL,                    -- luck × acc
  n_ev INTEGER NOT NULL,
  n_acc INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 1,        -- 1 = estimator_posteriors / estimates not yet recomputed
  updated_at TEXT NOT NULL
);

-- Posterior summaries for GET /api/v1/estimates (every n; `estimates` only gets rows with n >= 30).
CREATE TABLE estimator_posteriors (
  ship_id INTEGER NOT NULL,
  stat TEXT NOT NULL,                      -- ev | acc | luck
  mean REAL NOT NULL,
  sd REAL NOT NULL,
  ci_lo REAL NOT NULL,
  ci_hi REAL NOT NULL,
  n INTEGER NOT NULL,
  prior TEXT NOT NULL,                     -- JSON {source, confidence, value, sd}
  density TEXT NOT NULL,                   -- JSON {min, step, posterior[], prior[]} (<= 101 points)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ship_id, stat)
);

ALTER TABLE estimates ADD COLUMN ci_lo REAL;               -- estimator:server 90 % credible interval
ALTER TABLE estimates ADD COLUMN ci_hi REAL;
-- Client-computed estimates (POST /api/v1/estimates, removed) are not trusted.
DELETE FROM estimates WHERE source_id IN (SELECT id FROM sources WHERE key LIKE 'estimator%');
DELETE FROM sources WHERE key LIKE 'estimator%';
INSERT INTO sources (key, name, url, licence, revision, fetched_at)
VALUES ('estimator:server', 'kc-sim server estimator (Bayesian grid posterior over validated poi observations)', NULL, 'project', NULL, '2026-10-22T00:00:00Z');

-- Fuel / ammo capacity (api_fuel_max / api_bull_max) for the estimator's fuel reconstruction.
ALTER TABLE ships ADD COLUMN fuel_max INTEGER;
ALTER TABLE ships ADD COLUMN ammo_max INTEGER;

-- data_version: bumped by every write that changes API output; part of the GET cache key.
-- estimator_lock_until: lease (epoch ms) so that only one estimator run folds grids at a time.
INSERT INTO kv_state (key, value) VALUES ('data_version', '1'), ('estimator_lock_until', '0');
