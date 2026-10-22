import React from "react";
import { cx } from "./cx";

/** 見出しと数値 1 つ。枠は付けない (並べるときはグリッドの整列で揃える)。`size="lg"` は主要な数値。 */
export const Stat = ({
  label,
  value,
  sub,
  subTone,
  size = "md",
  className,
  title,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subTone?: "ok" | "accent" | "muted";
  size?: "md" | "lg";
  className?: string;
  title?: string;
}) => (
  <div title={title} className={cx("min-w-0", className)}>
    <div className="truncate text-xs text-ink-400">{label}</div>
    <div className={cx("font-semibold tabular-nums text-ink-50", size === "lg" ? "text-lg" : "text-base")}>{value}</div>
    {sub !== undefined && (
      <div
        className={cx(
          "text-xs",
          subTone === "ok" && "text-ok-400",
          subTone === "accent" && "text-accent-400",
          (!subTone || subTone === "muted") && "text-ink-400"
        )}
      >
        {sub}
      </div>
    )}
  </div>
);
