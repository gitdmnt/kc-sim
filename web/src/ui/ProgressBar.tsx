import React from "react";
import { cx } from "./cx";

/** 細いメーター。ratio が低いほど赤くなる (HP 向け)。tone を指定すると固定色。 */
export const ProgressBar = ({
  value,
  max,
  tone,
  className,
}: {
  value: number;
  max: number;
  tone?: "accent" | "ok" | "warn" | "danger";
  className?: string;
}) => {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const auto = ratio > 0.5 ? "ok" : ratio > 0.25 ? "warn" : "danger";
  const color = { accent: "bg-accent-500", ok: "bg-hp-healthy", warn: "bg-hp-moderate", danger: "bg-hp-heavy" }[tone ?? auto];
  return (
    <div role="meter" aria-valuenow={value} aria-valuemax={max} className={cx("h-1.5 w-full overflow-hidden rounded-full bg-ink-800", className)}>
      <div className={cx("h-full rounded-full transition-[width]", color)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
};
