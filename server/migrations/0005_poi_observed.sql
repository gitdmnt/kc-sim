-- poi-observed: map graph, routes and enemy comps aggregated from the plugin's own captures
-- (docs/API.md §3 "Aggregation", DATA_SOURCES.md §9). Aggregates key on raw game cell numbers (api_no);
-- node letters are resolved through `edges` (edge_id = destination cell no) only when materialising.

-- Uploads: raw cell, layout key and sortie record; aggregation bookkeeping (idempotency + rebuild).
ALTER TABLE observations ADD COLUMN cell_no INTEGER;          -- api_no of the battle cell
ALTER TABLE observations ADD COLUMN layout TEXT;              -- sorted api_cell_data api_no list, "0,1,2,…" ('' unknown)
ALTER TABLE observations ADD COLUMN sortie TEXT;              -- JSON sortie record (kind 'sortie')
ALTER TABLE observations ADD COLUMN aggregated_at TEXT;       -- NULL = not yet folded into poi_* aggregates
ALTER TABLE observations ADD COLUMN agg_error TEXT;           -- set when the observation could not be aggregated
CREATE INDEX observations_pending ON observations(aggregated_at, id);
CREATE INDEX observations_client ON observations(client_id);

-- One row per (map, layout). version: 1, 2, … in order of first aggregation; 0 = unknown layout ('').
CREATE TABLE poi_layouts (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  version INTEGER NOT NULL,
  cells TEXT,                          -- JSON api_cell_data of the newest sortie [{no, colorNo, passed, distance}]
  boss_cell INTEGER,                   -- api_bosscell_no
  sorties INTEGER NOT NULL DEFAULT 0,
  encounters INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (map_id, layout)
);

CREATE TABLE poi_cells (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  cell_no INTEGER NOT NULL,
  color_no INTEGER,
  event_id INTEGER,
  event_kind INTEGER,
  visits INTEGER NOT NULL DEFAULT 0,
  is_boss INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (map_id, layout, cell_no)
);

-- Observed transitions (from cell -> to cell). from_cell: api_from_no, else the previous cell, else 0 (start).
-- difficulty -1 = unknown. Summed over difficulty these replace KCNav nodesummary run counts per edge.
CREATE TABLE poi_edge_counts (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  from_cell INTEGER NOT NULL,
  to_cell INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (map_id, layout, difficulty, from_cell, to_cell)
);

-- Encounters per identical comp (signature = formation | main ship ids | escort ship ids) per cell.
CREATE TABLE poi_comp_counts (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  cell_no INTEGER NOT NULL,
  difficulty INTEGER NOT NULL,
  signature TEXT NOT NULL,
  formation INTEGER,
  ships TEXT NOT NULL,                 -- JSON [{fleet, position, shipId, level, hp, fp, tp, aa, ar, equips}] (first encounter)
  count INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (map_id, layout, cell_no, difficulty, signature)
);

-- One row per sortie observation: route and fleet features for conditional routing analysis.
CREATE TABLE poi_sorties (
  observation_id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL,
  map_id INTEGER NOT NULL,
  difficulty INTEGER,
  layout TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  end_kind TEXT NOT NULL,              -- boss | end_node | retreat | unknown
  cells TEXT NOT NULL,                 -- JSON visited cell numbers in order
  battles INTEGER NOT NULL,
  features TEXT                        -- JSON fleet features from the upload (stypes, speed, los, …)
);
CREATE INDEX poi_sorties_map ON poi_sorties(map_id, layout);

-- Observed graph vs stored edges/nodes; recomputed per map on every aggregation (stored data is kept).
CREATE TABLE poi_graph_mismatches (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- unknown_edge | from_mismatch | boss_mismatch | event_mismatch
  from_cell INTEGER NOT NULL,          -- -1 when not applicable
  to_cell INTEGER NOT NULL,
  count INTEGER NOT NULL,
  observed TEXT NOT NULL,
  stored TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (map_id, layout, kind, from_cell, to_cell)
);

-- poi-observed comp sets live in the shared tables, one set per (map, node, difficulty, layout version).
ALTER TABLE enemy_comp_sets ADD COLUMN layout INTEGER;         -- poi-observed layout version (NULL for KCNav)
ALTER TABLE enemy_comp_sets ADD COLUMN cell_nos TEXT;          -- poi-observed: JSON raw cells merged into the node
ALTER TABLE enemy_comps ADD COLUMN signature TEXT;
ALTER TABLE enemy_comps ADD COLUMN first_seen TEXT;
ALTER TABLE enemy_comps ADD COLUMN last_seen TEXT;

INSERT INTO sources (key, name, url, licence, revision, fetched_at)
VALUES ('poi-observed', 'kc-sim poi plugin captures (aggregated observations)', NULL, 'project', NULL, '2026-10-22T00:00:00Z')
ON CONFLICT (key) DO NOTHING;
