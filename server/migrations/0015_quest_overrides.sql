-- Hand-authored quest overrides (shared/quest/overrides.json, docs/QUEST_OVERRIDES.md) merged by src/quests.ts.
-- Both columns are written by scripts/ingest-quests.ts; NULL for quests no override touches.
ALTER TABLE quests ADD COLUMN rewards TEXT;   -- JSON {resources?: [fuel, ammo, steel, bauxite], items?: [{name, amount?, choice?}]}
ALTER TABLE quests ADD COLUMN override TEXT;  -- JSON {source, fields, note?, author?, date?}: provenance of the override
