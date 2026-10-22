import React from "react";
import type { Rank } from "@sim-core";
import { cx } from "../../ui";

export const RANKS: Rank[] = ["SS", "S", "A", "B", "C", "D", "E"];
export const RANK_COLOR: Record<Rank, string> = {
  SS: "#e8cf7a", S: "var(--color-brass-500)", A: "var(--color-danger-500)", B: "var(--color-warn-600)", C: "#b8892a", D: "var(--color-ok-600)", E: "var(--color-accent-600)",
};

export const StackedBar = ({
  parts,
  height = "h-7",
}: {
  parts: { label: string; value: number; color: string }[];
  height?: string;
}) => (
  <div className={`flex w-full overflow-hidden rounded border border-ink-600 bg-ink-900 ${height}`}>
    {parts.map((p) =>
      p.value > 0 ? (
        <div key={p.label} style={{ width: `${p.value * 100}%`, background: p.color }} title={`${p.label}: ${(p.value * 100).toFixed(2)}%`} />
      ) : null
    )}
  </div>
);

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/** 表示上 0 (「0.0%」「0.0」「0」) か */
const shownZero = (s: string) => /^0(\.0+)?%?$/.test(s);

/** 勝敗ランクの凡例 (割合つき)。0% のランクは出さない。 */
export const RankLegend = ({ rates }: { rates: Record<Rank, number> }) => (
  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
    {RANKS.map((k) => {
      const v = pct(rates[k], 1);
      return shownZero(v) ? null : (
        <span key={k} className="flex items-center gap-1 text-ink-300">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: RANK_COLOR[k] }} />
          {k} <span className="tabular-nums text-ink-50">{v}</span>
        </span>
      );
    })}
  </div>
);

export const rankBar = (rates: Record<Rank, number>) => RANKS.map((k) => ({ label: k, value: rates[k], color: RANK_COLOR[k] }));

/** 主要指標。結果パネルの上段に 2×2 で並べる。 */
export const Kpi = ({ label, value, sub, title }: { label: string; value: string; sub?: React.ReactNode; title?: string }) => (
  <div title={title} className="min-w-0 rounded-md border border-accent-500/25 bg-gradient-to-br from-accent-500/12 to-ink-900/60 px-3 py-1.5 shadow-[inset_3px_0_0_var(--color-accent-500)]">
    <div className="flex items-baseline justify-between gap-2 text-xs text-ink-300">
      <span className="truncate">{label}</span>
      {sub && <span className="truncate text-ink-400">{sub}</span>}
    </div>
    <div className="text-[26px] leading-tight font-semibold tabular-nums text-ink-50">{value}</div>
  </div>
);

/** 補助指標 (小)。 */
export const Mini = ({ label, value, title, alert }: { label: string; value: string; title?: string; alert?: boolean }) => (
  <div title={title} className="min-w-0">
    <div className="truncate text-[11px] text-ink-400">{label}</div>
    <div className={cx("truncate text-sm font-medium tabular-nums", alert ? "text-danger-400" : shownZero(value) ? "text-ink-400" : "text-ink-50")}>{value}</div>
  </div>
);

// ---- 結果パネル内の詰めた表 ----

export const DTable = ({ head, children }: { head: React.ReactNode; children: React.ReactNode }) => (
  <table className="w-full border-collapse text-xs">
    <thead className="sticky top-0 z-10 bg-ink-800 text-left text-[11px] text-ink-400">
      <tr className="border-b border-ink-600">{head}</tr>
    </thead>
    <tbody>{children}</tbody>
  </table>
);

export const Th = ({ children, className }: { children?: React.ReactNode; className?: string }) => (
  <th className={cx("px-1.5 py-1 font-medium whitespace-nowrap", className ?? "text-right")}>{children}</th>
);

export const DTr = ({ children, onClick, selected }: { children: React.ReactNode; onClick?: () => void; selected?: boolean }) => (
  <tr
    onClick={onClick}
    className={cx(
      "border-b border-ink-700/70 last:border-0",
      onClick && "cursor-pointer hover:bg-ink-700/50",
      selected && "bg-accent-500/10 shadow-[inset_2px_0_0_var(--color-accent-500)]"
    )}
  >
    {children}
  </tr>
);

export const Td = ({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) => (
  <td title={title} className={cx("px-1.5 py-1 align-middle", className)}>
    {children}
  </td>
);

/** 数値セル。主列 (`main`) は明るく、表示上 0 の値は薄く、`alert` は危険色。 */
export const Num = ({ children, main, alert }: { children: string; main?: boolean; alert?: boolean }) => (
  <td
    className={cx(
      "px-1.5 py-1 text-right tabular-nums whitespace-nowrap",
      shownZero(children) ? "text-ink-500" : alert ? "text-danger-400" : main ? "font-medium text-ink-50" : "text-ink-300"
    )}
  >
    {children}
  </td>
);

export const STATE_PARTS = (s: { healthyRate: number; lightRate: number; moderateRate: number; heavyRate: number; sunkRate: number }) => [
  { label: "無傷", value: s.healthyRate, color: "var(--color-ok-600)" },
  { label: "小破", value: s.lightRate, color: "#b8892a" },
  { label: "中破", value: s.moderateRate, color: "var(--color-warn-600)" },
  { label: "大破", value: s.heavyRate, color: "var(--color-danger-600)" },
  { label: "撃沈", value: s.sunkRate, color: "var(--color-ink-500)" },
];
