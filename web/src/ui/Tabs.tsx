import React from "react";
import { cx } from "./cx";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** 準備中などの補助表示 */
  hint?: string;
}

interface Props<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  variant?: "bar" | "pill";
  /** sm: 詰めた表示 (ツールバー・パネル内) */
  size?: "md" | "sm";
}

export const Tabs = <T extends string>({ tabs, value, onChange, className, variant = "bar", size = "md" }: Props<T>) => (
  <div
    role="tablist"
    className={cx(
      "flex items-center",
      variant === "bar" ? "gap-1 border-b border-ink-600" : cx("w-fit rounded-md border border-ink-600 bg-ink-900/80", size === "sm" ? "gap-0.5 p-0.5" : "gap-1 p-1"),
      className
    )}
  >
    {tabs.map((t, i) => {
      const active = t.id === value;
      return (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = tabs[(i + step + tabs.length) % tabs.length];
            onChange(next.id);
            // 次のタブにフォーカスを移す (再描画後)
            requestAnimationFrame(() => (e.currentTarget.parentElement?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus());
          }}
          className={cx(
            "cursor-pointer whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent-400",
            variant === "bar"
              ? cx(
                  "-mb-px border-b-2 font-medium tracking-wide",
                  size === "sm" ? "px-3 py-2 text-sm" : "px-4 py-2.5 text-[15px]",
                  active
                    ? "border-brass-500 text-ink-50"
                    : "border-transparent text-ink-300 hover:border-ink-500 hover:text-ink-100"
                )
              : cx(
                  "rounded font-medium",
                  size === "sm" ? "px-2.5 py-0.5 text-xs leading-5" : "px-3.5 py-1.5 text-sm",
                  active ? "bg-ink-700 text-ink-50 shadow-[inset_0_-2px_0_var(--color-brass-500)]" : "text-ink-300 hover:text-ink-100"
                )
          )}
        >
          {t.label}
          {t.hint && <span className="ml-1.5 text-xs text-ink-400">{t.hint}</span>}
        </button>
      );
    })}
  </div>
);
