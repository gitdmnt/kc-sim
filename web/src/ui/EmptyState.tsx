import React from "react";
import { cx } from "./cx";

export const EmptyState = ({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) => (
  <div
    className={cx(
      "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-ink-600 bg-ink-900/30 px-6 py-12 text-center",
      className
    )}
  >
    <svg viewBox="-16 -16 32 32" className="mb-1 h-10 w-10 text-brass-500/70" aria-hidden>
      <circle r="14" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
      <path d="M-14 0H14M0-14V14" stroke="currentColor" strokeWidth="0.75" opacity="0.6" />
      <circle r="3" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
    <div className="text-base font-semibold text-ink-100">{title}</div>
    {description && <div className="max-w-md text-sm text-ink-300">{description}</div>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);
