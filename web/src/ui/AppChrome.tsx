import React from "react";
import { Compass } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Tabs } from "./Tabs";
import { cx } from "./cx";
import { S } from "./strings";

export interface ChromeView<V extends string> {
  id: V;
  label: string;
}

/** アクティビティバーの 1 項目 (機能) と、その機能のローカルタブ (上の行) */
export interface ChromeFeature<F extends string, V extends string> {
  id: F;
  /** バーの短い名前 */
  label: string;
  /** 正式な名前 (title、ローカルタブが 1 つのときの上の行) */
  title: string;
  icon: LucideIcon;
  views: ChromeView<V>[];
  /** バーの下端に置く (設定) */
  bottom?: boolean;
}

interface Props<F extends string, V extends string> {
  features: ChromeFeature<F, V>[];
  view: V;
  onView: (v: V) => void;
  onFeature: (f: F) => void;
  /** false なら枠を描かず中身だけ (poi プラグインが枠を描くとき)。切り替えても中身は作り直さない */
  bars?: boolean;
  /** macOS のプラグインウィンドウ: タイトルバーが無く左上に信号ボタンがあるので、上の行を右に寄せる (アプリのアイコンは出さない) */
  windowButtons?: boolean;
  /** 上の行の右端 (版) */
  end?: React.ReactNode;
  children: React.ReactNode;
}

// poi (macOS) はプラグインウィンドウの上端 23px に -webkit-app-region: drag の帯を置く。タブだけ no-drag にして
// クリックを通す (空いたところはウィンドウのドラッグに使える)
const NO_DRAG_TABS = "[&>[role=tab]]:[-webkit-app-region:no-drag]";

/**
 * 画面の枠 (VS Code と同じ形): 左のアクティビティバーで機能を切り替え (全体)、上の行のタブでその機能の中の画面を
 * 切り替える (ローカル)。Web UI と poi プラグインが同じこの部品で描く。上の行は全幅で、バーはその下から始まる
 * (macOS の信号ボタンは上の行の左端にかかる)。
 */
export const AppChrome = <F extends string, V extends string>({
  features,
  view,
  onView,
  onFeature,
  bars = true,
  windowButtons = false,
  end,
  children,
}: Props<F, V>) => {
  const current = features.find((f) => f.views.some((v) => v.id === view)) ?? features[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {bars && (
        // 高さはタブ (h-15 = 60px) + 下の罫。見出しだけの機能でも同じ高さ (バーと中身が動かない)
        <div className={cx("box-content flex h-15 shrink-0 items-center border-b border-ink-800", windowButtons ? "pr-12 pl-48" : "pr-3")}>
          {!windowButtons && (
            <div className="flex w-24 shrink-0 justify-center text-ink-400" title={S.appTitle} role="img" aria-label={S.appTitle}>
              <Compass size={18} aria-hidden />
            </div>
          )}
          {current.views.length > 1 ? (
            <Tabs tabs={current.views} value={view} onChange={onView} size="sm" className={cx("min-w-0", NO_DRAG_TABS)} />
          ) : (
            <h1 className="px-3 text-sm font-medium text-ink-50">{current.title}</h1>
          )}
          {end && <div className="ml-auto shrink-0 pl-3 text-xs text-ink-500 tabular-nums">{end}</div>}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {bars && <ActivityBar features={features} value={current.id} onChange={onFeature} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
};

/** 左端の縦の列: アイコンと短い名前。bottom の項目 (設定) は下端に寄せる */
const ActivityBar = <F extends string, V extends string>({
  features,
  value,
  onChange,
}: {
  features: ChromeFeature<F, V>[];
  value: F;
  onChange: (id: F) => void;
}) => {
  const firstBottom = features.findIndex((f) => f.bottom);
  return (
    <nav role="tablist" aria-orientation="vertical" className="flex w-24 shrink-0 flex-col border-r border-ink-800 py-1.5">
      {features.map((f, i) => {
        const active = f.id === value;
        const Icon = f.icon;
        return (
          <button
            key={f.id}
            role="tab"
            type="button"
            aria-selected={active}
            title={f.title}
            aria-label={f.title}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(f.id)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              onChange(features[(i + step + features.length) % features.length].id);
              // 選んだ項目にフォーカスを移す (再描画後。currentTarget はハンドラを抜けると null になる)
              const list = e.currentTarget.parentElement;
              requestAnimationFrame(() => (list?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus());
            }}
            className={cx(
              // 選択中の印は左端の縦線 (VS Code と同じ)
              "relative flex h-21 shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-400",
              "before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full",
              i === firstBottom && "mt-auto",
              active ? "text-ink-50 before:bg-accent-500" : "text-ink-500 hover:text-ink-200"
            )}
          >
            <Icon size={20} aria-hidden />
            {f.label}
          </button>
        );
      })}
    </nav>
  );
};
