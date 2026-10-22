import React from "react";
import { cx } from "./cx";

/** ratio が低いほど赤くなる (HP 向け)。tone を指定すると固定色。 */
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
  const color = { accent: "bg-accent-500", ok: "bg-ok-400", warn: "bg-warn-400", danger: "bg-danger-500" }[
    tone ?? auto
  ];
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemax={max}
      className={cx("h-1.5 w-full overflow-hidden rounded-full bg-ink-700", className)}
    >
      <div className={cx("h-full rounded-full transition-all", color)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
};
