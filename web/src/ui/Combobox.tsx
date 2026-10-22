import React, { useEffect, useMemo, useRef, useState } from "react";
import { normalizeForSearch } from "../fleet/catalog";
import type { PickerOption } from "../fleet/catalog";
import { cx } from "./cx";

interface Props {
  options: PickerOption[];
  value: number | null;
  /** 選んだ選択肢も受け取る (同じ value の選択肢が複数あるとき用) */
  onChange: (value: number | null, option?: PickerOption) => void;
  placeholder?: string;
  /** 値が options に無いときの表示名 (例: 不明な艦) */
  fallbackLabel?: string;
  clearable?: boolean;
  disabled?: boolean;
  maxItems?: number;
  /** 現在値を示す選択肢の key。省略時は value が一致する選択肢 */
  selectedKey?: string;
  /** 閉じているときに文字キーを押すとそのまま検索を始める */
  typeToSearch?: boolean;
  className?: string;
  menuClassName?: string;
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
  selectedKey,
  typeToSearch,
  className,
  menuClassName,
  ...rest
}: Props) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isSelected = (o: PickerOption) => (selectedKey !== undefined ? (o.key ?? String(o.value)) === selectedKey : o.value === value);

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

  const choose = (v: number | null, option?: PickerOption, refocus = false) => {
    onChange(v, option);
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  };

  const label = selected?.label ?? (value !== null ? fallbackLabel ?? `#${value}` : undefined);

  return (
    <div ref={root} className={cx("relative min-w-0", className)}>
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!typeToSearch || open || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
          e.preventDefault();
          setQuery(e.key);
          setOpen(true);
        }}
        className={cx(
          "flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-ink-600 bg-ink-950/70 px-2.5 text-left text-sm transition-colors",
          "hover:border-ink-500 focus-visible:outline-2 focus-visible:outline-accent-400 disabled:opacity-50",
          open && "border-accent-500 ring-2 ring-accent-500/25"
        )}
        {...rest}
      >
        <span className={cx("truncate", label ? "text-ink-50" : "text-ink-400")}>{label ?? placeholder}</span>
        <span className="text-xs text-ink-400">▾</span>
      </button>

      {open && (
        <div className={cx("absolute top-full left-0 z-40 mt-1 w-full min-w-64 rounded-md border border-ink-500 bg-ink-800 shadow-2xl shadow-black/60", menuClassName)}>
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
                  if (flat[active]) choose(flat[active].value, flat[active], true);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpen(false);
                  trigger.current?.focus();
                }
              }}
              placeholder="名前・読みで検索"
              className="h-7 w-full rounded border border-ink-600 bg-ink-950 px-2 text-sm text-ink-50 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none"
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
                <div key={row.key} className="px-3 pt-2 pb-1 text-xs font-semibold text-ink-300">
                  {row.label}
                </div>
              ) : (
                <button
                  key={row.option.key ?? row.option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected(row.option)}
                  data-index={row.index}
                  onMouseEnter={() => setActive(row.index)}
                  onClick={() => choose(row.option.value, row.option)}
                  className={cx(
                    "flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-sm",
                    row.index === active ? "bg-accent-600/25 text-ink-50" : row.option.dim ? "text-ink-400" : "text-ink-100",
                    isSelected(row.option) && "font-semibold text-accent-400"
                  )}
                >
                  <span className="truncate">{row.option.label}</span>
                  {row.option.sub && <span className="shrink-0 text-xs tabular-nums text-ink-400">{row.option.sub}</span>}
                </button>
              )
            )}
            {total > flat.length && (
              <div className="px-3 py-1.5 text-center text-xs text-ink-400">
                他 {total - flat.length} 件
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
