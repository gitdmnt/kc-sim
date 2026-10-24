// Display helpers for quest rewards (QuestEntry.rewards, merged by server/src/quests.ts).
import type { QuestRewardItem, QuestRewards } from "./types";

export const REWARD_RESOURCES = ["燃料", "弾薬", "鋼材", "ボーキ"] as const;

/** Fixed items, then the 選択報酬 groups (pick one item per group) in choice order. */
export const rewardGroups = (r: QuestRewards | null | undefined): { fixed: QuestRewardItem[]; choices: QuestRewardItem[][] } => {
  const items = r?.items ?? [];
  const nums = [...new Set(items.flatMap((i) => (i.choice ? [i.choice] : [])))].sort((a, b) => a - b);
  return { fixed: items.filter((i) => !i.choice), choices: nums.map((c) => items.filter((i) => i.choice === c)) };
};

export const rewardItemText = (i: { name: string; amount?: number }) => `${i.name}${i.amount && i.amount > 1 ? `×${i.amount}` : ""}`;

/** One line: non-zero resources, fixed items, then "選択: A / B" per group; null without rewards. */
export const rewardSummary = (r: QuestRewards | null | undefined): string | null => {
  if (!r) return null;
  const { fixed, choices } = rewardGroups(r);
  const parts = [
    ...(r.resources ?? []).flatMap((x, i) => (x > 0 ? [`${REWARD_RESOURCES[i]}${x}`] : [])),
    ...fixed.map(rewardItemText),
    ...choices.map((g) => `選択: ${g.map(rewardItemText).join(" / ")}`),
  ];
  return parts.length ? parts.join("、") : null;
};

export interface RewardTotal {
  /** Summed resources of the quests that list them */
  resources: number[];
  /** Summed fixed items by name, largest first */
  items: { name: string; amount: number }[];
  /** Quests with 選択報酬 (not summed) */
  withChoices: number;
  /** Quests without rewards data, or without resources */
  unknown: number;
}

/** Fixed rewards of several quests summed (e.g. along a prerequisite path); 選択報酬 are only counted. */
export const sumRewards = (list: readonly (QuestRewards | null | undefined)[]): RewardTotal => {
  const resources = [0, 0, 0, 0];
  const items = new Map<string, number>();
  let withChoices = 0;
  let unknown = 0;
  for (const r of list) {
    if (!r?.resources) unknown++;
    r?.resources?.forEach((x, i) => (resources[i]! += x));
    const { fixed, choices } = rewardGroups(r);
    for (const i of fixed) items.set(i.name, (items.get(i.name) ?? 0) + (i.amount ?? 1));
    if (choices.length) withChoices++;
  }
  return {
    resources,
    items: [...items].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
    withChoices,
    unknown,
  };
};
