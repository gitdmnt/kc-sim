import React from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "danger";

/** 塗りだけの小さなラベル (罫なし)。状態を表すときだけ使い、飾りには使わない。 */
const TONE: Record<BadgeTone, string> = {
  neutral: "bg-ink-800 text-ink-200",
  accent: "bg-accent-500/15 text-accent-400",
  ok: "bg-ok-600/20 text-ok-400",
  warn: "bg-warn-600/20 text-warn-400",
  danger: "bg-danger-600/20 text-danger-400",
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
    className={cx("inline-flex items-center rounded-md px-2 text-xs leading-5 font-medium whitespace-nowrap", TONE[tone], className)}
  >
    {children}
  </span>
);
