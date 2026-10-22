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
  <div className={cx("flex flex-col items-center justify-center gap-2 rounded-md bg-ink-900 px-6 py-12 text-center", className)}>
    <div className="text-base font-semibold text-ink-100">{title}</div>
    {description && <div className="max-w-md text-sm text-ink-400">{description}</div>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);
