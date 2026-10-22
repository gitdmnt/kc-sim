import React from "react";
import { cx } from "./cx";

export const Stat = ({
  label,
  value,
  sub,
  subTone,
  className,
  title,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subTone?: "ok" | "accent" | "muted";
  className?: string;
  title?: string;
}) => (
  <div title={title} className={cx("min-w-0 rounded-md bg-ink-900/70 px-2.5 py-1.5", className)}>
    <div className="text-[11px] text-ink-300">{label}</div>
    <div className="text-base leading-tight font-semibold tabular-nums text-ink-50">{value}</div>
    {sub !== undefined && (
      <div
        className={cx(
          "text-[10px] leading-3.5",
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
