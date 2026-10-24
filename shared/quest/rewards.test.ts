import { expect, test } from "bun:test";
import type { QuestRewards } from "./types";
import { rewardGroups, rewardSummary } from "./rewards";

const TWO_CHOICES: QuestRewards = {
  resources: [0, 360, 0, 180],
  items: [
    { name: "補強増設" },
    { name: "開発資材", amount: 45, choice: 1 }, { name: "南瓜", amount: 4, choice: 1 },
    { name: "装備運用枠+15", choice: 2 }, { name: "Type124 ASDIC★3", choice: 2 },
  ],
  src: "kcanotify",
};

test("groups and summary", () => {
  const g = rewardGroups(TWO_CHOICES);
  expect(g.fixed.map((i) => i.name)).toEqual(["補強増設"]);
  expect(g.choices.map((c) => c.map((i) => i.name))).toEqual([["開発資材", "南瓜"], ["装備運用枠+15", "Type124 ASDIC★3"]]);
  expect(rewardSummary(TWO_CHOICES)).toBe("弾薬360、ボーキ180、補強増設、選択: 開発資材×45 / 南瓜×4、選択: 装備運用枠+15 / Type124 ASDIC★3");
  expect(rewardSummary({ resources: [0, 0, 0, 0] })).toBeNull();
  expect(rewardSummary(null)).toBeNull();
});
