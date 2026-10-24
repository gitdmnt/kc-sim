// Facets of the 任務 list (web/src/app/quests/QuestTab.tsx): frequency and category from the wiki code, status from
// the player's quest state (./tree.ts questStatuses). An empty facet selection means "all".
import type { QuestEntry } from "./types";
import type { QuestStatus } from "./tree";

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
}
export const EMPTY_QUEST_FILTER: QuestFilter = { freq: [], cat: [], status: [] };

/**
 * A stored filter (localStorage JSON); unknown values are dropped, anything malformed is the empty filter. The former
 * 未達成 ("open", unlocked or locked) becomes 未開放 + 未達成.
 */
export const parseQuestFilter = (v: unknown): QuestFilter => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const pick = <T extends string>(x: unknown, allowed: readonly T[]): T[] =>
    Array.isArray(x) ? allowed.filter((a) => x.includes(a)) : [];
  const status = Array.isArray(o.status) && o.status.includes("open") ? [...o.status, "locked", "available"] : o.status;
  return { freq: pick(o.freq, QUEST_FREQUENCIES), cat: pick(o.cat, QUEST_CATEGORIES), status: pick(status, STATUS_GROUPS) };
};

export interface QuestFacetCounts {
  freq: Record<QuestFrequency, number>;
  cat: Record<QuestCategory, number>;
  status: Record<StatusGroup, number>;
}

/**
 * Quests passing `match` (the text search) and every facet, and per facet value how many would pass with that value
 * selected instead of the facet's current selection (the usual faceted counts). `statusOf` gives each quest's status;
 * pass `useStatus: false` to ignore the status facet (no player data).
 */
export const filterQuests = (
  quests: readonly QuestEntry[],
  filter: QuestFilter,
  statusOf: (id: number) => QuestStatus,
  match: (q: QuestEntry) => boolean = () => true,
  useStatus = true,
): { list: QuestEntry[]; counts: QuestFacetCounts } => {
  const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const counts: QuestFacetCounts = { freq: zero(QUEST_FREQUENCIES), cat: zero(QUEST_CATEGORIES), status: zero(STATUS_GROUPS) };
  const status = useStatus ? filter.status : [];
  const list: QuestEntry[] = [];
  for (const q of quests) {
    if (!match(q)) continue;
    const f = questFrequency(q.code);
    const c = questCategory(q.code);
    const s = statusGroup(statusOf(q.id));
    const okF = filter.freq.length === 0 || filter.freq.includes(f);
    const okC = filter.cat.length === 0 || filter.cat.includes(c);
    const okS = status.length === 0 || status.includes(s);
    if (okC && okS) counts.freq[f]++;
    if (okF && okS) counts.cat[c]++;
    if (okF && okC) counts.status[s]++;
    if (okF && okC && okS) list.push(q);
  }
  return { list, counts };
};
