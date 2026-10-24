import { describe, expect, test } from "bun:test";
import type { PoiQuests } from "../embed/protocol";
import type { QuestEntry, QuestRequirement } from "./types";
import {
  OwnershipIndex, aggregateNeeds, buildQuestGraph, descendants, describeRequirement, questKind, questNeeds, questStatuses,
  resolvePrerequisites, rosterFromPoi,
} from "./tree";

const q = (id: number, pre: number[], requirements: QuestRequirement | null = null, code: string | null = null): QuestEntry => ({
  id, code, name: `q${id}`, detail: null, memo: null, pre: pre.map((p) => ({ id: p, src: ["kc3"] })), requirements,
});

// 101 → 102 → 104, 101 → 103 → 104, 104 → 105; 106 ↔ 107 cycle; 108 needs unknown 999
const quests = [
  q(101, []),
  q(102, [101], { category: "fleet", groups: [{ ship: "駆逐", amount: 4 }] }),
  q(103, [101], { category: "equipexchange", equipments: [{ name: "12cm単装砲", amount: 2 }], scraps: [{ name: "九六式艦戦", amount: 1 }] }),
  q(104, [103, 102], {
    category: "and",
    list: [
      { category: "sortie", times: 1, map: "2-3", boss: true, result: "S", groups: [{ ship: ["扶桑", "山城"], amount: 2, flagship: true }] },
      { category: "modelconversion", equipment: "九六式艦戦", scraps: [{ name: "12cm単装砲", amount: 1 }] },
    ],
  }),
  q(105, [104], { category: "fleet", groups: [{ ship: "扶桑", amount: 1 }, { shipclass: "金剛型", amount: 2 }, { ship: "艦", amount: 6 }] }),
  q(106, [107]),
  q(107, [106, 101]),
  q(108, [999, 105]),
];
const graph = buildQuestGraph(quests);

describe("resolvePrerequisites", () => {
  test("collects every ancestor, prerequisites first, by depth then id", () => {
    const t = resolvePrerequisites(graph, 105);
    expect(t.order).toEqual([101, 102, 103, 104, 105]);
    expect(Object.fromEntries(t.depth)).toEqual({ 101: 0, 102: 1, 103: 1, 104: 2, 105: 3 });
    expect(t.missing).toEqual([]);
    expect(t.cycleEdges).toEqual([]);
  });

  test("cuts cycles at the closing edge", () => {
    const t = resolvePrerequisites(graph, 106);
    expect(t.order).toEqual([101, 107, 106]);
    expect(t.cycleEdges).toEqual([[106, 107]]);
    const u = resolvePrerequisites(graph, 107);
    expect(u.order).toEqual([101, 106, 107]);
    expect(u.cycleEdges).toEqual([[107, 106]]);
  });

  test("keeps unknown prerequisite ids and an unknown target", () => {
    const t = resolvePrerequisites(graph, 108);
    expect(t.missing).toEqual([999]);
    expect(t.order).toEqual([101, 999, 102, 103, 104, 105, 108]);
    expect(resolvePrerequisites(graph, 5000)).toMatchObject({ order: [5000], missing: [5000] });
  });

  test("descendants (reverse view)", () => {
    expect(graph.unlocks.get(101)).toEqual([102, 103, 107]);
    expect(descendants(graph, 103)).toEqual([104, 105, 108]);
    expect(descendants(graph, 106)).toEqual([107]);
  });
});

describe("questStatuses", () => {
  test("listed quests mark ancestors cleared and lock what follows a listed one-time quest", () => {
    const poi: PoiQuests = {
      list: [{ id: 104, state: 1, type: 4, progress: 0 }, { id: 107, state: 1, type: 1, progress: null }],
      active: [{ id: 104, state: 2, type: 4, progress: 1 }],
      records: {},
    };
    const s = questStatuses(graph, poi);
    expect(s.get(104)).toBe("active");
    expect(s.get(107)).toBe("available");
    expect([101, 102, 103, 106].map((id) => s.get(id))).toEqual(["cleared", "cleared", "cleared", "cleared"]);
    expect(s.get(105)).toBe("locked");
    expect(s.get(108)).toBe("locked");
    expect(s.get(999)).toBeUndefined();
  });

  test("periodic quests do not lock their followers; no poi data means nothing known", () => {
    const s = questStatuses(graph, { list: null, active: [{ id: 104, state: 3, type: 2, progress: null }], records: {} });
    expect(s.get(104)).toBe("done");
    expect(s.get(105)).toBeUndefined();
    expect(questStatuses(graph, undefined).size).toBe(0);
  });
});

// Minimal master data: 扶桑 (26) → 扶桑改 (286) → 扶桑改二 (411); 山城 (27); 金剛 (78, ctype 6) → 金剛改 (209); 比叡 (86, ctype 6); 吹雪 (9, DD)
const master = {
  $ships: {
    26: { api_id: 26, api_name: "扶桑", api_stype: 9, api_ctype: 26, api_aftershipid: "286" },
    286: { api_id: 286, api_name: "扶桑改", api_stype: 10, api_ctype: 26, api_aftershipid: "411" },
    411: { api_id: 411, api_name: "扶桑改二", api_stype: 10, api_ctype: 26, api_aftershipid: "0" },
    27: { api_id: 27, api_name: "山城", api_stype: 9, api_ctype: 26, api_aftershipid: "0" },
    78: { api_id: 78, api_name: "金剛", api_stype: 8, api_ctype: 6, api_aftershipid: "209" },
    209: { api_id: 209, api_name: "金剛改", api_stype: 8, api_ctype: 6, api_aftershipid: "0" },
    86: { api_id: 86, api_name: "比叡", api_stype: 8, api_ctype: 6, api_aftershipid: "0" },
    9: { api_id: 9, api_name: "吹雪", api_stype: 2, api_ctype: 12, api_aftershipid: "0" },
    1501: { api_id: 1501, api_name: "駆逐イ級", api_stype: 2 },
  },
  $equips: {
    1: { api_id: 1, api_name: "12cm単装砲" },
    19: { api_id: 19, api_name: "九六式艦戦" },
  },
};
const state = {
  info: {
    ships: { 1: { api_ship_id: 411 }, 2: { api_ship_id: 9 }, 3: { api_ship_id: 9 }, 4: { api_ship_id: 209 }, 5: { api_ship_id: 1501 } },
    equips: { 1: { api_slotitem_id: 1 }, 2: { api_slotitem_id: 1 }, 3: { api_slotitem_id: 19 } },
  },
  const: master,
};

describe("requirements", () => {
  test("questNeeds flattens and/then lists and drops 'any ship' words", () => {
    expect(questNeeds(graph.byId.get(104)!.requirements)).toEqual({
      ships: [{ kind: "ship", names: ["扶桑", "山城"], amount: 2, consumed: false }],
      equips: [{ name: "九六式艦戦", amount: 1 }, { name: "12cm単装砲", amount: 1 }],
    });
    expect(questNeeds(graph.byId.get(105)!.requirements).ships).toEqual([
      { kind: "ship", names: ["扶桑"], amount: 1, consumed: false },
      { kind: "class", names: ["金剛型"], amount: 2, consumed: false },
    ]);
    expect(questNeeds(null)).toEqual({ ships: [], equips: [] });
  });

  test("aggregation sums equipment, keeps the largest ship amount, flags owned vs missing", () => {
    const roster = rosterFromPoi(state)!;
    const owned = new OwnershipIndex(roster);
    const { ships, equips } = aggregateNeeds(graph, resolvePrerequisites(graph, 105).order, owned);
    const byKey = Object.fromEntries(ships.map((s) => [s.names.join("/"), s]));
    // 駆逐 ×4: two 吹雪 owned (abyssal ids are not player ships)
    expect(byKey["駆逐"]).toMatchObject({ amount: 4, owned: 2, ok: false, quests: [102] });
    // 扶桑/山城 ×2 (flagship group): 扶桑改二 counts as a remodel of 扶桑
    expect(byKey["山城/扶桑"]).toMatchObject({ amount: 2, owned: 1, ok: false, quests: [104] });
    expect(byKey["扶桑"]).toMatchObject({ amount: 1, owned: 1, ok: true, quests: [105] });
    // 金剛型 ×2: 金剛改 owned, 比叡 not
    expect(byKey["金剛型"]).toMatchObject({ kind: "class", amount: 2, owned: 1, ok: false });
    const eq = Object.fromEntries(equips.map((e) => [e.name, e]));
    expect(eq["12cm単装砲"]).toMatchObject({ amount: 3, owned: 2, ok: false, quests: [103, 104] });
    expect(eq["九六式艦戦"]).toMatchObject({ amount: 2, owned: 1, ok: false, quests: [103, 104] });
  });

  test("names the master data does not know stay unresolved; no roster leaves owned null", () => {
    const g = buildQuestGraph([q(1, [], { category: "fleet", groups: [{ ship: ["謎の艦", "吹雪"], amount: 1 }, { ship: "謎の艦2" }] }),
      q(2, [], { category: "equipexchange", scraps: [{ name: "謎の砲" }] })]);
    const owned = new OwnershipIndex(rosterFromPoi(state)!);
    const r = aggregateNeeds(g, [1, 2], owned);
    expect(r.ships[0]).toMatchObject({ owned: 2, ok: true, unresolved: ["謎の艦"] });
    expect(r.ships[1]).toMatchObject({ owned: null, ok: null, unresolved: ["謎の艦2"] });
    expect(r.equips[0]).toMatchObject({ owned: null, ok: null, unresolved: ["謎の砲"] });
    expect(aggregateNeeds(g, [1], null).ships[0]).toMatchObject({ owned: null, ok: null });
    expect(rosterFromPoi({ info: {} })).toBeNull();
  });

  test("full-width names match", () => {
    const owned = new OwnershipIndex(rosterFromPoi(state)!);
    expect(owned.resolveEquip("１２ｃｍ単装砲")).toEqual([1]);
    expect(owned.resolveShip("ship", "扶桑")!.sort((a, b) => a - b)).toEqual([26, 286, 411]);
  });

  test("override needs match master ids, ship types and equipment categories exactly", () => {
    const g = buildQuestGraph([
      q(1, [], {
        category: "sortie", map: ["2-5", "3-5"], boss: true, result: "S", times: 2,
        groups: [{ ship: "金剛改", shipIds: [209], flagship: true }, { stypes: [2], amount: 3 }],
      }),
      q(2, [], { category: "equipexchange", scraps: [{ name: "小口径主砲", amount: 3, equipTypes: [1] }], equipments: [{ name: "九六式艦戦", amount: 1, equipIds: [19] }] }),
    ]);
    const typed = { ...state, const: { ...master, $equips: { 1: { api_id: 1, api_name: "12cm単装砲", api_type: [1, 1, 1, 1, 0] }, 19: { api_id: 19, api_name: "九六式艦戦", api_type: [3, 5, 6, 6, 0] } } } };
    const r = aggregateNeeds(g, [1, 2], new OwnershipIndex(rosterFromPoi(typed)!));
    // 209 exactly (no remodel expansion); stype 2 counts both 吹雪 but not the abyssal 駆逐イ級
    expect(r.ships.map((s) => [s.names.join("/"), s.amount, s.owned, s.ok])).toEqual([["金剛改", 1, 1, true], ["艦種2", 3, 2, false]]);
    expect(r.equips.map((e) => [e.name, e.amount, e.owned, e.ok])).toEqual([["九六式艦戦", 1, 1, true], ["小口径主砲", 3, 2, false]]);
    expect(describeRequirement(g.byId.get(1)!.requirements)).toEqual(["出撃 2-5/3-5 ボス S勝利以上 各 ×2", "  旗艦:金剛改、艦種2×3"]);
    expect(describeRequirement({ category: "other", note: "未確認の条件" })).toEqual(["未確認の条件"]);
  });
});

test("text helpers", () => {
  expect(describeRequirement(graph.byId.get(104)!.requirements)).toEqual([
    "すべて:",
    "  出撃 2-3 ボス S勝利以上 ×1",
    "    旗艦:扶桑/山城×2",
    "  機種転換 九六式艦戦",
    "    廃棄: 12cm単装砲×1",
  ]);
  expect(questKind("Bd1")).toBe("デイリー");
  expect(questKind("By3")).toBe("イヤリー");
  expect(questKind("2610B3")).toBe("期間限定");
  expect(questKind("A1")).toBe("単発");
  expect(questKind(null)).toBe("");
});
