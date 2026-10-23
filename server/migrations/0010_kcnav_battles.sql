-- KCNav per-battle records (`GET /api/routing/maps/{m}/edges/{e,…}/battles`, job kind `battles`) for the battle
-- accuracy harness (sim-core/validation/battle-accuracy.ts, docs/VALIDATION.md §4). One row per KCNav battle id:
-- the entry as received (`raw`: player fleet with displayed stats, land bases, day and night game packets) and the
-- fields the harness filters and scores on, recomputed from the packets (src/kcnav/battles.ts normalizeBattle).
-- The page's cached body (kcnav_cache) is replaced by a stub listing the stored ids, so the raw JSON is kept once.
-- IF NOT EXISTS: the migration may be renumbered after it was applied to production.
CREATE TABLE IF NOT EXISTS kcnav_battles (
  id INTEGER PRIMARY KEY,               -- KCNav battle id (dedupes across pages and date windows)
  map_id INTEGER NOT NULL,
  node_letter TEXT NOT NULL,            -- the job's node: every requested edge leads there
  edge_id INTEGER NOT NULL,             -- KCNav `node`: the edge (cell number) the fleet arrived by
  difficulty INTEGER NOT NULL DEFAULT 0,
  battle_at TEXT NOT NULL,              -- KCNav `datetime` as given
  kind TEXT NOT NULL,                   -- sim-core BattleKind: day|dayNight|nightOnly|airBattle|airRaid, else 'unsupported'
  api_name TEXT NOT NULL,               -- first packet, e.g. api_req_sortie/battle
  yasen_api_name TEXT,                  -- night packet after a day battle, NULL without one
  fleet_type INTEGER NOT NULL,          -- 0 single, 1 carrier, 2 surface, 3 transport combined fleet
  enemy_combined INTEGER NOT NULL,
  formation INTEGER,                    -- api_formation [friend, enemy, engagement]
  enemy_formation INTEGER,
  engagement INTEGER,                   -- 1 same course, 2 head-on, 3 T advantage, 4 T disadvantage
  air_state INTEGER,                    -- api_kouku.api_stage1.api_disp_seiku
  detection INTEGER,                    -- api_search[0]
  support INTEGER NOT NULL,             -- a support expedition fired (day or night)
  friend_fleet INTEGER NOT NULL,        -- an event friend fleet took part
  lbas_waves INTEGER NOT NULL,
  rank TEXT NOT NULL,                   -- from HP by sim-core's rank rules (KCNav keeps no api_win_rank)
  verified INTEGER,                     -- day result equals the night packet's starting HP (NULL: no night battle)
  outcome TEXT NOT NULL,                -- JSON BattleOutcome: [max, before, after] per ship, HP removed per phase
  raw TEXT NOT NULL,                    -- JSON entry as received
  cache_id INTEGER REFERENCES kcnav_cache(id),
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kcnav_battles_node ON kcnav_battles (map_id, node_letter);
