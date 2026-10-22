import React from "react";
import type { Rank } from "@sim-core";
import { Td, cx } from "../../ui";

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

/** 勝敗ランクの凡例 (割合つき)。0% のランクは薄くする。 */
export const RankLegend = ({ rates }: { rates: Record<Rank, number> }) => (
  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
    {RANKS.map((k) => {
      const v = pct(rates[k], 2);
      return (
        <span key={k} className={cx("flex items-center gap-1.5", shownZero(v) ? "text-ink-500" : "text-ink-200")}>
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RANK_COLOR[k] }} />
          {k} <span className={cx("tabular-nums", !shownZero(v) && "text-ink-50")}>{v}</span>
        </span>
      );
    })}
  </div>
);

/** 表の数値セル。主列 (`main`) は明るく、表示上 0 の値は薄く、`alert` は危険色。 */
export const NumTd = ({ children, main, alert }: { children: string; main?: boolean; alert?: boolean }) => (
  <Td
    className={cx(
      "text-right tabular-nums",
      shownZero(children) ? "text-ink-500" : alert ? "text-danger-400" : main ? "font-medium text-ink-50" : "text-ink-300"
    )}
  >
    {children}
  </Td>
);

export const STATE_PARTS = (s: { healthyRate: number; lightRate: number; moderateRate: number; heavyRate: number; sunkRate: number }) => [
  { label: "無傷", value: s.healthyRate, color: "var(--color-ok-600)" },
  { label: "小破", value: s.lightRate, color: "#b8892a" },
  { label: "中破", value: s.moderateRate, color: "var(--color-warn-600)" },
  { label: "大破", value: s.heavyRate, color: "var(--color-danger-600)" },
  { label: "撃沈", value: s.sunkRate, color: "var(--color-ink-500)" },
];
