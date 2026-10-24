import { expect, test } from "bun:test";
import type { QuestEntry, QuestGroupReq, QuestRequirement } from "./types";
import { OwnershipIndex, buildQuestGraph, rosterFromPoi } from "./tree";
import type { QuestStatus } from "./tree";
import { questDoability } from "./doable";

const q = (id: number, pre: number[], requirements: QuestRequirement | null = null): QuestEntry => ({
  id, code: null, name: `q${id}`, detail: null, memo: null, pre: pre.map((p) => ({ id: p, src: ["kc3"] })), requirements,
});
const fleet = (...groups: QuestGroupReq[]): QuestRequirement => ({ category: "fleet", groups });

const graph = buildQuestGraph([
  q(1, [], fleet({ ship: "金剛" })),
  q(2, [], fleet({ ship: "比叡" })),
  q(3, [], { category: "equipexchange", equipments: [{ name: "九六式艦戦", amount: 2 }] }),
  q(4, [], { category: "sortie", map: "1-1", boss: true, groups: [{ stypes: [2], amount: 3 }] }),
  q(5, [10], fleet({ ship: "吹雪" })),
  q(6, [10, 12]),
  q(7, []),
  q(8, [], { category: "and", list: [fleet({ ship: "吹雪" }), { category: "other", note: "母港で秘書艦を変える" }] }),
  q(9, []),
  q(13, [], fleet({ ship: "謎の艦" })),
  q(14, [], { category: "sortie", map: "2-1", groups: [{ ship: "駆逐", amount: 2 }] }),
  q(15, [16], fleet({ ship: "吹雪" })),
  q(17, []),
  q(18, [], { category: "or", list: [fleet({ ship: "比叡" }), fleet({ ship: "駆逐", amount: 2 })] }),
  q(19, [], { category: "or", list: [fleet({ ship: "比叡" }), fleet({ ship: "駆逐", amount: 3 }, { ship: "比叡" })] }),
  q(20, [], fleet({ ship: "比叡" })),
  q(10, []), q(12, []), q(16, []),
]);

// 吹雪 (9) ×2, 金剛改 (209); 12cm単装砲 ×2, 九六式艦戦 ×1. 比叡 (86) is in the master data but not owned.
const owned = new OwnershipIndex(rosterFromPoi({
  info: {
    ships: { 1: { api_ship_id: 9 }, 2: { api_ship_id: 9 }, 3: { api_ship_id: 209 } },
    equips: { 1: { api_slotitem_id: 1 }, 2: { api_slotitem_id: 1 }, 3: { api_slotitem_id: 19 } },
  },
  const: {
    $ships: {
      9: { api_id: 9, api_name: "吹雪", api_stype: 2, api_ctype: 12, api_aftershipid: "0" },
      78: { api_id: 78, api_name: "金剛", api_stype: 8, api_ctype: 6, api_aftershipid: "209" },
      209: { api_id: 209, api_name: "金剛改", api_stype: 8, api_ctype: 6, api_aftershipid: "0" },
      86: { api_id: 86, api_name: "比叡", api_stype: 8, api_ctype: 6, api_aftershipid: "0" },
    },
    $equips: { 1: { api_id: 1, api_name: "12cm単装砲" }, 19: { api_id: 19, api_name: "九六式艦戦" } },
  },
})!);

const statuses = new Map<number, QuestStatus>([
  [1, "available"], [2, "available"], [3, "available"], [4, "available"], [8, "available"], [9, "available"], [13, "available"],
  [14, "active"], [15, "locked"], [16, "available"], [17, "cleared"], [18, "available"], [19, "available"], [20, "done"], [10, "cleared"],
]);
const of = (id: number, listSeen = false) => questDoability(graph, id, statuses, listSeen, owned);

test("unlocked and every named ship owned (a remodel counts for its base form)", () => {
  expect(of(1)).toEqual({ gate: "open", doable: true, ships: [], equips: [], unchecked: [] });
});

test("a missing ship, missing equipment and a short ship-type count are not doable", () => {
  const ship = of(2);
  expect(ship).toMatchObject({ gate: "open", doable: false, equips: [], unchecked: [] });
  expect(ship.ships.map((r) => [r.names, r.owned, r.amount])).toEqual([[["比叡"], 0, 1]]);
  const equip = of(3);
  expect(equip).toMatchObject({ doable: false, ships: [] });
  expect(equip.equips.map((r) => [r.name, r.owned, r.amount])).toEqual([["九六式艦戦", 1, 2]]);
  const stype = of(4);
  expect(stype.doable).toBe(false);
  expect(stype.ships.map((r) => [r.names, r.owned, r.amount])).toEqual([[["艦種2"], 2, 3]]);
});

test("遂行中 and 達成 quests are unlocked; 未開放 and 達成済 are not", () => {
  expect(of(14)).toMatchObject({ gate: "open", doable: true });
  expect(of(20)).toMatchObject({ gate: "open", doable: false });
  expect(of(15)).toMatchObject({ gate: "locked", doable: false });
  expect(of(17)).toMatchObject({ gate: "cleared", doable: false });
});

test("不明 counts as unlocked only when every prerequisite is inferred 達成済 and the 全て list was not seen", () => {
  expect(of(5)).toMatchObject({ gate: "inferred", doable: true });
  // the game's full list lacks it: cleared earlier or not offered
  expect(of(5, true)).toMatchObject({ gate: "unknown", doable: false });
  expect(of(6)).toMatchObject({ gate: "unknown", doable: false });
  // no prerequisites: nothing to infer from
  expect(of(7)).toMatchObject({ gate: "unknown", doable: false });
});

test("conditions that cannot be checked leave the quest doable, marked unchecked", () => {
  expect(of(8)).toMatchObject({ doable: true, unchecked: ["母港で秘書艦を変える"] });
  expect(of(9)).toMatchObject({ doable: true, unchecked: ["達成条件のデータなし"] });
  expect(of(13)).toMatchObject({ doable: true, unchecked: ["マスターに無い名前: 謎の艦"] });
});

test("an or-list is doable when one alternative is; else the shortfall of the closest one", () => {
  expect(of(18)).toMatchObject({ doable: true, ships: [] });
  const r = of(19);
  expect(r.doable).toBe(false);
  expect(r.ships.map((x) => x.names)).toEqual([["比叡"]]);
});
