// Facets of the 任務 list (web/src/app/quests/QuestTab.tsx): frequency and category from the wiki code, status from
// the player's quest state (./tree.ts questStatuses), 実施可能 (./doable.ts). An empty facet selection means "all".
import type { QuestEntry } from "./types";
import type { QuestStatus } from "./tree";
import type { Doability } from "./doable";

export const QUEST_FREQUENCIES = ["once", "daily", "weekly", "monthly", "quarterly", "yearly", "limited"] as const;
export type QuestFrequency = (typeof QUEST_FREQUENCIES)[number];
export const FREQUENCY_LABEL: Record<QuestFrequency, string> = {
  once: "単発", daily: "デイリー", weekly: "ウィークリー", monthly: "マンスリー", quarterly: "クォータリー", yearly: "イヤリー", limited: "期間限定",
};
const PERIOD: Record<string, QuestFrequency> = { d: "daily", w: "weekly", m: "monthly", q: "quarterly", y: "yearly" };

/**
 * From the wiki code: Bd1 / Bw1 / Bm1 / Bq1 / By1 periodic; limited = dated codes (2610B3, L2610F2, E47D1), 季節限定
 * (Cs2), seasonal S-codes (SB43, SF1, Su01 主計科) and OR2 (期間限定海域); everything else (A1, WA01, SN06) one-time.
 */
export const questFrequency = (code: string | null): QuestFrequency => {
  if (!code) return "once";
  const m = /^[A-G]([dwmqy])\d/.exec(code);
  if (m) return PERIOD[m[1]!]!;
  return /^(?:\d|L\d|E\d+[A-G]|S[BFu]|OR|[A-G]s\d)/.test(code) ? "limited" : "once";
};

/** The game's quest categories (api_category 1–7, by the wiki code's letter), plus codes without one. */
export const QUEST_CATEGORIES = ["A", "B", "C", "D", "E", "F", "G", "other"] as const;
export type QuestCategory = (typeof QUEST_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<QuestCategory, string> = {
  A: "編成", B: "出撃", C: "演習", D: "遠征", E: "補給・入渠", F: "工廠", G: "改装", other: "その他",
};

/** The letter just before the number: A1, Bd1, Cs8, 2602B1, L2610F2, E47D1, 7AC1 (C), WA01, SB43; SN06 / Su01 / OR2: other. */
export const questCategory = (code: string | null): QuestCategory =>
  (/([A-G])[dwmqys]?\d+$/.exec(code ?? "")?.[1] as QuestCategory | undefined) ?? "other";

export const STATUS_GROUPS = ["locked", "available", "active", "cleared", "unknown"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];
export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  locked: "未開放", available: "未達成", active: "遂行中", cleared: "達成済", unknown: "不明",
};
/** 未開放: still locked; 未達成: unlocked; 遂行中: in progress, or achieved with the reward not taken yet; 達成済: inferred cleared. */
const GROUP_OF: Record<QuestStatus, StatusGroup> = {
  locked: "locked", available: "available", active: "active", done: "active", cleared: "cleared", unknown: "unknown",
};
export const statusGroup = (s: QuestStatus): StatusGroup => GROUP_OF[s];

export interface QuestFilter {
  freq: QuestFrequency[];
  cat: QuestCategory[];
  status: StatusGroup[];
  /** 実施可能 (./doable.ts) */
  doable: boolean;
}
export const EMPTY_QUEST_FILTER: QuestFilter = { freq: [], cat: [], status: [], doable: false };

/**
 * A stored filter (localStorage JSON); unknown values are dropped, anything malformed is the empty filter. The former
 * 未達成 ("open", unlocked or locked) becomes 未開放 + 未達成; filters saved before 実施可能 load with it off.
 */
export const parseQuestFilter = (v: unknown): QuestFilter => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const pick = <T extends string>(x: unknown, allowed: readonly T[]): T[] =>
    Array.isArray(x) ? allowed.filter((a) => x.includes(a)) : [];
  const status = Array.isArray(o.status) && o.status.includes("open") ? [...o.status, "locked", "available"] : o.status;
  return {
    freq: pick(o.freq, QUEST_FREQUENCIES), cat: pick(o.cat, QUEST_CATEGORIES), status: pick(status, STATUS_GROUPS), doable: o.doable === true,
  };
};

export interface QuestFacetCounts {
  freq: Record<QuestFrequency, number>;
  cat: Record<QuestCategory, number>;
  status: Record<StatusGroup, number>;
  /** 実施可能 among the quests passing the other facets */
  doable: number;
  /** Of the quests passing the other facets, the 不明 ones 実施可能 leaves out (DoableGate "unknown") */
  doableUnknown: number;
}

export interface QuestFilterContext {
  /** Each quest's status; absent without poi's quest state (the status facet is then ignored) */
  statusOf?: (id: number) => QuestStatus;
  /** Each quest's 実施可能; absent without poi's quest state and roster (the 実施可能 filter is then ignored) */
  doableOf?: (id: number) => Doability;
  /** The text search */
  match?: (q: QuestEntry) => boolean;
}

/**
 * Quests passing `match` (the text search) and every facet, and per facet value how many would pass with that value
 * selected instead of the facet's current selection (the usual faceted counts).
 */
export const filterQuests = (
  quests: readonly QuestEntry[],
  filter: QuestFilter,
  { statusOf, doableOf, match }: QuestFilterContext = {},
): { list: QuestEntry[]; counts: QuestFacetCounts } => {
  const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const counts: QuestFacetCounts = {
    freq: zero(QUEST_FREQUENCIES), cat: zero(QUEST_CATEGORIES), status: zero(STATUS_GROUPS), doable: 0, doableUnknown: 0,
  };
  const status = statusOf ? filter.status : [];
  const list: QuestEntry[] = [];
  for (const q of quests) {
    if (match && !match(q)) continue;
    const f = questFrequency(q.code);
    const c = questCategory(q.code);
    const s = statusGroup(statusOf?.(q.id) ?? "unknown");
    const d = doableOf?.(q.id);
    const okF = filter.freq.length === 0 || filter.freq.includes(f);
    const okC = filter.cat.length === 0 || filter.cat.includes(c);
    const okS = status.length === 0 || status.includes(s);
    const okD = !filter.doable || !d || d.doable;
    if (okC && okS && okD) counts.freq[f]++;
    if (okF && okS && okD) counts.cat[c]++;
    if (okF && okC && okD) counts.status[s]++;
    if (okF && okC && okS && d?.doable) counts.doable++;
    if (okF && okC && okS && d?.gate === "unknown") counts.doableUnknown++;
    if (okF && okC && okS && okD) list.push(q);
  }
  return { list, counts };
};
