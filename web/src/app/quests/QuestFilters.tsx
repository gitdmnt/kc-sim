import React from "react";
import { ChevronDown, X } from "lucide-react";
import {
  CATEGORY_LABEL, EMPTY_QUEST_FILTER, FREQUENCY_LABEL, QUEST_CATEGORIES, QUEST_FREQUENCIES, STATUS_GROUPS, STATUS_GROUP_LABEL,
} from "@shared/quest/filter";
import type { QuestFacetCounts, QuestFilter } from "@shared/quest/filter";
import { Button, Popover, cx } from "../../ui";

/** One facet as a dropdown of toggles with counts; the button shows the selection (none = all). */
const Facet = <K extends string>({ label, keys, names, short, selected, counts, onChange }: {
  label: string;
  keys: readonly K[];
  names: Record<K, string>;
  /** Button text per value (defaults to `names`) */
  short?: Partial<Record<K, string>>;
  selected: K[];
  counts: Record<K, number>;
  onChange: (next: K[]) => void;
}) => {
  const text = selected.map((k) => short?.[k] ?? names[k]).join("・");
  return (
    <Popover
      size="sm"
      label={
        <>
          <span className={cx("min-w-0 flex-1 truncate text-left", selected.length ? "text-accent-400" : "text-ink-300")}>{text || label}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-ink-400" />
        </>
      }
      title={`${label}: ${text || "すべて"}`}
      aria-label={`${label}で絞り込み (${text || "すべて"})`}
      className="min-w-0 flex-1"
      buttonClassName="w-full min-w-0 px-1.5 text-xs"
      panelClassName="w-44 p-1.5"
    >
      <div role="group" aria-label={label} className="flex flex-col gap-0.5">
        {keys.map((k) => {
          const on = selected.includes(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((s) => s !== k) : keys.filter((x) => x === k || selected.includes(x)))}
              className={cx(
                "flex h-6 cursor-pointer items-center gap-2 rounded px-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent-400",
                on ? "bg-accent-500/20 text-ink-50" : "text-ink-200 hover:bg-ink-800",
                counts[k] === 0 && !on && "text-ink-500"
              )}
            >
              <span className={cx("size-2.5 shrink-0 rounded-sm border", on ? "border-accent-400 bg-accent-400" : "border-ink-500")} />
              <span className="min-w-0 flex-1 truncate text-left">{names[k]}</span>
              <span className="shrink-0 tabular-nums text-ink-400">{counts[k]}</span>
            </button>
          );
        })}
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="mt-0.5 h-6 cursor-pointer rounded px-2 text-left text-xs text-ink-400 hover:bg-ink-800">
            選択を解除 (すべて)
          </button>
        )}
      </div>
    </Popover>
  );
};

const FREQ_SHORT = { once: "単発", daily: "日", weekly: "週", monthly: "月", quarterly: "季", yearly: "年", limited: "限定" } as const;
const CATEGORY_NAMES = Object.fromEntries(
  QUEST_CATEGORIES.map((c) => [c, c === "other" ? CATEGORY_LABEL[c] : `${c} ${CATEGORY_LABEL[c]}`]),
) as Record<(typeof QUEST_CATEGORIES)[number], string>;

/** 任務一覧の絞り込み: 頻度・種別 (任務コードから)・状況 (poi の任務状態があるときだけ)。 */
export const QuestFilters = ({ filter, counts, showStatus, onChange }: {
  filter: QuestFilter;
  counts: QuestFacetCounts;
  showStatus: boolean;
  onChange: (f: QuestFilter) => void;
}) => {
  const active = filter.freq.length + filter.cat.length + (showStatus ? filter.status.length : 0) > 0;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="任務の絞り込み">
      <Facet label="頻度" keys={QUEST_FREQUENCIES} names={FREQUENCY_LABEL} short={FREQ_SHORT} selected={filter.freq} counts={counts.freq} onChange={(freq) => onChange({ ...filter, freq })} />
      <Facet label="種別" keys={QUEST_CATEGORIES} names={CATEGORY_NAMES} short={CATEGORY_LABEL} selected={filter.cat} counts={counts.cat} onChange={(cat) => onChange({ ...filter, cat })} />
      {showStatus && (
        <Facet label="状況" keys={STATUS_GROUPS} names={STATUS_GROUP_LABEL} selected={filter.status} counts={counts.status} onChange={(status) => onChange({ ...filter, status })} />
      )}
      {active && (
        <Button variant="ghost" size="sm" icon aria-label="絞り込みを解除" title="絞り込みを解除" onClick={() => onChange(EMPTY_QUEST_FILTER)}>
          <X aria-hidden className="size-3.5" />
        </Button>
      )}
    </div>
  );
};
