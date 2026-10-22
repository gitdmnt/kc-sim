import React from "react";
import { cx } from "./cx";

export interface BarPart {
  label: string;
  value: number;
  color: string;
}

/** 割合の積み上げ棒 (合計 ≤ 1)。凡例は出さず、各区間の title (ホバー) で名前と割合を示す。 */
export const StackedBar = ({ parts, className }: { parts: BarPart[]; className?: string }) => (
  <div className={cx("flex h-2 w-full overflow-hidden rounded-full bg-ink-800", className)}>
    {parts.map((p) =>
      p.value > 0 ? (
        <div key={p.label} className="h-full" style={{ width: `${p.value * 100}%`, background: p.color }} title={`${p.label} ${(p.value * 100).toFixed(1)}%`} />
      ) : null
    )}
  </div>
);
