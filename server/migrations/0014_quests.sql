-- Quest master data with prerequisite edges and structured requirements (private notes DATA_SOURCES §14), merged by
-- src/quests.ts from KC3Kai quests_meta.json, kc3-translations data/jp/quests.json and kcwiki-quest-data.
-- Replaced wholesale by scripts/ingest-quests.ts (daily, .github/workflows/jobs.yml).
CREATE TABLE quests (
  id INTEGER PRIMARY KEY,              -- api_no
  code TEXT,                           -- wiki code (A1, Bd1, 2610B3, ...)
  name TEXT,
  detail TEXT,
  memo TEXT,
  pre TEXT NOT NULL,                   -- JSON [{id, src: ["kc3" | "kcwiki"]}]
  requirements TEXT                    -- JSON kcwiki-quest-data requirements, NULL when absent
);
