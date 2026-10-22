-- KCNav nodesummary snapshots (per-edge run counts) for routing validation (docs/API.md §4, ROUTING_DSL.md §7).
CREATE TABLE kcnav_edge_counts (
  map_id INTEGER NOT NULL,
  query TEXT NOT NULL,                 -- query string of the nodesummary request (filters + window), '' if none
  edge_id INTEGER NOT NULL,
  runs INTEGER NOT NULL,
  retrieved_at TEXT NOT NULL,
  cache_id INTEGER REFERENCES kcnav_cache(id),
  PRIMARY KEY (map_id, query, edge_id)
);
