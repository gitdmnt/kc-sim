import React from "react";
import { Check } from "lucide-react";
import type { PoiQuestGoal, PoiQuestEntry, PoiQuests } from "@shared/embed/protocol";
import { describeRequirement } from "@shared/quest/tree";
import type { QuestGraph, QuestStatus } from "@shared/quest/tree";
import type { Doability } from "@shared/quest/doable";
import { rewardSummary } from "@shared/quest/rewards";
import type { QuestEntry } from "@shared/quest/types";
import { cx } from "../../ui";

export const STATUS: Record<QuestStatus, { label: string; dot: string }> = {
  done: { label: "達成", dot: "bg-ok-400" },
  active: { label: "遂行中", dot: "bg-accent-400" },
  available: { label: "受注可", dot: "bg-ink-200" },
  cleared: { label: "達成済", dot: "bg-ok-600" },
  locked: { label: "未開放", dot: "bg-warn-400" },
  unknown: { label: "不明", dot: "bg-ink-700" },
};
/** Quests whose conditions are met already (left out of the needs, collapsed in the tree) */
export const FINISHED: QuestStatus[] = ["cleared", "done"];

export const Dot = ({ status }: { status: QuestStatus }) => (
  <span role="img" aria-label={STATUS[status].label} title={STATUS[status].label} className={cx("size-2 shrink-0 rounded-full", STATUS[status].dot)} />
);

/** 進捗: 追跡カウンタ (poi の records、無ければ kc-sim プラグインのカウンタ) があればその数、無ければゲームの 50% / 80% 表示。 */
export const progressText = (entry: PoiQuestEntry | undefined, goals: PoiQuestGoal[] | undefined): string | null => {
  if (entry?.state === 3) return "達成";
  if (goals?.length) return goals.map((g) => `${goals.length > 1 && g.description ? `${g.description} ` : ""}${g.count}/${g.required}`).join(" · ");
  if (entry?.progress === 1) return "50%以上";
  if (entry?.progress === 2) return "80%以上";
  return null;
};

export const progressSource = (goals: PoiQuestGoal[] | undefined) =>
  goals?.some((g) => g.source === "kcsim") ? "kc-sim プラグインの集計" : "poi の任務トラッカー / ゲームの進捗表示";

export const questLabel = (q: QuestEntry | undefined, id: number) => (q ? `${q.code ?? `#${id}`} ${q.name ?? ""}` : `不明な任務 #${id}`);

export interface Player {
  statuses: Map<number, QuestStatus>;
  visible: Map<number, PoiQuestEntry>;
  records: PoiQuests["records"];
  /** 実施可能 per quest; null without poi's quest state and roster */
  doability: Map<number, Doability> | null;
}

/**
 * One quest as a clickable row: status dot, code, name, progress, 実施可能 mark. `lead` goes before the button (tree
 * guides, expand toggle), `trail` at its end; `onClick` replaces selecting the quest.
 */
export const QuestRow = ({
  id, graph, player, current, onSelect, lead, trail, muted, onClick, highlight, rowKey,
}: {
  id: number;
  graph: QuestGraph;
  player: Player;
  current?: boolean;
  onSelect: (id: number) => void;
  lead?: React.ReactNode;
  trail?: React.ReactNode;
  muted?: boolean;
  onClick?: () => void;
  highlight?: boolean;
  rowKey?: string;
}) => {
  const q = graph.byId.get(id);
  const status = player.statuses.get(id) ?? "unknown";
  const progress = progressText(player.visible.get(id), player.records[id]);
  const doable = player.doability?.get(id);
  return (
    <li className="flex min-w-0 items-stretch" data-row={rowKey}>
      {lead}
      <button
        type="button"
        onClick={onClick ?? (() => q && onSelect(id))}
        title={q ? [q.detail, ...describeRequirement(q.requirements), rewardSummary(q.rewards) && `報酬: ${rewardSummary(q.rewards)}`].filter(Boolean).join("\n") : undefined}
        className={cx(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-0.5 text-left text-sm transition-colors",
          current ? "bg-accent-500/12 text-ink-50" : highlight ? "bg-accent-500/25 text-ink-50" : "hover:bg-ink-800",
          !current && !highlight && (muted ? "text-ink-400" : "text-ink-100"),
          !q && !onClick && "cursor-default text-ink-400"
        )}
      >
        <Dot status={status} />
        <span className="w-11 shrink-0 truncate text-xs tabular-nums text-ink-400">{q?.code ?? `#${id}`}</span>
        <span className="min-w-0 flex-1 truncate">{q?.name ?? `不明な任務 #${id}`}</span>
        {progress && <span className="shrink-0 text-xs tabular-nums text-accent-400" title={progressSource(player.records[id])}>{progress}</span>}
        {doable?.doable &&
          (doable.unchecked.length > 0 ? (
            <span className="shrink-0 text-[11px] text-ink-400" title={doable.unchecked.join("\n")}>条件未確認</span>
          ) : (
            <Check role="img" aria-label="実施可能" className="size-3.5 shrink-0 text-ok-400" />
          ))}
        {trail}
      </button>
    </li>
  );
};
