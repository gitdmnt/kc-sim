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
  <section className={cx("rounded-lg border border-ink-600 bg-ink-800 shadow-sm shadow-black/20", className)}>
    {(title || actions) && (
      <header className="flex items-center justify-between gap-2 border-b border-ink-600 px-4 py-2.5">
        <h3 className="text-sm font-semibold tracking-wide text-ink-50">{title}</h3>
        <div className="flex items-center gap-1.5">{actions}</div>
      </header>
    )}
    <div className={cx("p-4", bodyClassName)}>{children}</div>
  </section>
);
