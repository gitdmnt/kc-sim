-- Drops the write limits of 0016 and the trust model of 0017. Rate limiting is the WRITE_LIMITER binding alone (no
-- D1), bans live on client rows only, and every client's data counts at once, without per-client caps or
-- distinct-reporter rules.

ALTER TABLE clients DROP COLUMN last_post_at;
ALTER TABLE clients DROP COLUMN quota_start;
ALTER TABLE clients DROP COLUMN quota_items;
ALTER TABLE clients DROP COLUMN quota_bytes;
ALTER TABLE clients DROP COLUMN trusted_at;
DELETE FROM kv_state WHERE key IN ('staged_items', 'staged_bytes');

-- Address bans become client bans (POST /admin/ips/:ipHash/ban bans the clients registered from the address).
UPDATE clients SET banned_at = COALESCE(banned_at, (SELECT b.banned_at FROM banned_ips b WHERE b.ip_hash = clients.ip_hash)),
  ban_reason = COALESCE(ban_reason, (SELECT b.reason FROM banned_ips b WHERE b.ip_hash = clients.ip_hash))
  WHERE ip_hash IN (SELECT ip_hash FROM banned_ips);
DROP TABLE banned_ips;

DROP TABLE poi_layout_reporters;
DROP TABLE poi_cell_reporters;
DROP TABLE poi_client_days;
ALTER TABLE poi_layouts DROP COLUMN current;
ALTER TABLE enemy_comp_sets DROP COLUMN reporters;

-- The estimator skipped battles beyond 100 per client, ship and day: reset the ships that hit the cap so they are
-- recounted (probation clients' battles were never counted and are still queued).
DELETE FROM estimator_accum WHERE ship_id IN (SELECT ship_id FROM estimator_client_days WHERE n >= 100);
DELETE FROM estimator_rolls WHERE ship_id IN (SELECT ship_id FROM estimator_client_days WHERE n >= 100);
DELETE FROM estimator_posteriors WHERE ship_id IN (SELECT ship_id FROM estimator_client_days WHERE n >= 100);
DELETE FROM estimates WHERE source_id = (SELECT id FROM sources WHERE key = 'estimator:server')
  AND ship_id IN (SELECT ship_id FROM estimator_client_days WHERE n >= 100);
UPDATE observation_ships SET est_at = NULL WHERE ship_id IN (SELECT ship_id FROM estimator_client_days WHERE n >= 100);
DROP TABLE estimator_client_days;

-- Clear the observed aggregates and refold every observation (as POST /admin/aggregate/rebuild): probation
-- clients' observations, 'client_cap' ones and the comp-set choice without reporters.
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
