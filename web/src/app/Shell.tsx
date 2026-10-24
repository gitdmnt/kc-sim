import React, { useMemo, useRef, useState } from "react";
import { Anchor, Compass, ListChecks, Map, Settings, Swords } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { STORAGE_PREFIX } from "../fleet";
import { Badge, S, cx } from "../ui";
import { EnemyTab } from "./enemy/EnemyTab";
import { MapTab } from "./map/MapTab";
import { Workspace } from "./sim/Workspace";
import { QuestTab } from "./quests/QuestTab";
import { SettingsTab } from "./SettingsTab";
import { NavProvider } from "./nav";
import type { NavIntent, TabId } from "./nav";
import { useApp } from "./context";
import type { PoiConnection } from "../poiBridge";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "sortie", label: S.tabs.sortie, icon: Anchor },
  { id: "map", label: S.tabs.map, icon: Map },
  { id: "enemy", label: S.tabs.enemy, icon: Swords },
  { id: "quests", label: S.tabs.quests, icon: ListChecks },
  { id: "settings", label: S.tabs.settings, icon: Settings },
];

/** 画面いっぱいに使うタブ (中で区画ごとにスクロールする)。他のタブは内容の高さで、はみ出せば main がスクロールする */
const FULL_HEIGHT: TabId[] = ["sortie", "map", "enemy", "quests"];

/** poi との接続で対処が要る状態だけ出す */
const PoiBadge = ({ poi }: { poi: PoiConnection }) =>
  poi.status === "silent" ? (
    <Badge tone="warn" className="w-fit shrink-0">poi 応答なし</Badge>
  ) : poi.status === "unsupported" ? (
    <Badge tone="danger" className="w-fit shrink-0" title={`プラグインのプロトコル v${poi.pluginVersion}`}>プラグインを更新してください</Badge>
  ) : null;

/** 左端の縦のタブ列 (VS Code のアクティビティバー): アイコンと短い名前 */
const ActivityBar = ({ value, onChange }: { value: TabId; onChange: (id: TabId) => void }) => (
  <nav role="tablist" aria-orientation="vertical" className="flex w-16 shrink-0 flex-col border-r border-ink-800 py-1">
    {TABS.map((t, i) => {
      const active = t.id === value;
      const Icon = t.icon;
      return (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={active}
          title={t.label}
          tabIndex={active ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            onChange(TABS[(i + step + TABS.length) % TABS.length].id);
            requestAnimationFrame(() => (e.currentTarget.parentElement?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus());
          }}
          className={cx(
            // 選択中の印は左端の縦線 (VS Code と同じ)
            "relative flex h-14 cursor-pointer flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-400",
            "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full",
            active ? "text-ink-50 before:bg-accent-500" : "text-ink-500 hover:text-ink-200"
          )}
        >
          <Icon size={20} aria-hidden />
          {t.label}
        </button>
      );
    })}
  </nav>
);

const TAB_KEY = `${STORAGE_PREFIX}tab`;
/** 統合で消えたタブ id → 移した先 (保存済みの選択を引き継ぐ) */
const RENAMED_TABS: Record<string, TabId> = { estimate: "enemy" };

const initialTab = (): TabId => {
  try {
    const v = localStorage.getItem(TAB_KEY);
    const id = v && (RENAMED_TABS[v] ?? v);
    if (id && TABS.some((t) => t.id === id)) return id as TabId;
  } catch {
    // ignore
  }
  return "sortie";
};

/**
 * 画面の枠: 左にタブ列、右に選んだタブ。poi プラグインに埋め込まれているときはヘッダを描かない
 * (プラグインが シミュレーション / 観測ログ / 送信設定 の 1 行を常に描く)。ブラウザで直接開いたときだけ題名の行を出す。
 */
export const Shell = () => {
  const [tab, setTab] = useState<TabId>(initialTab);
  const { poi } = useApp();
  const embedded = poi.status !== "standalone";

  const change = (id: TabId) => {
    setTab(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      // ignore
    }
  };

  const [intent, setIntent] = useState<NavIntent | null>(null);
  const seq = useRef(0);
  const nav = useMemo(
    () => ({
      intent,
      go: (i: Omit<NavIntent, "seq">) => {
        setIntent({ ...i, seq: ++seq.current });
        change(i.tab);
      },
    }),
    [intent] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const sortie = tab === "sortie";
  // 出撃タブは初めて開いたときに作る (他のタブで起動したときに海域データを取りに行かない)
  const [sortieMounted, setSortieMounted] = useState(sortie);
  if (sortie && !sortieMounted) setSortieMounted(true);
  const pane = "lg:min-h-0 lg:flex-1";

  return (
    <NavProvider value={nav}>
      <div className="flex h-screen flex-col">
        {!embedded && (
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-800 px-3">
            <Compass size={18} className="text-ink-400" aria-hidden />
            <h1 className="text-sm font-semibold text-ink-50">{S.appTitle}</h1>
            <span className="ml-auto text-xs text-ink-500 tabular-nums">v{__APP_VERSION__}</span>
          </header>
        )}
        <div className="flex min-h-0 flex-1">
          <ActivityBar
            value={tab}
            onChange={(id) => {
              setIntent(null);
              change(id);
            }}
          />
          <main className="min-h-0 min-w-0 flex-1 overflow-auto">
            <div className={cx("mx-auto flex max-w-[1600px] flex-col gap-2 p-2", FULL_HEIGHT.includes(tab) && "lg:h-full")}>
              <PoiBadge poi={poi} />
              {/* 出撃タブは一度作ったら隠すだけで外さない (結果と計算を保つ) */}
              {sortieMounted && (
                <div className={sortie ? pane : "hidden"}>
                  <Workspace />
                </div>
              )}
              {tab === "map" && <div className={pane}><MapTab /></div>}
              {tab === "enemy" && <div className={pane}><EnemyTab /></div>}
              {tab === "quests" && <div className={pane}><QuestTab /></div>}
              {tab === "settings" && <SettingsTab />}
            </div>
          </main>
        </div>
      </div>
    </NavProvider>
  );
};
