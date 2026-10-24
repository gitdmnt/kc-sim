// 「実施可能」 (web 任務 tab, ./filter.ts): a quest the player can work on right now. Its status says it is unlocked (or
// it is 不明 and inferred unlocked), and the current roster owns every ship and piece of equipment its own conditions
// name. Prerequisite-path needs do not count: the quest is already unlocked.
import type { QuestRequirement } from "./types";
import { aggregateRequirements } from "./tree";
import type { EquipNeedRow, OwnershipIndex, QuestGraph, QuestStatus, ShipNeedRow } from "./tree";

/**
 * open: 受注可 / 遂行中 / 達成 (the game lists it) / inferred: 不明, but poi has not seen the 全て list and every
 * prerequisite (at least one) is inferred 達成済 / locked: 未開放 / cleared: 達成済 / unknown: any other 不明 quest.
 */
export type DoableGate = "open" | "inferred" | "locked" | "cleared" | "unknown";

export interface Doability {
  gate: DoableGate;
  /** Gate open or inferred, and nothing the roster could be checked against is short */
  doable: boolean;
  /** Needs the roster falls short of: of the `or` alternative closest to satisfied; only checked past the gate */
  ships: ShipNeedRow[];
  equips: EquipNeedRow[];
  /** Conditions that could not be checked against the roster: a doable quest with any is 条件未確認 */
  unchecked: string[];
}

const OPEN: QuestStatus[] = ["available", "active", "done"];

/** The requirement as `or`-free alternatives (an and / then list of n alternatives each gives every combination). */
const alternatives = (r: QuestRequirement): QuestRequirement[] => {
  if (r.category === "or") {
    const alts = (r.list ?? []).flatMap(alternatives);
    return alts.length > 0 ? alts : [r];
  }
  if (r.category === "and" || r.category === "then") {
    let acc: QuestRequirement[][] = [[]];
    for (const sub of r.list ?? []) {
      const alts = alternatives(sub);
      acc = acc.flatMap((a) => alts.map((x) => [...a, x]));
    }
    return acc.map((list) => ({ ...r, list }));
  }
  return [r];
};

/** Notes of the free-text `other` leaves (the and / then / or nesting; other categories' `list` holds items). */
const freeText = (r: QuestRequirement): string[] =>
  r.category === "other"
    ? [r.note ?? "文章のみの条件"]
    : r.category === "and" || r.category === "then" || r.category === "or"
      ? (r.list ?? []).flatMap(freeText)
      : [];

/** Checks one `or`-free requirement of quest `id` against the roster. */
const check = (id: number, req: QuestRequirement, owned: OwnershipIndex) => {
  const { ships, equips } = aggregateRequirements([[id, req]], owned);
  const unresolved = [...ships, ...equips].filter((r) => r.ok === null).flatMap((r) => r.unresolved);
  return {
    ships: ships.filter((r) => r.ok === false),
    equips: equips.filter((r) => r.ok === false),
    unchecked: [...freeText(req), ...(unresolved.length > 0 ? [`マスターに無い名前: ${unresolved.join("、")}`] : [])],
  };
};

/**
 * Whether quest `id` is 実施可能. `listSeen`: poi has seen the game's 全て list, so a quest it lacks is not takeable
 * (cleared earlier, or not offered) and 不明 is never inferred unlocked.
 */
export const questDoability = (
  graph: QuestGraph,
  id: number,
  statuses: ReadonlyMap<number, QuestStatus>,
  listSeen: boolean,
  owned: OwnershipIndex,
): Doability => {
  const status = statuses.get(id) ?? "unknown";
  const pre = graph.byId.get(id)?.pre.map((p) => p.id) ?? [];
  const blocked = pre.some((p) => statuses.get(p) !== "cleared");
  const gate: DoableGate = OPEN.includes(status)
    ? "open"
    : status === "unknown"
      ? !listSeen && pre.length > 0 && !blocked ? "inferred" : "unknown"
      : status === "cleared" ? "cleared" : "locked";
  if (gate !== "open" && gate !== "inferred") {
    return { gate, doable: false, ships: [], equips: [], unchecked: [] };
  }
  const req = graph.byId.get(id)?.requirements ?? null;
  if (!req) return { gate, doable: true, ships: [], equips: [], unchecked: ["達成条件のデータなし"] };
  // The fully checked satisfied alternative, else a satisfied one with unchecked parts, else the fewest shortfalls
  const best = alternatives(req)
    .map((alt) => check(id, alt, owned))
    .reduce((a, b) => {
      const short = (x: typeof a) => x.ships.length + x.equips.length;
      return short(b) < short(a) || (short(b) === short(a) && b.unchecked.length < a.unchecked.length) ? b : a;
    });
  return { gate, doable: best.ships.length + best.equips.length === 0, ...best };
};
