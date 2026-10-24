import React from "react";
import { REWARD_RESOURCES, rewardGroups, rewardItemText } from "@shared/quest/rewards";
import type { QuestRewards } from "@shared/quest/types";
import { cx } from "../../ui";

const RES_DOT = ["bg-ok-400", "bg-brass-400", "bg-ink-200", "bg-warn-400"];

/** 任務の報酬: 資源と固定の報酬を一行、選択報酬はグループごとに一行 (どれか 1 つ)。 */
export const QuestRewardsView = ({ rewards }: { rewards: QuestRewards | null | undefined }) => {
  if (!rewards) return <p className="text-xs text-ink-500">報酬: データなし</p>;
  const { fixed, choices } = rewardGroups(rewards);
  const hasRes = rewards.resources?.some((x) => x > 0);
  return (
    <div className="flex flex-col gap-0.5 text-xs text-ink-100" aria-label="報酬">
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <span className="font-semibold text-ink-300">報酬</span>
        {rewards.resources?.map((x, i) =>
          x > 0 ? (
            <span key={i} className="inline-flex items-center gap-1 tabular-nums">
              <span aria-hidden className={cx("size-2 rounded-sm", RES_DOT[i])} />
              <span className="text-ink-400">{REWARD_RESOURCES[i]}</span>
              {x}
            </span>
          ) : null
        )}
        {!rewards.resources && <span className="text-ink-500">資源 不明</span>}
        {fixed.length > 0 && <span>{fixed.map(rewardItemText).join("、")}</span>}
        {!hasRes && fixed.length === 0 && choices.length === 0 && <span className="text-ink-500">なし</span>}
      </p>
      {choices.map((g, n) => (
        <p key={n} aria-label={`選択報酬 ${n + 1}`}>
          <span className="text-ink-400">{choices.length > 1 ? `選択${n + 1}` : "選択"}: </span>
          {g.map(rewardItemText).join(" / ")}
        </p>
      ))}
    </div>
  );
};
