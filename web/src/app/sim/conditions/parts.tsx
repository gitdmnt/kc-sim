import React from "react";
import type { WorkspacePrefs } from "../prefs";
import type { SortieMapPrefs } from "../sortieConfig";

export const DIFF = ["通常", "丁", "丙", "乙", "甲"];

export const Group = ({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) => (
  <div className={className}>
    <div className="mb-1 text-xs text-ink-400">{title}</div>
    <div className="flex flex-col gap-1">{children}</div>
  </div>
);

/** 出撃の条件の各部品が受け取るもの: 海域を問わない条件と、選んだ海域の条件 */
export interface SortieOptionProps {
  prefs: WorkspacePrefs;
  setPrefs: (p: Partial<WorkspacePrefs>) => void;
  mapPrefs: SortieMapPrefs;
  setMapPrefs: (p: Partial<SortieMapPrefs>) => void;
}

/** 数値の入力欄の幅をそろえた小さなラベル (表の中の入力用) */
export const Inline = ({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) => (
  <label className="flex min-w-0 items-center gap-1 text-xs text-ink-400" title={title}>
    <span className="shrink-0">{label}</span>
    {children}
  </label>
);
