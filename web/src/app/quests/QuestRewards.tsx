import React from "react";
import { REWARD_RESOURCES, rewardGroups, rewardItemText } from "@shared/quest/rewards";
import type { RewardTotal } from "@shared/quest/rewards";
import type { QuestRewardItem, QuestRewardSource, QuestRewards } from "@shared/quest/types";
import { cx } from "../../ui";

const RES_TEXT = ["text-ok-400", "text-brass-400", "text-ink-200", "text-warn-400"];
const RES_DOT = ["bg-ok-400", "bg-brass-400", "bg-ink-200", "bg-warn-400"];
/** 資材の色 (高速修復材 緑・高速建造材 橙・開発資材 青緑・改修資材 金) */
const ITEM_TEXT: Record<string, string> = {
  高速修復材: "text-ok-400", 高速建造材: "text-warn-400", 開発資材: "text-accent-400", 改修資材: "text-brass-400",
};
const SOURCE: Record<QuestRewardSource, string> = {
  override: "手入力データ",
  kcanotify: "kcanotify-gamedata",
  kcwiki: "kcwiki-quest-data",
  "kc3-memo": "KC3 のメモ (資源は不明)",
};

/** 燃料・弾薬・鋼材・ボーキの 0 でないものを色付きで */
export const ResourceAmounts = ({ resources }: { resources: readonly number[] }) => (
  <>
    {resources.map((x, i) =>
      x > 0 ? (
        <span key={i} className="inline-flex items-center gap-1 tabular-nums" title={REWARD_RESOURCES[i]}>
          <span aria-hidden className={cx("size-2 rounded-sm", RES_DOT[i])} />
          <span className="text-ink-400">{REWARD_RESOURCES[i]}</span>
          <span className={RES_TEXT[i]}>{x}</span>
        </span>
      ) : null
    )}
  </>
);

const Item = ({ item }: { item: QuestRewardItem | { name: string; amount: number } }) => (
  <span className={cx("rounded bg-ink-800 px-1.5 leading-5 tabular-nums", ITEM_TEXT[item.name] ?? "text-ink-100")}>{rewardItemText(item)}</span>
);

/** 任務の報酬: 資源、固定の報酬、選択報酬 (グループごとにどれか 1 つ)。 */
export const QuestRewardsView = ({ rewards }: { rewards: QuestRewards | null | undefined }) => {
  if (!rewards) return <p className="text-xs text-ink-500">報酬: データなし</p>;
  const { fixed, choices } = rewardGroups(rewards);
  const hasRes = rewards.resources?.some((x) => x > 0);
  return (
    <div className="flex flex-col gap-1 text-xs" aria-label="報酬">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-semibold text-ink-300" title={rewards.src ? `出典: ${SOURCE[rewards.src]}` : undefined}>報酬</span>
        {hasRes && <ResourceAmounts resources={rewards.resources!} />}
        {!rewards.resources && <span className="text-ink-500">資源 不明</span>}
        {fixed.map((i, n) => <Item key={n} item={i} />)}
        {!hasRes && fixed.length === 0 && choices.length === 0 && <span className="text-ink-500">なし</span>}
      </div>
      {choices.map((g, n) => (
        <div key={n} className="flex flex-wrap items-center gap-1 rounded-md border border-ink-700 px-1.5 py-0.5" aria-label={`選択報酬 ${n + 1}`}>
          <span className="mr-0.5 text-ink-400">{choices.length > 1 ? `選択${n + 1}` : "選択"}</span>
          {g.map((i, k) => (
            <React.Fragment key={k}>
              {k > 0 && <span className="text-ink-500">/</span>}
              <Item item={i} />
            </React.Fragment>
          ))}
        </div>
      ))}
    </div>
  );
};

/** 前提の経路で受け取る報酬の合計 (固定分のみ、選択報酬は件数だけ)。 */
export const RewardTotalLine = ({ total, quests }: { total: RewardTotal; quests: number }) => {
  const top = total.items.slice(0, 6);
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs" aria-label="経路の報酬合計">
      <span className="text-ink-400" title="未達成・不明の前提とこの任務の、選択報酬を除く報酬の合計">経路の報酬 ({quests} 件)</span>
      <ResourceAmounts resources={total.resources} />
      {top.map((i) => <Item key={i.name} item={i} />)}
      {total.items.length > top.length && <span className="text-ink-500">他 {total.items.length - top.length} 種</span>}
      {total.withChoices > 0 && <span className="text-ink-500">+ 選択報酬 {total.withChoices} 件</span>}
      {total.unknown > 0 && <span className="text-ink-500">資源不明 {total.unknown} 件</span>}
    </div>
  );
};
