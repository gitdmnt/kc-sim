import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { normalizeForSearch } from "../../fleet/catalog";
import type { PickerOption } from "../../fleet/catalog";
import { Button, Modal, TextInput, S, cx } from "../../ui";

/** 絞り込みの区分 (category) を 1 つ持つ選択肢。艦なら艦種、装備なら装備のカテゴリ。 */
export interface PickItem extends PickerOption {
  category: number;
}

export interface PickCategory {
  id: number;
  label: string;
}

/** 一覧に出す最大件数。多いときは区分や検索で絞ってもらう。 */
const LIMIT = 300;

interface Props {
  title: string;
  items: PickItem[];
  /** 絞り込みの選択肢。items に現れる区分だけを渡す */
  categories: PickCategory[];
  categoryLabel: string;
  selectedKey?: string;
  /** 一覧の各行の先頭に置く要素 */
  prefix?: (item: PickItem) => React.ReactNode;
  initialQuery?: string;
  footer?: React.ReactNode;
  onPick: (item: PickItem) => void;
  onClose: () => void;
}

/** 区分で絞り込める検索付きの選択ダイアログ (艦・装備の選択に共通)。Enter で先頭を選ぶ。 */
export const PickerModal = ({ title, items, categories, categoryLabel, selectedKey, prefix, initialQuery = "", footer, onPick, onClose }: Props) => {
  const [category, setCategory] = useState<number | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const input = useRef<HTMLInputElement>(null);

  // Modal は開いた直後に自分へフォーカスを移すので、その後で検索欄へ移す
  useEffect(() => {
    const t = setTimeout(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const { rows, total, first } = useMemo(() => {
    const q = normalizeForSearch(query);
    const matched = items.filter((i) => (category === null || i.category === category) && (!q || i.search.includes(q)));
    const shown = matched.slice(0, LIMIT);
    const rows: ({ group: string } | { item: PickItem })[] = [];
    let last: string | undefined;
    for (const item of shown) {
      if (item.group && item.group !== last) rows.push({ group: (last = item.group) });
      rows.push({ item });
    }
    return { rows, total: matched.length, first: shown[0] };
  }, [items, category, query]);

  return (
    <Modal
      title={title}
      onClose={onClose}
      className="max-w-xl"
      footer={
        <>
          {footer}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {S.common.close}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextInput
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && first && onPick(first)}
          placeholder="名前・読みで検索"
          aria-label="検索"
          className="w-full"
        />
        <div role="group" aria-label={categoryLabel} className="flex flex-wrap gap-1">
          {[{ id: null, label: "すべて" }, ...categories].map((c) => (
            <button
              key={c.id ?? "all"}
              type="button"
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
              className={cx(
                "h-6 cursor-pointer rounded-md px-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent-400",
                category === c.id ? "bg-accent-500 font-semibold text-ink-950" : "bg-ink-800 text-ink-300 hover:bg-ink-700"
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div role="listbox" className="max-h-[min(24rem,calc(90vh-18rem))] overflow-auto rounded-md border border-ink-800 py-1">
          {rows.length === 0 && <div className="px-3 py-4 text-center text-xs text-ink-400">該当なし</div>}
          {rows.map((row) =>
            "group" in row ? (
              <div key={`g-${row.group}`} className="px-3 pt-2 pb-1 text-xs text-ink-400">
                {row.group}
              </div>
            ) : (
              <button
                key={row.item.key ?? row.item.value}
                type="button"
                role="option"
                aria-selected={row.item.key === selectedKey}
                onClick={() => onPick(row.item)}
                className={cx(
                  "flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-sm hover:bg-ink-800",
                  row.item.dim ? "text-ink-400" : "text-ink-100",
                  row.item.key === selectedKey && "font-semibold text-accent-400"
                )}
              >
                {prefix?.(row.item)}
                <span className="min-w-0 flex-1 truncate">{row.item.label}</span>
                {row.item.sub && <span className="shrink-0 text-xs tabular-nums text-ink-400">{row.item.sub}</span>}
              </button>
            )
          )}
          {total > LIMIT && <div className="px-3 py-2 text-center text-xs text-ink-400">他 {total - LIMIT} 件</div>}
        </div>
      </div>
    </Modal>
  );
};

interface TriggerProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "prefix" | "onKeyDown"> {
  label?: string;
  placeholder?: React.ReactNode;
  prefix?: React.ReactNode;
  /** 文字キーを押すとそのまま検索を始める */
  onType?: (char: string) => void;
}

/** Combobox (ghost) と同じ見た目のトリガー。クリックでダイアログを開く。 */
export const PickerTrigger = ({ label, placeholder, prefix, onType, className, ...rest }: TriggerProps) => (
  <button
    type="button"
    aria-haspopup="dialog"
    onKeyDown={(e) => {
      if (!onType || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
      e.preventDefault();
      onType(e.key);
    }}
    className={cx(
      "group/cb flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent-400",
      className
    )}
    {...rest}
  >
    {prefix}
    <span className={cx("min-w-0 flex-1 truncate", label ? "text-ink-50" : "text-ink-500")} title={label}>
      {label ?? placeholder}
    </span>
    <ChevronDown size={14} aria-hidden className="shrink-0 text-ink-500 opacity-0 group-hover/cb:opacity-100 group-focus-visible/cb:opacity-100" />
  </button>
);
