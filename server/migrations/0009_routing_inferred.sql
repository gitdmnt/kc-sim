-- Routing inferred from poi sortie observations (docs/ROUTING_INFERENCE.md), written by the GitHub Actions routing
-- job (scripts/infer-routing.ts --write). Hand-authored rules (routing_maps / routing_rules) always win: the API
-- serves an inferred document only for maps without them.

-- One current inferred document per map: rules learned from the sorties of one layout (api_cell_data key).
CREATE TABLE routing_inferred (
  map_id INTEGER PRIMARY KEY,
  layout TEXT NOT NULL,                -- poi layout key of the training sorties ('' unknown)
  sorties INTEGER NOT NULL,            -- sorties used
  rule_count INTEGER NOT NULL,
  uncertain_count INTEGER NOT NULL,
  doc TEXT NOT NULL,                   -- JSON ROUTING_DSL document (validated against the map's edges when written)
  report TEXT NOT NULL,                -- JSON per-node report (samples, outcomes, leaves, uncertain leaves)
  source_id INTEGER REFERENCES sources(id), -- sources.key 'poi-inferred'
  generated_at TEXT NOT NULL
);

-- Observed sorties vs the hand-authored rules of a map (moves the rules cannot produce, branch shares that differ
-- for fleets the rules treat alike). Report only: nothing changes the rules.
CREATE TABLE routing_checks (
  map_id INTEGER PRIMARY KEY,
  layout TEXT NOT NULL,
  sorties INTEGER NOT NULL,
  findings INTEGER NOT NULL,           -- impossible moves + divergent branches
  report TEXT NOT NULL,                -- JSON {impossible: […], divergent: […]}
  generated_at TEXT NOT NULL
);

INSERT INTO sources (key, name, url, licence, revision, fetched_at)
VALUES ('poi-inferred', 'kc-sim routing rules inferred from poi sortie observations', NULL, 'project', NULL, '2026-10-24T00:00:00Z')
ON CONFLICT (key) DO NOTHING;
