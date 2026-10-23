-- Remodel lineage of player ships (api_start2 api_aftershipid / api_sort_id) and the first form of
-- each line (EO BaseShip, shared/sim/fit.ts shipBaseId), for fit bonuses with shipS / shipNationality
-- on the server (estimator, upload ingest). Filled by ingest-start2.
ALTER TABLE ships ADD COLUMN after_ship_id INTEGER;
ALTER TABLE ships ADD COLUMN sort_id INTEGER;
ALTER TABLE ships ADD COLUMN base_id INTEGER;
CREATE INDEX ships_base ON ships(base_id);
