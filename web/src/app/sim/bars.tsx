import React from "react";
import type { Rank } from "@sim-core";
import { StackedBar, cx } from "../../ui";
import type { BarPart } from "../../ui";

export const RANKS: Rank[] = ["SS", "S", "A", "B", "C", "D", "E"];
export const RANK_COLOR: Record<Rank, string> = {
  SS: "var(--color-rank-ss)",
  S: "var(--color-rank-s)",
  A: "var(--color-rank-a)",
  B: "var(--color-rank-b)",
  C: "var(--color-rank-c)",
  D: "var(--color-rank-d)",
  E: "var(--color-rank-e)",
};

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/** 表示上 0 (「0.0%」「0.0」「0」) か */
export const shownZero = (s: string) => /^0(\.0+)?%?$/.test(s);

/** 勝敗ランクの区間。scale を掛けると「出撃あたり」などの割合になる。 */
export const rankBar = (rates: Record<Rank, number>, scale = 1): BarPart[] =>
  RANKS.map((k) => ({ label: k, value: rates[k] * scale, color: RANK_COLOR[k] }));

export const STATE_PARTS = (s: { healthyRate: number; lightRate: number; moderateRate: number; heavyRate: number; sunkRate: number }): BarPart[] => [
  { label: "無傷", value: s.healthyRate, color: "var(--color-hp-healthy)" },
  { label: "小破", value: s.lightRate, color: "var(--color-hp-light)" },
  { label: "中破", value: s.moderateRate, color: "var(--color-hp-moderate)" },
  { label: "大破", value: s.heavyRate, color: "var(--color-hp-heavy)" },
  { label: "撃沈", value: s.sunkRate, color: "var(--color-hp-sunk)" },
];

/**
 * 主要な率の一覧: 見出し・棒・数値の 3 列。全行で同じ 0〜100% の尺度なので、行を上から読むと漏斗になる。
 * 数値は右端の 1 列に揃える。
 */
export const RateList = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_4.5rem] items-center gap-x-3 gap-y-1">{children}</div>
);

export const RateRow = ({ label, parts, value, title, tone }: { label: string; parts: BarPart[]; value: string; title?: string; tone?: "danger" }) => (
  <>
    <span className="truncate text-sm text-ink-300" title={title}>
      {label}
    </span>
    <StackedBar parts={parts} />
    <span className={cx("text-right text-lg font-semibold tabular-nums", tone === "danger" ? "text-danger-400" : "text-ink-50")}>{value}</span>
  </>
);

/** 補助の数値: 見出しと値を左右に。2 列のグリッドに並べる。 */
export const Fact = ({ label, value, sub, title, tone, icon }: { label: string; value: string; sub?: string; title?: string; tone?: "danger" | "warn"; icon?: React.ReactNode }) => (
  <div title={title} className="flex min-w-0 items-baseline gap-2">
    <span className="flex min-w-0 items-center gap-1 truncate text-xs text-ink-400">
      {icon}
      {label}
    </span>
    <span className="flex-1" />
    {sub && <span className="text-xs text-ink-500 tabular-nums">{sub}</span>}
    <span className={cx("text-sm font-medium tabular-nums", tone === "danger" ? "text-danger-400" : tone === "warn" ? "text-warn-400" : "text-ink-50")}>{value}</span>
  </div>
);

// ---- 結果パネル内の詰めた表 ----

export const DTable = ({ head, children }: { head: React.ReactNode; children: React.ReactNode }) => (
  <table className="w-full border-collapse text-sm">
    <thead className="sticky top-0 z-10 bg-ink-900 text-left text-xs text-ink-400">
      <tr>{head}</tr>
    </thead>
    <tbody>{children}</tbody>
  </table>
);

export const Th = ({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) => (
  <th title={title} className={cx("px-2 py-1 font-normal whitespace-nowrap", className ?? "text-right")}>
    {children}
  </th>
);

export const DTr = ({ children, onClick, selected }: { children: React.ReactNode; onClick?: () => void; selected?: boolean }) => (
  <tr
    onClick={onClick}
    aria-selected={selected}
    className={cx("border-t border-ink-800", onClick && "cursor-pointer hover:bg-ink-800", selected && "bg-accent-500/12")}
  >
    {children}
  </tr>
);

export const Td = ({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) => (
  <td title={title} className={cx("h-7 px-2 align-middle", className)}>
    {children}
  </td>
);

/** 数値セル。表示上 0 の値は薄く、`alert` は危険色。 */
export const Num = ({ children, alert, className }: { children: string; alert?: boolean; className?: string }) => (
  <td
    className={cx(
      "h-7 px-2 text-right tabular-nums whitespace-nowrap",
      shownZero(children) ? "text-ink-500" : alert ? "text-danger-400" : "text-ink-100",
      className
    )}
  >
    {children}
  </td>
);
