import React from "react";
import { cx } from "./cx";

interface Props {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}

export const Card = ({ title, actions, className, bodyClassName, children }: Props) => (
  <section className={cx("kc-chart rounded-md border border-ink-600 bg-ink-800/90 shadow-lg shadow-black/30", className)}>
    {(title || actions) && (
      <header className="flex min-h-12 items-center justify-between gap-2 border-b border-dashed border-ink-600 px-4 py-2">
        <h3 className="flex items-center gap-2 text-base font-semibold tracking-wide text-ink-50">
          {title && <span aria-hidden className="h-2 w-2 shrink-0 rotate-45 border border-brass-500 bg-brass-500/25" />}
          {title}
        </h3>
        <div className="flex items-center gap-1.5">{actions}</div>
      </header>
    )}
    <div className={cx("p-4", bodyClassName)}>{children}</div>
  </section>
);
