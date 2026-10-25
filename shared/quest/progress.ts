// Progress counting for quests whose (override) conditions are mechanical: which sub-goals a requirement has, and how
// much one game event advances each. Pure; the poi plugin turns API responses into QuestEvents and stores the counts
// (poi-plugin-sim/src/quests/counter.ts). Schema and semantics: private notes QUEST_OVERRIDES.
import type { QuestGroupReq, QuestItemReq, QuestRequirement } from "./types";

/** One ship as the counter sees it (master data resolved by the caller). */
export interface CountedShip {
  /** master id */
  id: number;
  stype: number;
  ctype: number;
  lv: number;
}

/** One equipment instance as the counter sees it. */
export interface CountedEquip {
  /** master id */
  id: number;
  /** api_type[2] (category) */
  type: number;
}

export type QuestEvent =
  | { kind: "battle"; map: string; cell: number; boss: boolean; rank: string; gauge: number | null; deck: number; fleet: CountedShip[] }
  | { kind: "exercise"; rank: string; deck: number; fleet: CountedShip[] }
  | { kind: "expedition"; mission: number; success: boolean; deck: number; fleet: CountedShip[] }
  | { kind: "develop"; attempts: number }
  | { kind: "build" }
  | { kind: "scrapEquip"; equips: CountedEquip[] }
  | { kind: "scrapShip"; ships: CountedShip[] }
  | { kind: "modernize"; success: boolean; target: CountedShip | null; materials: CountedShip[] }
  | { kind: "improve"; success: boolean }
  | { kind: "remodel"; ship: CountedShip | null }
  | { kind: "resupply" }
  | { kind: "repair" };

/** One countable sub-goal of a quest. */
export interface QuestGoal {
  /** Stable within one requirement: path of the leaf (and map / item) */
  key: string;
  description: string;
  required: number;
  /** Progress resets at 05:00 JST (「本日中に」) */
  daily: boolean;
  /** How much `event` advances this goal (0: not at all) */
  advance: (event: QuestEvent) => number;
}

const RANKS = ["E", "D", "C", "B", "A", "S"];
const rankAtLeast = (rank: string, min: string | undefined): boolean =>
  min === undefined || RANKS.indexOf(rank) >= RANKS.indexOf(min);

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** A group names master data (overrides always do; kcwiki's name-only groups are not counted). */
const precise = (g: QuestGroupReq): boolean => !!(g.shipIds || g.stypes || g.ctypes);

const shipMatches = (g: QuestGroupReq, s: CountedShip): boolean =>
  (!!g.shipIds?.includes(s.id) || !!g.stypes?.includes(s.stype) || !!g.ctypes?.includes(s.ctype)) &&
  (!g.lv || (s.lv >= (g.lv[0] ?? 0) && s.lv <= (g.lv[1] ?? Infinity)));

const bounds = (g: QuestGroupReq): [number, number] => {
  if (Array.isArray(g.amount)) return [g.amount[0] ?? 1, g.amount[1] ?? Infinity];
  return [g.select ?? g.amount ?? 1, Infinity];
};

/** Whether `fleet` (in fleet order) satisfies the composition constraints of a leaf. */
export const fleetMatches = (r: QuestRequirement, fleet: CountedShip[], deck: number): boolean => {
  if (r.fleetid !== undefined && r.fleetid !== deck) return false;
  if (r.maxShips !== undefined && fleet.length > r.maxShips) return false;
  if (r.minShips !== undefined && fleet.length < r.minShips) return false;
  const groups = r.groups ?? [];
  for (const g of groups) {
    const n = fleet.filter((s, i) =>
      (!g.flagship || i === 0) && (g.place === undefined || i === g.place - 1) && (!g.escort || i > 0) && shipMatches(g, s),
    ).length;
    const [min, max] = bounds(g);
    if (n < min || n > max) return false;
  }
  return !r.onlyGroups || fleet.every((s) => groups.some((g) => shipMatches(g, s)));
};

/** A requirement can be checked against a fleet: no groups, or only groups naming master data. */
const fleetCheckable = (r: QuestRequirement): boolean => (r.groups ?? []).every(precise) && r.disallowed === undefined;

const fleetText = (r: QuestRequirement): string => {
  const parts = (r.groups ?? []).map((g) => {
    const names = [...list(g.ship), ...list(g.shipclass)].join("/") || "指定艦";
    const [min, max] = bounds(g);
    const n = max < Infinity ? `${min}-${max}` : min > 1 ? `×${min}` : "";
    return `${g.flagship ? "旗艦" : g.escort ? "僚艦" : g.place ? `${g.place}番艦` : ""}${names}${n}`;
  });
  if (r.maxShips) parts.push(`${r.maxShips}隻以下`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
};

const resultText = (min: string | undefined) => (min ? ` ${min}勝利以上` : " 到達");

const itemMatches = (i: QuestItemReq, e: CountedEquip) => !!i.equipIds?.includes(e.id) || !!i.equipTypes?.includes(e.type);

/** Scrap goals for items that name master data (equipIds / equipTypes); others are prepared, not counted. */
const scrapGoals = (items: QuestItemReq[] | undefined, key: string): QuestGoal[] =>
  (items ?? []).flatMap((i, n) =>
    i.equipIds || i.equipTypes
      ? [{
          key: `${key}.s${n}`,
          description: `廃棄 ${i.name}`,
          required: i.amount ?? 1,
          daily: false,
          advance: (e: QuestEvent) => (e.kind === "scrapEquip" ? e.equips.filter((x) => itemMatches(i, x)).length : 0),
        }]
      : [],
  );

const SIMPLE: Record<string, { label: string; advance: (e: QuestEvent) => number }> = {
  equipment: { label: "装備開発", advance: (e) => (e.kind === "develop" ? e.attempts : 0) },
  ship: { label: "建造", advance: (e) => (e.kind === "build" ? 1 : 0) },
  scrapequipment: { label: "装備廃棄", advance: (e) => (e.kind === "scrapEquip" && e.equips.length > 0 ? 1 : 0) },
  scrapship: { label: "解体", advance: (e) => (e.kind === "scrapShip" ? e.ships.length : 0) },
  modernization: { label: "近代化改修", advance: (e) => (e.kind === "modernize" && e.success ? 1 : 0) },
  improvement: { label: "装備改修", advance: (e) => (e.kind === "improve" && e.success ? 1 : 0) },
  resupply: { label: "補給", advance: (e) => (e.kind === "resupply" ? 1 : 0) },
  repair: { label: "入渠", advance: (e) => (e.kind === "repair" ? 1 : 0) },
  battle: { label: "出撃戦闘", advance: (e) => (e.kind === "battle" ? 1 : 0) },
  remodel: { label: "改装", advance: (e) => (e.kind === "remodel" ? 1 : 0) },
};

/**
 * The countable sub-goals of a requirement, in display order. Leaves that cannot be counted (fleet / sink / other /
 * prepared equipment, name-only fleet groups, kcwiki map ranges) yield none; `or` branches are all listed.
 */
export const questGoals = (req: QuestRequirement | null): QuestGoal[] => {
  const out: QuestGoal[] = [];
  const walk = (r: QuestRequirement, key: string) => {
    switch (r.category) {
      case "and":
      case "then":
      case "or":
        (r.list ?? []).forEach((sub, i) => walk(sub, key ? `${key}.${i}` : String(i)));
        return;
      case "sortie": {
        const maps = list(r.map);
        if (maps.length === 0 || !maps.every((m) => /^\d+-\d+$/.test(m)) || (!r.boss && !r.cells) || !fleetCheckable(r)) return;
        const where = r.cells ? ` ${r.node ?? "指定"}マス` : " ボス";
        const at = (e: QuestEvent, maps: string[]) =>
          e.kind === "battle" && maps.includes(e.map) && (r.cells ? r.cells.includes(e.cell) : e.boss) &&
          (r.gauge === undefined || e.gauge === r.gauge) && rankAtLeast(e.rank, r.result) && fleetMatches(r, e.fleet, e.deck)
            ? 1
            : 0;
        const groups = r.total ? [maps] : maps.map((m) => [m]);
        for (const g of groups) {
          out.push({
            key: `${key}@${g.join("+")}`,
            description: `${g.join("/")}${where}${resultText(r.result)}${fleetText(r)}`,
            required: r.times ?? 1,
            daily: false,
            advance: (e) => at(e, g),
          });
        }
        return;
      }
      case "excercise": {
        if (!fleetCheckable(r)) return;
        const min = r.result ?? (r.victory ? "B" : undefined);
        out.push({
          key: `${key}@ex`,
          description: `演習${min ? ` ${min}勝利以上` : ""}${fleetText(r)}`,
          required: r.times ?? 1,
          daily: !!r.daily,
          advance: (e) => (e.kind === "exercise" && rankAtLeast(e.rank, min) && fleetMatches(r, e.fleet, e.deck) ? 1 : 0),
        });
        return;
      }
      case "expedition": {
        if (!fleetCheckable(r)) return;
        (r.objects ?? []).forEach((o, i) => {
          const ids = list(o.id);
          if (!ids.every((x) => typeof x === "number")) return;
          out.push({
            key: `${key}@m${i}`,
            description: `遠征 ${o.name ?? (ids.join("/") || "任意")} 成功${fleetText(r)}`,
            required: o.times,
            daily: false,
            advance: (e) =>
              e.kind === "expedition" && e.success && (ids.length === 0 || ids.includes(e.mission)) && fleetMatches(r, e.fleet, e.deck) ? 1 : 0,
          });
        });
        return;
      }
      case "simple": {
        const s = SIMPLE[r.subcategory ?? ""];
        if (s) out.push({ key: `${key}@${r.subcategory}`, description: s.label, required: r.times ?? 1, daily: false, advance: s.advance });
        return;
      }
      case "remodel": {
        const t = r.target;
        if (!t || !precise(t)) return;
        out.push({
          key: `${key}@remodel`,
          description: `改装 ${list(t.ship).join("/") || "指定艦"}`,
          required: r.times ?? 1,
          daily: false,
          advance: (e) => (e.kind === "remodel" && e.ship && shipMatches(t, e.ship) ? 1 : 0),
        });
        return;
      }
      case "modernization": {
        const t = r.target;
        const mats = (Array.isArray(r.consumptions) ? r.consumptions : []) as (QuestGroupReq & { amount: number })[];
        if ((t && !precise(t)) || !mats.every(precise)) return;
        out.push({
          key: `${key}@powerup`,
          description: `近代化改修 ${r.ship ?? (t ? list(t.ship).join("/") : "")}`.trim(),
          required: r.times ?? 1,
          daily: false,
          advance: (e) =>
            e.kind === "modernize" && e.success && (!t || (e.target !== null && shipMatches(t, e.target))) &&
            mats.every((m) => e.materials.filter((s) => shipMatches(m, s)).length >= m.amount)
              ? 1
              : 0,
        });
        return;
      }
      case "scrapequipment":
        out.push(...scrapGoals(r.list as QuestItemReq[] | undefined, key));
        return;
      case "equipexchange":
      case "modelconversion":
        out.push(...scrapGoals(r.scraps, key));
        return;
    }
  };
  if (req) walk(req, "");
  return out;
};

/** The game's quest day: daily progress resets at 05:00 JST (20:00 UTC). */
export const questDay = (ms: number): number => Math.floor((ms + (9 - 5) * 3_600_000) / 86_400_000);

/** Stored count of one goal; `day` is set for daily goals (the questDay of the last increment). */
export interface GoalCount {
  count: number;
  day?: number;
}

/** A goal's current count: daily goals counted on an earlier quest day are back at 0. */
export const currentCount = (goal: Pick<QuestGoal, "daily">, stored: GoalCount | undefined, now: number): number =>
  !stored ? 0 : goal.daily && stored.day !== questDay(now) ? 0 : stored.count;

/**
 * Advances `counts` (goal key -> count) of one quest by `event`. Counts stop at `required`. Returns whether anything
 * changed.
 */
export const applyQuestEvent = (goals: readonly QuestGoal[], counts: Record<string, GoalCount>, event: QuestEvent, now: number): boolean => {
  let changed = false;
  for (const g of goals) {
    const n = g.advance(event);
    if (n <= 0) continue;
    const cur = currentCount(g, counts[g.key], now);
    if (cur >= g.required) continue;
    counts[g.key] = { count: Math.min(g.required, cur + n), ...(g.daily ? { day: questDay(now) } : {}) };
    changed = true;
  }
  return changed;
};
