import React from "react";
import { cx } from "./cx";

/** 数値 1 つを見出し付きで出す。`size="lg"` は画面の主要指標 (KPI) 用。 */
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
  <div
    title={title}
    className={cx(
      "min-w-0 rounded-md border",
      size === "lg"
        ? "border-accent-500/25 bg-gradient-to-br from-accent-500/12 to-ink-900/60 px-4 py-3 shadow-[inset_3px_0_0_var(--color-accent-500)]"
        : "border-ink-700/80 bg-ink-900/60 px-3 py-2",
      className
    )}
  >
    <div className={cx("tracking-wide text-ink-300", size === "lg" ? "text-sm" : "text-xs")}>{label}</div>
    <div
      className={cx(
        "leading-tight font-semibold tabular-nums text-ink-50",
        size === "lg" ? "mt-1 text-[28px]" : "text-lg"
      )}
    >
      {value}
    </div>
    {sub !== undefined && (
      <div
        className={cx(
          "mt-0.5 text-xs",
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
