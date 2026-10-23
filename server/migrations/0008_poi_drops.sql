-- Ship drops per (map, layout, difficulty, cell, rank), aggregated from the battle results of poi sortie
-- observations (observed/aggregate.ts). Keys are the raw cell numbers like the other poi_* aggregates.
-- ship_id 0 = a battle result with no ship drop, so drop rate = count(ship) / Σ count over the key's ships.
CREATE TABLE poi_drop_counts (
  map_id INTEGER NOT NULL,
  layout TEXT NOT NULL,
  difficulty INTEGER NOT NULL,         -- 0 normal maps, event rank 1-4 (cells of an unknown event rank are not counted)
  cell_no INTEGER NOT NULL,
  rank TEXT NOT NULL,                  -- api_win_rank: S | A | B | C | D | E
  ship_id INTEGER NOT NULL,            -- api_get_ship api_ship_id; 0 = no drop
  count INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (map_id, layout, difficulty, cell_no, rank, ship_id)
);
