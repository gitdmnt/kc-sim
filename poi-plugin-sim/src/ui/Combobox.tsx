import React, { useEffect, useMemo, useRef, useState } from "react";
import { normalizeForSearch } from "../fleet/catalog";
import type { PickerOption } from "../fleet/catalog";
import { cx } from "./cx";

interface Props {
  options: PickerOption[];
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  /** 値が options に無いときの表示名 (例: 不明な艦) */
  fallbackLabel?: string;
  clearable?: boolean;
  disabled?: boolean;
  maxItems?: number;
  className?: string;
  "aria-label"?: string;
}

type Row =
  | { kind: "group"; label: string; key: string }
  | { kind: "option"; option: PickerOption; index: number };

/** 検索付きセレクト (グループ表示・キーボード操作対応)。 */
export const Combobox = ({
  options,
  value,
  onChange,
  placeholder = "選択…",
  fallbackLabel,
  clearable,
  disabled,
  maxItems = 80,
  className,
  ...rest
}: Props) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = value === null ? undefined : options.find((o) => o.value === value);

  const { rows, flat, total } = useMemo(() => {
    const q = normalizeForSearch(query);
    const matched = q ? options.filter((o) => o.search.includes(q)) : options;
    const shown = matched.slice(0, maxItems);
    const rows: Row[] = [];
    let lastGroup: string | undefined;
    shown.forEach((option, index) => {
      if (option.group !== lastGroup && option.group) {
        rows.push({ kind: "group", label: option.group, key: `g-${option.group}-${index}` });
        lastGroup = option.group;
      }
      rows.push({ kind: "option", option, index });
    });
    return { rows, flat: shown, total: matched.length };
  }, [options, query, maxItems]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  useEffect(() => setActive(0), [query, open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (v: number | null) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  const label = selected?.label ?? (value !== null ? fallbackLabel ?? `#${value}` : undefined);

  return (
    <div ref={root} className={cx("relative min-w-0", className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-ink-600 bg-ink-900 px-2.5 text-left text-sm",
          "hover:border-ink-500 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-50",
          open && "border-accent-500"
        )}
        {...rest}
      >
        <span className={cx("truncate", label ? "text-ink-50" : "text-ink-400")}>{label ?? placeholder}</span>
        <span className="text-[10px] text-ink-400">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-full min-w-64 rounded-md border border-ink-500 bg-ink-800 shadow-xl shadow-black/50">
          <div className="border-b border-ink-600 p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(flat.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (flat[active]) choose(flat[active].value);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
              placeholder="名前・読みで検索"
              className="h-7 w-full rounded border border-ink-600 bg-ink-900 px-2 text-sm text-ink-50 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none"
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-72 overflow-auto py-1">
            {clearable && value !== null && (
              <button
                type="button"
                onClick={() => choose(null)}
                className="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-ink-300 hover:bg-ink-700"
              >
                選択を外す
              </button>
            )}
            {rows.length === 0 && <div className="px-3 py-4 text-center text-xs text-ink-400">該当なし</div>}
            {rows.map((row) =>
              row.kind === "group" ? (
                <div key={row.key} className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-ink-400">
                  {row.label}
                </div>
              ) : (
                <button
                  key={row.option.value}
                  type="button"
                  role="option"
                  aria-selected={row.option.value === value}
                  data-index={row.index}
                  onMouseEnter={() => setActive(row.index)}
                  onClick={() => choose(row.option.value)}
                  className={cx(
                    "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-sm",
                    row.index === active ? "bg-accent-600/25 text-ink-50" : "text-ink-100",
                    row.option.value === value && "font-semibold text-accent-400"
                  )}
                >
                  <span className="truncate">{row.option.label}</span>
                  {row.option.sub && <span className="shrink-0 text-[10px] text-ink-400">{row.option.sub}</span>}
                </button>
              )
            )}
            {total > flat.length && (
              <div className="px-3 py-1.5 text-center text-[11px] text-ink-400">
                他 {total - flat.length} 件 — 検索で絞り込み
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
