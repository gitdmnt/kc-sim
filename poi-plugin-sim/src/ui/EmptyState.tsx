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
      "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-600 px-6 py-12 text-center",
      className
    )}
  >
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-700 text-lg text-ink-300">
      ◌
    </div>
    <div className="text-sm font-semibold text-ink-100">{title}</div>
    {description && <div className="max-w-md text-xs text-ink-300">{description}</div>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);
