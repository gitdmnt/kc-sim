import React from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-ink-700/60 text-ink-200 border-ink-600",
  accent: "bg-accent-500/12 text-accent-400 border-accent-500/35",
  ok: "bg-ok-600/15 text-ok-400 border-ok-600/40",
  warn: "bg-warn-600/15 text-warn-400 border-warn-600/45",
  danger: "bg-danger-600/15 text-danger-400 border-danger-600/45",
};

export const Badge = ({
  tone = "neutral",
  className,
  children,
  title,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
  title?: string;
}) => (
  <span
    title={title}
    className={cx(
      "inline-flex items-center rounded border px-1.5 py-px text-xs leading-4 font-medium whitespace-nowrap",
      TONE[tone],
      className
    )}
  >
    {children}
  </span>
);
