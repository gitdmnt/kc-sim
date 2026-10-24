// kcwiki-quest-data requirements -> override requirements with master ids (scripts/lib/kcwiki-ids.ts).
import { expect, test } from "bun:test";
import { kcwikiConverter } from "../scripts/lib/kcwiki-ids";

const convert = kcwikiConverter({
  ships: [
    { api_id: 20, api_name: "雪風", api_stype: 2, api_ctype: 30, api_aftershipid: "228" },
    { api_id: 228, api_name: "雪風改", api_stype: 2, api_ctype: 30, api_aftershipid: "0" },
    { api_id: 542, api_name: "夕雲改二", api_stype: 2, api_ctype: 38, api_aftershipid: "0" },
    { api_id: 133, api_name: "夕雲", api_stype: 2, api_ctype: 38, api_aftershipid: "542" },
  ],
  equips: [{ api_id: 2, api_name: "12.7cm連装砲" }],
  missions: [{ api_id: 5, api_name: "海上護衛任務" }, { api_id: 100, api_disp_no: "A1", api_name: "兵站強化任務" }],
  equipTypes: [{ api_id: 1, api_name: "小口径主砲" }],
  useitems: [{ api_id: 3, api_name: "開発資材" }],
});

test("names become master ids with later remodels; type words become stypes; free slots are dropped", () => {
  const { requirements, problems } = convert({
    category: "sortie", map: "2-5", boss: true, result: "S", times: 1,
    groups: [{ ship: "雪風" }, { ship: "駆逐", flagship: true, amount: 4 }, { shipclass: "夕雲", amount: 2 }, { ship: "艦", amount: 2 }],
    disallowed: "他の艦",
  });
  expect(problems).toEqual([]);
  expect(requirements).toEqual({
    category: "sortie", map: "2-5", boss: true, result: "S", times: 1, onlyGroups: true,
    groups: [
      { ship: "雪風", shipIds: [20, 228] },
      // "flagship 駆逐 ×4": the flagship is a destroyer and there are four
      { ship: "駆逐", stypes: [2], flagship: true },
      { ship: "駆逐", stypes: [2], amount: 4 },
      { shipclass: "夕雲", ctypes: [38], amount: 2 },
    ],
  });
});

test("map ranges are summed; expedition id lists mean each; items resolve to ids, categories or consumables", () => {
  expect(convert({ category: "sortie", map: "2-1 ~ 2-3", boss: true, times: 5 }).requirements).toMatchObject({ map: ["2-1", "2-2", "2-3"], total: true });
  expect(convert({ category: "expedition", objects: [{ id: [5, "A1"], times: 1 }] }).requirements).toEqual({
    category: "expedition", objects: [{ id: 5, name: "海上護衛任務", times: 1 }, { id: 100, name: "兵站強化任務", times: 1 }],
  });
  expect(convert({ category: "equipexchange", scraps: [{ name: "12.7cm連装砲", amount: 2 }, { name: "小口径主砲", amount: 3 }, { name: "開発資材", amount: 10 }] }).requirements).toEqual({
    category: "equipexchange",
    scraps: [{ name: "12.7cm連装砲", amount: 2, equipIds: [2] }, { name: "小口径主砲", amount: 3, equipTypes: [1] }],
    consumptions: [{ name: "開発資材", amount: 10, category: "アイテム" }],
  });
});

test("anything without one reading is reported", () => {
  const problems = (r: Record<string, unknown>) => convert(r).problems;
  expect(problems({ category: "sortie", map: "3-5", boss: true, times: 1, groups: [{ ship: "空母" }] })).toEqual(["ship word 空母 (正規/装甲 only, or 軽空母 too?)"]);
  expect(problems({ category: "sortie", map: "1-6", result: "クリア", times: 1 })).toEqual(["sortie without boss (クリア)", "result クリア"]);
  expect(problems({ category: "sortie", map: "7-2-P2", boss: true, times: 1 })).toEqual(["map 7-2-P2"]);
  expect(problems({ category: "sortie", map: "1-1", boss: true, times: 1, groups: [{ ship: "謎" }], disallowed: "航戦" })).toEqual([
    "ship name 謎: not in the master data", "disallowed 航戦",
  ]);
  expect(problems({ category: "sink", amount: 1, ship: "敵空母" })).toEqual(["category sink"]);
});
