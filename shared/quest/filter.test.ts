import { expect, test } from "bun:test";
import type { QuestEntry } from "./types";
import type { QuestStatus } from "./tree";
import type { Doability, DoableGate } from "./doable";
import { EMPTY_QUEST_FILTER, filterQuests, parseQuestFilter, questCategory, questFrequency, statusGroup } from "./filter";

test("frequency from the wiki code", () => {
  const cases: [string | null, string][] = [
    ["A1", "once"], ["B12", "once"], ["WA01", "once"], ["SN06", "once"], [null, "once"],
    ["Bd1", "daily"], ["Fw3", "weekly"], ["Bm8", "monthly"], ["Bq13", "quarterly"], ["By3", "yearly"], ["Cy4", "yearly"],
    ["2610B3", "limited"], ["L2610F2", "limited"], ["E47D1", "limited"], ["Cs8", "limited"], ["SB43", "limited"],
    ["SF1", "limited"], ["Su01", "limited"], ["OR2", "limited"], ["7AC1", "limited"],
  ];
  for (const [code, f] of cases) expect([code, questFrequency(code)]).toEqual([code, f]);
});

test("category from the letter before the number", () => {
  const cases: [string | null, string][] = [
    ["A1", "A"], ["Bd1", "B"], ["Cs8", "C"], ["D14", "D"], ["E1", "E"], ["Ed2", "E"], ["Fy10", "F"], ["G5", "G"],
    ["2602B1", "B"], ["L2610F2", "F"], ["E47D1", "D"], ["E51B4", "B"], ["7AC1", "C"], ["WA01", "A"], ["SB43", "B"], ["SF1", "F"],
    ["SN06", "other"], ["Su01", "other"], ["OR2", "other"], [null, "other"],
  ];
  for (const [code, c] of cases) expect([code, questCategory(code)]).toEqual([code, c]);
});

test("status groups", () => {
  expect((["available", "locked", "active", "done", "cleared", "unknown"] as QuestStatus[]).map(statusGroup))
    .toEqual(["available", "locked", "active", "active", "cleared", "unknown"]);
});

const q = (id: number, code: string, name = `q${id}`): QuestEntry => ({ id, code, name, detail: null, memo: null, pre: [], requirements: null });
const QUESTS = [q(1, "A1"), q(2, "Bd1"), q(3, "Bw2"), q(4, "B12"), q(5, "2610B3"), q(6, "F5"), q(7, "Fd1")];
const STATUS: Record<number, QuestStatus> = { 1: "cleared", 2: "active", 3: "available", 4: "locked", 6: "done" };
const statusOf = (id: number) => STATUS[id] ?? "unknown";

test("facets combine with each other and the text match; counts are per facet", () => {
  const all = filterQuests(QUESTS, EMPTY_QUEST_FILTER, { statusOf });
  expect(all.list.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(all.counts.cat).toMatchObject({ A: 1, B: 4, F: 2, C: 0, other: 0 });
  expect(all.counts.freq).toMatchObject({ once: 3, daily: 2, weekly: 1, limited: 1 });
  expect(all.counts.status).toEqual({ locked: 1, available: 1, active: 2, cleared: 1, unknown: 2 });

  // 出撃 + (デイリー or ウィークリー): counts of a facet ignore that facet's own selection
  const r = filterQuests(QUESTS, { ...EMPTY_QUEST_FILTER, freq: ["daily", "weekly"], cat: ["B"] }, { statusOf });
  expect(r.list.map((x) => x.id)).toEqual([2, 3]);
  expect(r.counts.cat).toMatchObject({ A: 0, B: 2, F: 1 });
  expect(r.counts.freq).toMatchObject({ once: 1, daily: 1, weekly: 1, limited: 1 });
  expect(r.counts.status).toEqual({ locked: 0, available: 1, active: 1, cleared: 0, unknown: 0 });

  const available = filterQuests(QUESTS, { ...EMPTY_QUEST_FILTER, cat: ["B"], status: ["available"] }, { statusOf });
  expect(available.list.map((x) => x.id)).toEqual([3]);
  const locked = filterQuests(QUESTS, { ...EMPTY_QUEST_FILTER, cat: ["B"], status: ["locked"] }, { statusOf });
  expect(locked.list.map((x) => x.id)).toEqual([4]);
  expect(locked.counts.status).toEqual({ locked: 1, available: 1, active: 1, cleared: 0, unknown: 1 });
  // without player data the status facet is ignored
  expect(filterQuests(QUESTS, { ...EMPTY_QUEST_FILTER, cat: ["B"], status: ["available"] }).list.map((x) => x.id)).toEqual([2, 3, 4, 5]);

  const text = filterQuests(QUESTS, { ...EMPTY_QUEST_FILTER, cat: ["B", "F"] }, { statusOf, match: (x) => x.code!.includes("d") });
  expect(text.list.map((x) => x.id)).toEqual([2, 7]);
  expect(text.counts.cat).toMatchObject({ B: 1, F: 1, A: 0 });
});

test("実施可能 combines with the other facets; counts the 不明 quests it leaves out", () => {
  const d = (doable: boolean, gate: DoableGate = doable ? "open" : "locked"): Doability =>
    ({ gate, doable, ships: [], equips: [], unchecked: [] });
  const DOABLE: Record<number, Doability> = { 2: d(true), 3: d(true), 5: d(false, "unknown"), 7: d(true, "inferred") };
  const doableOf = (id: number) => DOABLE[id] ?? d(false);
  const on = { ...EMPTY_QUEST_FILTER, doable: true };
  const all = filterQuests(QUESTS, on, { statusOf, doableOf });
  expect(all.list.map((x) => x.id)).toEqual([2, 3, 7]);
  expect(all.counts).toMatchObject({ doable: 3, doableUnknown: 1 });
  expect(all.counts.cat).toMatchObject({ B: 2, F: 1 });
  // the chip's count follows the other facets, with or without the chip on
  const daily = filterQuests(QUESTS, { ...EMPTY_QUEST_FILTER, freq: ["daily"] }, { statusOf, doableOf });
  expect(daily.list.map((x) => x.id)).toEqual([2, 7]);
  expect(daily.counts).toMatchObject({ doable: 2, doableUnknown: 0 });
  expect(filterQuests(QUESTS, { ...on, cat: ["B"] }, { statusOf, doableOf, match: (x) => x.id !== 2 }).list.map((x) => x.id)).toEqual([3]);
  // without poi's quest state and roster the chip is ignored
  expect(filterQuests(QUESTS, on, { statusOf }).list).toHaveLength(7);
});

test("stored filters are validated", () => {
  expect(parseQuestFilter({ freq: ["daily", "bogus"], cat: ["F", "B"], status: "available" })).toEqual({ freq: ["daily"], cat: ["B", "F"], status: [], doable: false });
  expect(parseQuestFilter({ freq: [], cat: [], status: ["unknown", "available", "locked"] }).status).toEqual(["locked", "available", "unknown"]);
  // the former 未達成 covered locked and unlocked quests
  expect(parseQuestFilter({ freq: [], cat: [], status: ["open", "active"] }).status).toEqual(["locked", "available", "active"]);
  expect(parseQuestFilter({ freq: [], cat: [], status: [], doable: true }).doable).toBe(true);
  expect(parseQuestFilter({ freq: [], cat: [], status: [], doable: "yes" }).doable).toBe(false);
  expect(parseQuestFilter(null)).toEqual(EMPTY_QUEST_FILTER);
  expect(parseQuestFilter("x")).toEqual(EMPTY_QUEST_FILTER);
});
