// Quest master data served at GET /api/v1/quests (docs/API.md "Quests", docs/DATA_SOURCES.md §14).
// Merged by the server's ingest (server/src/quests.ts) from KC3Kai quests_meta.json (prerequisite edges),
// kc3-translations data/jp/quests.json (code, name, description) and kcwiki-quest-data (structured requirements).

/** Which upstream file asserts a prerequisite edge. */
export type QuestEdgeSource = "kc3" | "kcwiki";

export interface QuestPrerequisite {
  id: number;
  src: QuestEdgeSource[];
}

/** One item of kcwiki-quest-data (`{name, amount?, category?}`). */
export interface QuestItemReq {
  name: string;
  amount?: number;
  category?: string;
}

/** A fleet / sortie composition group of kcwiki-quest-data. Names are Japanese master names or ship-type words. */
export interface QuestGroupReq {
  ship?: string | string[];
  shipclass?: string | string[];
  amount?: number | number[];
  flagship?: boolean;
  lv?: number[];
  select?: number;
  place?: number;
  note?: string;
}

/**
 * kcwiki-quest-data `requirements`, kept as published (types/index.ts of kcwikizh/kcwiki-quest-data). Only the fields
 * the UI reads are typed; anything else passes through.
 */
export interface QuestRequirement {
  category: string;
  list?: QuestRequirement[];
  groups?: QuestGroupReq[];
  times?: number;
  map?: string | string[];
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
  slots?: { slot: number; equipment: string; fullyskilled?: boolean; maxmodified?: boolean; count?: number }[];
  secretary?: string | string[];
  objects?: { id?: number | string | (number | string)[]; times: number }[];
  [key: string]: unknown;
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
  /** Structured clear conditions (kcwiki-quest-data); null when that source has no entry for this quest */
  requirements: QuestRequirement | null;
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
