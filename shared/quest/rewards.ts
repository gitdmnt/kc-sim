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
