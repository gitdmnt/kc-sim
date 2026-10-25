// Quest master data served at GET /api/v1/quests (private notes API "Quests", private notes DATA_SOURCES §14).
// Merged by the server's ingest (server/src/quests.ts) from KC3Kai quests_meta.json (prerequisite edges),
// kc3-translations data/jp/quests.json (code, name, description, memo), kcwiki-quest-data (structured requirements)
// and kcanotify-gamedata quests-jp.json (rewards), then the hand-authored overrides (./overrides.json,
// private notes QUEST_OVERRIDES) on top.

/** Which file asserts a prerequisite edge. */
export type QuestEdgeSource = "kc3" | "kcwiki" | "override";

export interface QuestPrerequisite {
  id: number;
  src: QuestEdgeSource[];
}

/**
 * One item of kcwiki-quest-data (`{name, amount?, category?}`). Overrides add master ids (`equipIds`: any of them) or
 * equipment categories (`equipTypes`: api_type[2], e.g. 1 小口径主砲) so scrapping can be counted and ownership checked.
 */
export interface QuestItemReq {
  name: string;
  amount?: number;
  category?: string;
  equipIds?: number[];
  equipTypes?: number[];
}

/**
 * A fleet / sortie composition group of kcwiki-quest-data. Names are Japanese master names or ship-type words.
 * A group holds when at least `amount` (or `select`) ships of the fleet match it; groups may share ships.
 * Overrides match by master data instead of names: `shipIds` (exact master ids, every accepted remodel listed),
 * `stypes` (api_stype), `ctypes` (api_ctype); a ship matches when it fits any of the given lists.
 */
export interface QuestGroupReq {
  ship?: string | string[];
  shipclass?: string | string[];
  /** At least n, or [min, max] */
  amount?: number | number[];
  /** Must be the flagship */
  flagship?: boolean;
  /** [min, max] level */
  lv?: number[];
  /** n of the listed ships */
  select?: number;
  /** Must be at fleet position n (1-based) */
  place?: number;
  note?: string;
  shipIds?: number[];
  stypes?: number[];
  ctypes?: number[];
  /** Only ships other than the flagship count (随伴 / 僚艦) */
  escort?: boolean;
}

/**
 * kcwiki-quest-data `requirements` (types/index.ts of kcwikizh/kcwiki-quest-data), and the superset the overrides use.
 * Only the fields the UI or the counter read are typed; anything else passes through. Override-only fields are marked;
 * the counter (./progress.ts) counts override requirements only.
 */
export interface QuestRequirement {
  category: string;
  list?: QuestRequirement[];
  groups?: QuestGroupReq[];
  times?: number;
  /** "W-M"; several maps: each needs `times` (kcwiki writes ranges such as "2-1 ~ 2-5" too) */
  map?: string | string[];
  /** Minimum rank ("S" / "A" / "B" / "C"), or "クリア" (reached the goal node) */
  result?: string;
  boss?: boolean;
  victory?: boolean;
  daily?: boolean;
  fleetid?: number;
  disallowed?: string;
  subcategory?: string;
  amount?: number;
  ship?: string;
  equipment?: string | string[];
  equipments?: QuestItemReq[];
  scraps?: QuestItemReq[];
  consumptions?: unknown[];
  resources?: number[];
  slots?: { slot: number; equipment: string; equipIds?: number[]; fullyskilled?: boolean; maxmodified?: boolean; level?: number; count?: number }[];
  secretary?: string | string[];
  objects?: { id?: number | string | (number | string)[]; name?: string; times: number }[];
  // ---- override-only ----
  /** sortie: `times` counts over all listed maps together instead of per map */
  total?: boolean;
  /** sortie: the battle must be at one of these cells (api_no) instead of / besides the boss */
  cells?: number[];
  /** sortie: display label of `cells` (wiki node letter) */
  node?: string;
  /** sortie: the map's gauge number (api_gauge_num) when the sortie started */
  gauge?: number;
  /** Fleet size bounds of the counted fleet */
  maxShips?: number;
  minShips?: number;
  /** Every ship of the fleet must match some group (kcwiki writes disallowed: "他の艦") */
  onlyGroups?: boolean;
  /** modernization / remodel: the ship being improved or remodelled (remodel: its new form) */
  target?: QuestGroupReq;
  /** modernization: master ids of `ship` (kcwiki's target name) */
  shipIds?: number[];
  /** modelconversion: master ids of `secretary` */
  secretaryIds?: number[];
  /** Short paraphrased note (our words, not the source's text) */
  note?: string;
  [key: string]: unknown;
}

/** Where a quest's rewards came from (first that has the quest wins): overrides, kcanotify-gamedata, kcwiki-quest-data, the KC3 memo "[獲]" line. */
export type QuestRewardSource = "override" | "kcanotify" | "kcwiki" | "kc3-memo";

/**
 * One reward item. Items sharing a `choice` number are one 選択報酬 group (pick one of them); a quest with
 * 二回選択報酬 has two groups (1 and 2). `amount` is omitted when 1.
 */
export interface QuestRewardItem {
  name: string;
  amount?: number;
  choice?: number;
}

/** Rewards of a quest: resources fuel/ammo/steel/bauxite (absent when the source does not say), then items. */
export interface QuestRewards {
  resources?: number[];
  items?: QuestRewardItem[];
  src?: QuestRewardSource;
}

/** Provenance of a hand-authored override (./overrides.json). */
export interface QuestOverrideInfo {
  /** Reference page the entry was authored from (e.g. a zekamashi.net article) */
  source: string;
  /** QuestEntry fields the override replaced */
  fields: string[];
  note?: string;
  /** Who wrote it (e.g. "llm") and when (YYYY-MM-DD) */
  author?: string;
  date?: string;
}

export interface QuestEntry {
  /** api_no */
  id: number;
  /** Wiki code (A1, Bd1, 2610B3, ...), null when unknown */
  code: string | null;
  name: string | null;
  detail: string | null;
  /** KC3 memo (reward notes such as "[獲]駆逐艦白雪") */
  memo: string | null;
  pre: QuestPrerequisite[];
  /** Structured clear conditions (override, else kcwiki-quest-data); null when neither has this quest */
  requirements: QuestRequirement | null;
  /** Rewards (override, else kcanotify-gamedata, else kcwiki-quest-data, else the KC3 memo); null when none says */
  rewards?: QuestRewards | null;
  /** Set when a hand-authored override changed this entry */
  override?: QuestOverrideInfo | null;
}

export interface QuestSourceInfo {
  key: string;
  revision: string | null;
  fetchedAt: string | null;
}

export interface QuestsResponse {
  sources: QuestSourceInfo[];
  quests: QuestEntry[];
}
