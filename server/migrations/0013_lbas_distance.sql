-- LBAS distance per cell: api_cell_data[].api_distance of the poi captures (docs/DATA_SOURCES.md §13).
ALTER TABLE poi_cells ADD COLUMN lbas_distance INTEGER;

-- Backfill from the newest api_cell_data kept per layout.
UPDATE poi_cells SET lbas_distance = (
  SELECT json_extract(j.value, '$.distance') FROM poi_layouts l, json_each(l.cells) j
  WHERE l.map_id = poi_cells.map_id AND l.layout = poi_cells.layout AND l.cells IS NOT NULL
    AND json_extract(j.value, '$.no') = poi_cells.cell_no
);

-- 夜昼戦 (api_event_kind 7, KC3Kai Node.js) was stored as a plain battle before src/maps.ts knew it.
UPDATE nodes SET node_type = 'night_to_day' WHERE event_id = 4 AND event_kind = 7;
