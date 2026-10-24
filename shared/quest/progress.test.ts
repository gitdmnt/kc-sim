import { describe, expect, test } from "bun:test";
import { applyQuestEvent, currentCount, fleetMatches, questDay, questGoals } from "./progress";
import type { CountedShip, GoalCount, QuestEvent } from "./progress";
import type { QuestRequirement } from "./types";

const ship = (id: number, stype: number, lv = 99, ctype = 0): CountedShip => ({ id, stype, ctype, lv });
const YAMATO_K2 = ship(911, 8);
const CL = ship(21, 3);
const DD = ship(1, 2);
const DD2 = ship(9, 2);
const NOW = Date.UTC(2026, 9, 24, 3);

const battle = (map: string, opts: Partial<Extract<QuestEvent, { kind: "battle" }>> = {}): QuestEvent => ({
  kind: "battle", map, cell: 10, boss: true, rank: "S", gauge: 1, deck: 1, fleet: [YAMATO_K2, CL, DD, DD2], ...opts,
});

// 大和改二/重 flagship, CL ≥ 1, DD ≥ 2; 2-5 and 3-5 boss S ×2 each
const B: QuestRequirement = {
  category: "sortie", map: ["2-5", "3-5"], boss: true, result: "S", times: 2,
  groups: [{ ship: "大和改二", shipIds: [911, 916], flagship: true }, { stypes: [3] }, { stypes: [2], amount: 2 }],
};

const run = (req: QuestRequirement, events: QuestEvent[], now = NOW) => {
  const goals = questGoals(req);
  const counts: Record<string, GoalCount> = {};
  for (const e of events) applyQuestEvent(goals, counts, e, now);
  return goals.map((g) => [g.key, currentCount(g, counts[g.key], now), g.required]);
};

describe("questGoals", () => {
  test("one goal per map; times each", () => {
    expect(questGoals(B).map((g) => [g.key, g.required])).toEqual([["@2-5", 2], ["@3-5", 2]]);
    expect(questGoals({ ...B, total: true }).map((g) => g.key)).toEqual(["@2-5+3-5"]);
  });

  test("kcwiki-only shapes (name groups, map ranges, holding conditions) are not counted", () => {
    expect(questGoals({ category: "sortie", map: "2-1 ~ 2-5", boss: true, times: 5 })).toEqual([]);
    expect(questGoals({ category: "sortie", map: "2-5", boss: true, times: 1, groups: [{ ship: "妙高" }] })).toEqual([]);
    expect(questGoals({ category: "fleet", groups: [{ stypes: [2], amount: 4 }] })).toEqual([]);
    expect(questGoals({ category: "equipexchange", equipments: [{ name: "14cm単装砲", amount: 4, equipIds: [4] }] })).toEqual([]);
    expect(questGoals(null)).toEqual([]);
  });
});

describe("counting", () => {
  test("boss vs non-boss, rank threshold, multi-map", () => {
    expect(
      run(B, [
        battle("2-5"),
        battle("2-5", { boss: false }), // not the boss
        battle("2-5", { rank: "A" }), // below S
        battle("3-5"),
        battle("1-1"), // another map
        battle("2-5"),
        battle("2-5"), // capped at required
      ]),
    ).toEqual([["@2-5", 2, 2], ["@3-5", 1, 2]]);
  });

  test("fleet constraints: flagship, counts, max ships", () => {
    expect(run(B, [battle("2-5", { fleet: [CL, YAMATO_K2, DD, DD2] })])).toEqual([["@2-5", 0, 2], ["@3-5", 0, 2]]);
    expect(run(B, [battle("2-5", { fleet: [YAMATO_K2, CL, DD] })])).toEqual([["@2-5", 0, 2], ["@3-5", 0, 2]]);
    const small: QuestRequirement = { category: "sortie", map: "5-1", boss: true, result: "A", times: 1, maxShips: 5, groups: [{ shipIds: [65], flagship: true }] };
    const haguro = ship(65, 5);
    expect(run(small, [battle("5-1", { fleet: [haguro, DD, DD, DD, DD, DD] })])).toEqual([["@5-1", 0, 1]]);
    expect(run(small, [battle("5-1", { fleet: [haguro, DD, DD, DD, DD] })])).toEqual([["@5-1", 1, 1]]);
  });

  test("escort, place, onlyGroups, lv, [min,max]", () => {
    const shigure = ship(961, 2);
    const r: QuestRequirement = { category: "excercise", times: 1, result: "S", groups: [{ shipIds: [961], flagship: true }, { stypes: [2], amount: 3, escort: true }] };
    const ex = (fleet: CountedShip[]): QuestEvent => ({ kind: "exercise", rank: "S", deck: 1, fleet });
    expect(run(r, [ex([shigure, DD, DD2])])).toEqual([["@ex", 0, 1]]); // the flagship does not count as an escort
    expect(run(r, [ex([shigure, DD, DD2, DD])])).toEqual([["@ex", 1, 1]]);
    expect(fleetMatches({ category: "x", groups: [{ stypes: [2], place: 2 }] }, [CL, DD], 1)).toBe(true);
    expect(fleetMatches({ category: "x", groups: [{ stypes: [2], place: 2 }] }, [DD, CL], 1)).toBe(false);
    expect(fleetMatches({ category: "x", onlyGroups: true, groups: [{ stypes: [2, 3] }] }, [CL, DD], 1)).toBe(true);
    expect(fleetMatches({ category: "x", onlyGroups: true, groups: [{ stypes: [2] }] }, [CL, DD], 1)).toBe(false);
    expect(fleetMatches({ category: "x", groups: [{ stypes: [2], lv: [50, 999] }] }, [ship(1, 2, 49)], 1)).toBe(false);
    expect(fleetMatches({ category: "x", groups: [{ stypes: [3], amount: [1, 1] }] }, [CL, CL], 1)).toBe(false);
    expect(fleetMatches({ category: "x", fleetid: 1 }, [CL], 2)).toBe(false);
  });

  test("cells instead of the boss, gauge", () => {
    const r: QuestRequirement = { category: "sortie", map: "7-2", cells: [7], node: "G", gauge: 1, result: "S", times: 1 };
    expect(run(r, [battle("7-2", { cell: 15 }), battle("7-2", { cell: 7, boss: false, gauge: 2 })])).toEqual([["@7-2", 0, 1]]);
    expect(run(r, [battle("7-2", { cell: 7, boss: false })])).toEqual([["@7-2", 1, 1]]);
  });

  test("daily exercises reset at 05:00 JST", () => {
    const r: QuestRequirement = { category: "excercise", times: 4, victory: true, daily: true };
    const goals = questGoals(r);
    const counts: Record<string, GoalCount> = {};
    const ex: QuestEvent = { kind: "exercise", rank: "B", deck: 1, fleet: [DD] };
    const before = Date.UTC(2026, 9, 24, 19, 59); // 04:59 JST
    applyQuestEvent(goals, counts, ex, before);
    applyQuestEvent(goals, counts, { ...ex, rank: "C" }, before);
    expect(currentCount(goals[0]!, counts["@ex"], before)).toBe(1);
    const after = Date.UTC(2026, 9, 24, 20, 1); // 05:01 JST
    expect(questDay(after)).toBe(questDay(before) + 1);
    expect(currentCount(goals[0]!, counts["@ex"], after)).toBe(0);
    applyQuestEvent(goals, counts, ex, after);
    expect(currentCount(goals[0]!, counts["@ex"], after)).toBe(1);
  });

  test("expeditions by id, scraps by id and category, and / or", () => {
    const r: QuestRequirement = {
      category: "and",
      list: [
        { category: "expedition", objects: [{ id: 5, name: "海上護衛任務", times: 1 }, { id: [9, 10], times: 2 }] },
        { category: "equipexchange", scraps: [{ name: "12.7cm連装砲", amount: 2, equipIds: [2] }, { name: "小口径主砲", amount: 3, equipTypes: [1] }], equipments: [{ name: "x", amount: 1 }] },
        { category: "or", list: [{ category: "simple", subcategory: "equipment", times: 3 }, { category: "other", note: "x" }] },
      ],
    };
    const exp = (mission: number, success = true): QuestEvent => ({ kind: "expedition", mission, success, deck: 2, fleet: [DD] });
    expect(
      run(r, [
        exp(5), exp(9), exp(10, false), exp(10),
        { kind: "scrapEquip", equips: [{ id: 2, type: 1 }, { id: 3, type: 1 }, { id: 7, type: 2 }] },
        { kind: "develop", attempts: 3 },
      ]),
    ).toEqual([["0@m0", 1, 1], ["0@m1", 2, 2], ["1.s0", 1, 2], ["1.s1", 2, 3], ["2.0@equipment", 3, 3]]);
  });

  test("modernization and remodel targets", () => {
    const mod: QuestRequirement = {
      category: "modernization", times: 2, target: { stypes: [1] }, consumptions: [{ stypes: [2], amount: 5 }],
    };
    const kaibokan = ship(517, 1);
    const pu = (n: number, success = true): QuestEvent => ({ kind: "modernize", success, target: kaibokan, materials: Array(n).fill(DD) });
    expect(run(mod, [pu(5), pu(4), pu(5, false), { kind: "modernize", success: true, target: CL, materials: Array(5).fill(DD) }])).toEqual([["@powerup", 1, 2]]);
    const rem: QuestRequirement = { category: "remodel", times: 1, target: { shipIds: [916] } };
    expect(run(rem, [{ kind: "remodel", ship: YAMATO_K2 }, { kind: "remodel", ship: ship(916, 10) }])).toEqual([["@remodel", 1, 1]]);
  });
});
