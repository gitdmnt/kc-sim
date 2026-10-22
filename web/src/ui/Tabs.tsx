import React from "react";
import { cx } from "./cx";

export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  /** 補助表示 (件数など) */
  hint?: string;
  /** label がアイコンだけのときの名前 */
  ariaLabel?: string;
  title?: string;
}

interface Props<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** bar: 画面のタブ (下線)。pill: 切り替え (塗りのセグメント) */
  variant?: "bar" | "pill";
  size?: "md" | "sm";
}

export const Tabs = <T extends string>({ tabs, value, onChange, className, variant = "bar", size = "md" }: Props<T>) => (
  <div
    role="tablist"
    className={cx("flex items-center", variant === "bar" ? "gap-1" : "w-fit gap-0.5 rounded-md bg-ink-950 p-0.5", className)}
  >
    {tabs.map((t, i) => {
      const active = t.id === value;
      return (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={active}
          aria-label={t.ariaLabel}
          title={t.title}
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
            "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent-400",
            variant === "bar"
              ? cx(
                  // 下線はタブの幅の独立した線 (面の片側の罫ではない)
                  "relative font-medium after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
                  size === "sm" ? "h-10 px-3 text-sm" : "h-11 px-4 text-base",
                  active ? "text-ink-50 after:bg-accent-500" : "text-ink-400 hover:text-ink-100"
                )
              : cx(
                  "rounded-md font-medium",
                  size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm",
                  active ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-100"
                )
          )}
        >
          {t.label}
          {t.hint && <span className="text-xs text-ink-400">{t.hint}</span>}
        </button>
      );
    })}
  </div>
);
