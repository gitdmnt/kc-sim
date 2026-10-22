-- kc-sim data platform schema (docs/DATA_SOURCES.md §9, docs/API.md). JSON columns are TEXT.

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,            -- stable id, e.g. 'tibowl-start2'
  name TEXT NOT NULL,
  url TEXT,
  licence TEXT,
  revision TEXT,                       -- git commit sha or content sha256
  fetched_at TEXT NOT NULL
);

CREATE TABLE ship_types (
  id INTEGER PRIMARY KEY,              -- api_mst_stype.api_id
  code TEXT,                           -- DSL code (DE, DD, ...)
  name TEXT NOT NULL
);

CREATE TABLE ships (
  id INTEGER PRIMARY KEY,              -- api_mst_ship.api_id (abyssal > 1500)
  name TEXT NOT NULL,
  name_en TEXT,
  yomi TEXT,
  stype INTEGER NOT NULL,
  ctype INTEGER,
  speed INTEGER,
  range INTEGER,
  slot_num INTEGER,
  is_abyssal INTEGER NOT NULL,
  -- player ships: values at level 1 (api_*[0]); abyssal: fixed values
  hp INTEGER, fp INTEGER, tp INTEGER, aa INTEGER, ar INTEGER, luck INTEGER,
  max_stats TEXT,                      -- JSON {hp, fp, tp, aa, ar, luck} (player ships, api_*[1])
  slots TEXT,                          -- JSON plane capacities
  equips TEXT,                         -- JSON default equipment ids (abyssal)
  flags TEXT,                          -- JSON mechanics flags (abyssal: installation, pt, oasw, ...)
  source_id INTEGER REFERENCES sources(id),
  updated_at TEXT NOT NULL
);
CREATE INDEX ships_abyssal ON ships(is_abyssal);

CREATE TABLE equip_types (
  id INTEGER PRIMARY KEY,              -- api_mst_slotitem_equiptype.api_id (= api_type[2])
  name TEXT NOT NULL
);

CREATE TABLE equipments (
  id INTEGER PRIMARY KEY,              -- api_mst_slotitem.api_id (abyssal > 1500)
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- JSON api_type[5]
  type_id INTEGER NOT NULL,            -- api_type[2]
  icon INTEGER,                        -- api_type[3]
  fp INTEGER, tp INTEGER, aa INTEGER, ar INTEGER, bomb INTEGER, asw INTEGER,
  los INTEGER, acc INTEGER, ev INTEGER, luck INTEGER, range INTEGER,
  radius INTEGER, cost INTEGER,
  is_abyssal INTEGER NOT NULL,
  source_id INTEGER REFERENCES sources(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE maps (
  id INTEGER PRIMARY KEY,              -- api_mst_mapinfo.api_id = world*10+no
  world INTEGER NOT NULL,
  no INTEGER NOT NULL,
  name TEXT,
  opetext TEXT,
  is_event INTEGER NOT NULL,
  max_hp INTEGER,
  required_defeat_count INTEGER,
  source_id INTEGER REFERENCES sources(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE nodes (
  map_id INTEGER NOT NULL,
  letter TEXT NOT NULL,
  x INTEGER, y INTEGER,
  color_no INTEGER,                    -- api_color_no of the edge entering the node (KCNav route[2])
  event_id INTEGER,                    -- api_event_id (KCNav route[3])
  event_kind INTEGER,
  node_type TEXT,                      -- start|battle|boss|empty|select|air_raid|resource|... (derived)
  is_boss INTEGER NOT NULL DEFAULT 0,
  source_id INTEGER REFERENCES sources(id),
  PRIMARY KEY (map_id, letter)
);

CREATE TABLE edges (
  map_id INTEGER NOT NULL,
  edge_id INTEGER NOT NULL,            -- game edge number (KC3 / KCNav / EO agree)
  from_letter TEXT NOT NULL,
  to_letter TEXT NOT NULL,
  source_id INTEGER REFERENCES sources(id),
  PRIMARY KEY (map_id, edge_id)
);
CREATE INDEX edges_from ON edges(map_id, from_letter);

CREATE TABLE routing_maps (            -- one ROUTING_DSL document per map (header part)
  map_id INTEGER PRIMARY KEY,
  layout TEXT,
  sources TEXT NOT NULL,               -- JSON [{id, note}]
  defaults TEXT,                       -- JSON {select?, flags?}
  rule_count INTEGER NOT NULL,
  uncertain_count INTEGER NOT NULL,
  source_id INTEGER REFERENCES sources(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE routing_rules (           -- one row per node of the document
  map_id INTEGER NOT NULL,
  from_letter TEXT NOT NULL,
  ord INTEGER NOT NULL,                -- node order in the source document
  node TEXT NOT NULL,                  -- JSON node definition ({rules:[...]} or {end:true})
  PRIMARY KEY (map_id, from_letter)
);

CREATE TABLE enemy_comp_sets (         -- one KCNav (or other) snapshot for (map,node,difficulty,period)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id INTEGER NOT NULL,
  node_letter TEXT NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 0,
  period_start TEXT NOT NULL DEFAULT '',
  period_end TEXT NOT NULL DEFAULT '',
  total_count INTEGER NOT NULL,
  retrieved_at TEXT NOT NULL,
  cache_id INTEGER REFERENCES kcnav_cache(id),
  source_id INTEGER REFERENCES sources(id),
  UNIQUE (map_id, node_letter, difficulty, period_start, period_end)
);

CREATE TABLE enemy_comps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES enemy_comp_sets(id) ON DELETE CASCADE,
  kcnav_master_id INTEGER,
  formation INTEGER,
  count INTEGER NOT NULL,
  weight REAL NOT NULL,                -- count / set.total_count
  airpower TEXT,                       -- JSON [4]
  lbas_airpower TEXT                   -- JSON [4]
);
CREATE INDEX enemy_comps_set ON enemy_comps(set_id);

CREATE TABLE enemy_comp_ships (
  comp_id INTEGER NOT NULL REFERENCES enemy_comps(id) ON DELETE CASCADE,
  fleet INTEGER NOT NULL,              -- 0 main, 1 escort
  position INTEGER NOT NULL,
  ship_id INTEGER NOT NULL,
  level INTEGER,
  hp INTEGER, fp INTEGER, tp INTEGER, aa INTEGER, ar INTEGER,
  equips TEXT NOT NULL,                -- JSON ids (-1 = empty)
  PRIMARY KEY (comp_id, fleet, position)
);

CREATE TABLE estimates (               -- hidden / uncertain stats; several sources per (ship, stat)
  ship_id INTEGER NOT NULL,
  stat TEXT NOT NULL,                  -- ev|asw|los|luck|acc
  value REAL NOT NULL,
  confidence TEXT NOT NULL,            -- observed|datamined|db_estimate|placeholder
  sd REAL,                             -- posterior sd (estimator uploads)
  n INTEGER,                           -- sample size (estimator uploads)
  source_id INTEGER NOT NULL REFERENCES sources(id),
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ship_id, stat, source_id)
);

CREATE TABLE fit_bonuses (             -- EO FitBonuses.json entries, verbatim structure
  id INTEGER PRIMARY KEY,              -- index in source array
  equip_ids TEXT,                      -- JSON ids or null
  equip_types TEXT,                    -- JSON api_type[2] list or null
  bonuses TEXT NOT NULL,               -- JSON [{shipClass?, shipType?, shipId?, shipMasterId?, level?, num?, requires?, bonus{...}, ...}]
  source_id INTEGER REFERENCES sources(id)
);

CREATE TABLE observations (            -- uploads from the poi plugin (battle packets)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  client_obs_id TEXT NOT NULL,         -- plugin-side id, makes uploads idempotent
  observed_at TEXT NOT NULL,
  map_id INTEGER NOT NULL,
  node_letter TEXT,
  difficulty INTEGER,
  path TEXT,                           -- JSON node letters
  kind TEXT NOT NULL,                  -- 'battle' | 'route'
  fleet TEXT,                          -- JSON fleet snapshot
  enemy TEXT,                          -- JSON enemy side (ship_ke, lv, maxhps, eParam, eSlot, formation)
  raw TEXT,                            -- JSON raw packet subset
  uploaded_at TEXT NOT NULL,
  UNIQUE (client_id, client_obs_id)
);
CREATE INDEX observations_map ON observations(map_id, node_letter);

CREATE TABLE kcnav_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX kcnav_cache_url ON kcnav_cache(url);

CREATE TABLE kcnav_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                  -- 'map' | 'enemycomps'
  path TEXT NOT NULL,                  -- path + query under https://tsunkit.net
  map_id INTEGER NOT NULL,
  node_letter TEXT,
  difficulty INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,  -- lower runs first
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0, -- epoch ms
  last_error TEXT,
  cache_id INTEGER REFERENCES kcnav_cache(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (path)
);
CREATE INDEX kcnav_queue_pick ON kcnav_queue(status, next_run_at, priority, id);

CREATE TABLE kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Global KCNav gate: epoch ms before which no request may be sent (persisted across restarts).
INSERT INTO kv_state (key, value) VALUES ('kcnav_next_allowed_at', '0');
