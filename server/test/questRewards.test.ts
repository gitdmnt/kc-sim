// Reward parsing of the upstream files (real entries: kcanotify-gamedata quests-jp.json, kcwiki-quest-data, KC3 memos)
// and the merge order override > kcanotify > kcwiki > KC3 memo.
import { expect, test } from "bun:test";
import { kc3QuestMeta, kc3QuestTranslations, kcwikiQuestData, mergeQuests } from "../src/quests";
import { parseQuestOverrides } from "../src/questOverrides";
import { kcanotifyRewards, kcwikiRewards, parseKc3MemoRewards, parseKcanotifyRewardText, parseRewardItem } from "../src/questRewards";

test("items: amount after × or x, none for 1 or for +N slots", () => {
  expect(parseRewardItem("開発資材×2")).toEqual({ name: "開発資材", amount: 2 });
  expect(parseRewardItem("倉橋 x1", 2)).toEqual({ name: "倉橋", choice: 2 });
  expect(parseRewardItem("13号対空電探改(後期型)★3×2")).toEqual({ name: "13号対空電探改(後期型)★3", amount: 2 });
  expect(parseRewardItem("装備運用枠+12")).toEqual({ name: "装備運用枠+12" });
  expect(parseRewardItem(" ")).toBeNull();
});

test("kcanotify reward text: fixed items, 選択報酬 and 二回選択報酬 groups", () => {
  expect(parseKcanotifyRewardText("駆逐艦「白雪」")).toEqual([{ name: "駆逐艦「白雪」" }]);
  expect(parseKcanotifyRewardText("改修資材×4, 給糧艦「間宮」×3, 戦果+350")).toEqual([
    { name: "改修資材", amount: 4 }, { name: "給糧艦「間宮」", amount: 3 }, { name: "戦果+350" },
  ]);
  expect(parseKcanotifyRewardText("補強増設, 選択報酬：[開発資材×12、甲標的 丁型改(蛟龍改)、改修資材×6]")).toEqual([
    { name: "補強増設" },
    { name: "開発資材", amount: 12, choice: 1 }, { name: "甲標的 丁型改(蛟龍改)", choice: 1 }, { name: "改修資材", amount: 6, choice: 1 },
  ]);
  expect(parseKcanotifyRewardText("二回選択報酬：[燃料×800、SJレーダー+潜水艦司令塔装備][勲章×2、零式艦戦63型(爆戦)]")).toEqual([
    { name: "燃料", amount: 800, choice: 1 }, { name: "SJレーダー+潜水艦司令塔装備", choice: 1 },
    { name: "勲章", amount: 2, choice: 2 }, { name: "零式艦戦63型(爆戦)", choice: 2 },
  ]);
});

test("kcanotify entry: resources [0] and the parsed text", () => {
  expect(kcanotifyRewards({ rewards: "高速修復材×2, 家具箱（小）", resources: [[400, 0, 400, 0], [2, 0, 0, 0]] })).toEqual({
    resources: [400, 0, 400, 0], items: [{ name: "高速修復材", amount: 2 }, { name: "家具箱（小）" }], src: "kcanotify",
  });
  expect(kcanotifyRewards({})).toBeNull();
});

test("KC3 memo [獲]: fixed lines, then one group per indented line; ※ ends it", () => {
  expect(parseKc3MemoRewards("[獲]駆逐艦白雪")).toEqual([{ name: "駆逐艦白雪" }]);
  expect(parseKc3MemoRewards("※B勝利以上を20回で達成\n[獲]開発資材x2、改修資材x1")).toEqual([{ name: "開発資材", amount: 2 }, { name: "改修資材" }]);
  expect(parseKc3MemoRewards("※期間限定\n[獲]応急修理女神x2\n二回選択報酬：\n\u3000戦闘糧食x4、改修資材x4\n\u3000二式爆雷★4x1、燃料x3300")).toEqual([
    { name: "応急修理女神", amount: 2 },
    { name: "戦闘糧食", amount: 4, choice: 1 }, { name: "改修資材", amount: 4, choice: 1 },
    { name: "二式爆雷★4", choice: 2 }, { name: "燃料", amount: 3300, choice: 2 },
  ]);
  expect(parseKc3MemoRewards("[獲]選択報酬：\n\u3000探照灯x1、改修資材x2\n※注意")).toEqual([
    { name: "探照灯", choice: 1 }, { name: "改修資材", amount: 2, choice: 1 },
  ]);
  expect(parseKc3MemoRewards("[獲]菱餅x1\n開発資材x2")).toEqual([{ name: "菱餅" }, { name: "開発資材", amount: 2 }]);
  expect(parseKc3MemoRewards("※遠征で達成")).toBeNull();
  expect(parseKc3MemoRewards(null)).toBeNull();
});

test("kcwiki reward fields: each choices entry is a group", () => {
  expect(kcwikiRewards({
    game_id: 158, reward_fuel: 0, reward_ammo: 0, reward_steel: 0, reward_bauxite: 0,
    reward_other: [{ name: "高速修復材", amount: 3 }, { choices: [{ name: "41cm連装砲", amount: 2 }, { name: "新型砲熕兵装資材", amount: 1 }] }],
  })).toEqual({
    resources: [0, 0, 0, 0],
    items: [{ name: "高速修復材", amount: 3 }, { name: "41cm連装砲", amount: 2, choice: 1 }, { name: "新型砲熕兵装資材", choice: 1 }],
    src: "kcwiki",
  });
  expect(kcwikiRewards({ game_id: 1 })).toBeNull();
});

test("merge: override > kcanotify > kcwiki > KC3 memo, with coverage stats", () => {
  const { quests, stats } = mergeQuests({
    kc3Meta: kc3QuestMeta.parse({ "101": { unlock: [102] }, "102": { unlock: [103] }, "103": { unlock: [104] }, "104": {}, "105": {} }),
    kc3Jp: kc3QuestTranslations.parse({
      "101": { code: "A1", memo: "[獲]駆逐艦白雪" },
      "102": { code: "A2", memo: "[獲]高速建造材x1" },
      "103": { code: "A3", memo: "[獲]開発資材x1" },
      "104": { code: "A4", memo: "[獲]開発資材x9" },
      "105": { code: "A5" },
    }),
    kcwiki: kcwikiQuestData.parse([
      { game_id: 102, reward_fuel: 30, reward_ammo: 30, reward_steel: 30, reward_bauxite: 0, reward_other: [{ name: "高速建造材", amount: 1 }] },
      { game_id: 103, reward_fuel: 1, reward_ammo: 1, reward_steel: 1, reward_bauxite: 1, reward_other: [] },
    ]),
    kcanotify: { "103": { rewards: "開発資材", resources: [[40, 40, 0, 40], [0, 0, 1, 0]] }, "104": { rewards: "開発資材×9", resources: [[1, 2, 3, 4]] } },
    overrides: parseQuestOverrides([{ id: 104, source: "https://zekamashi.net/x/", rewards: { resources: [10, 20, 30, 40] } }]),
  });
  const r = Object.fromEntries(quests.map((q) => [q.id, q.rewards]));
  expect(r[101]).toEqual({ items: [{ name: "駆逐艦白雪" }], src: "kc3-memo" });
  expect(r[102]).toEqual({ resources: [30, 30, 30, 0], items: [{ name: "高速建造材" }], src: "kcwiki" });
  expect(r[103]).toEqual({ resources: [40, 40, 0, 40], items: [{ name: "開発資材" }], src: "kcanotify" });
  expect(r[104]).toEqual({ resources: [10, 20, 30, 40], src: "override" });
  expect(r[105]).toBeNull();
  expect(stats).toMatchObject({ withRewards: 4, overriddenRewards: 1, rewardsKcanotify: 1, rewardsKcwiki: 1, rewardsKc3Memo: 1, noRewards: [105] });
});
