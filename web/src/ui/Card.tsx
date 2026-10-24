import React from "react";
import { cx } from "./cx";

interface Props {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}

/** パネル (面 ink-900 + 全周の hairline)。見出しは本文と同じ余白で揃え、罫で区切らない。 */
export const Card = ({ title, actions, className, bodyClassName, children }: Props) => (
  <section className={cx("rounded-md border border-ink-800 bg-ink-900", className)}>
    {(title || actions) && (
      <header className="flex min-h-10 items-center justify-between gap-2 px-4 pt-3">
        <h3 className="min-w-0 text-base font-semibold text-ink-50">{title}</h3>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </header>
    )}
    <div className={cx("p-4", (title || actions) ? "pt-3" : null, bodyClassName)}>{children}</div>
  </section>
);
