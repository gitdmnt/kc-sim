import React, { useEffect, useState } from "react";
import { cx, defaultWidth } from "./cx";

interface Props {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  /** ghost: 密な一覧の中の枠なし (ホバー・フォーカス中だけ枠) */
  variant?: "field" | "ghost";
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

const clamp = (v: number, min?: number, max?: number) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** 編集中は途中の文字列を保持し、確定 (入力/blur) 時に範囲へ丸める。 */
export const NumberInput = ({ value, onChange, min, max, step = 1, className, variant = "field", ...rest }: Props) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = (text: string) => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) return;
    const next = clamp(Math.round(n / step) * step, min, max);
    if (next !== value) onChange(next);
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => setDraft(String(value))}
      className={cx(
        "h-8 [appearance:textfield] rounded-md border px-2 text-right text-sm tabular-nums text-ink-50",
        "[&::-webkit-inner-spin-button]:appearance-none focus:border-accent-500 focus:outline-none disabled:opacity-40",
        variant === "field" ? "border-ink-700 bg-ink-950 hover:border-ink-600" : "border-transparent bg-transparent hover:border-ink-700",
        defaultWidth(className),
        className
      )}
      {...rest}
    />
  );
};
