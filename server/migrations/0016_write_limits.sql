-- Write-path limits (ingest/upload.ts): a rolling 24 h quota of staged items and bytes per client, and counters of
-- the staged backlog for the global cap. Staging adds to the counters; every jobs ingest and purge recounts them.
ALTER TABLE clients ADD COLUMN quota_start INTEGER NOT NULL DEFAULT 0;  -- epoch ms the current quota window began
ALTER TABLE clients ADD COLUMN quota_items INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT 0;

INSERT INTO kv_state (key, value) VALUES
  ('staged_items', (SELECT COUNT(*) FROM upload_items)),
  ('staged_bytes', (SELECT COALESCE(SUM(bytes), 0) FROM upload_items));
