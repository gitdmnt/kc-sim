import React, { useMemo, useRef, useState } from "react";
import { STORAGE_PREFIX } from "../fleet";
import { Badge, S, Tabs, cx } from "../ui";
import type { TabItem } from "../ui";
import { EnemyTab } from "./enemy/EnemyTab";
import { MapTab } from "./map/MapTab";
import { EstimateTab } from "./estimate/EstimateTab";
import { Workspace } from "./sim/Workspace";
import { SettingsTab } from "./SettingsTab";
import { NavProvider } from "./nav";
import type { NavIntent, TabId } from "./nav";
import { useApp } from "./context";
import type { PoiConnection } from "../poiBridge";

const TABS: TabItem<TabId>[] = [
  { id: "sortie", label: S.tabs.sortie },
  { id: "map", label: S.tabs.map },
  { id: "enemy", label: S.tabs.enemy },
  { id: "estimate", label: S.tabs.estimate },
  { id: "settings", label: S.tabs.settings },
];

/** poi との接続で対処が要る状態だけ出す */
const PoiBadge = ({ poi }: { poi: PoiConnection }) =>
  poi.status === "silent" ? (
    <Badge tone="warn" className="shrink-0">poi 応答なし</Badge>
  ) : poi.status === "unsupported" ? (
    <Badge tone="danger" className="shrink-0" title={`プラグインのプロトコル v${poi.pluginVersion}`}>プラグインを更新してください</Badge>
  ) : null;

const TAB_KEY = `${STORAGE_PREFIX}tab`;

const initialTab = (): TabId => {
  try {
    const v = localStorage.getItem(TAB_KEY) as TabId | null;
    if (v && TABS.some((t) => t.id === v)) return v;
  } catch {
    // ignore
  }
  return "sortie";
};

export const Shell = () => {
  const [tab, setTab] = useState<TabId>(initialTab);
  const { poi } = useApp();
  // 出撃タブのツールバー (海域・モード・実行) はヘッダの右に置く
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);

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

  return (
    <NavProvider value={nav}>
      <div className={cx("mx-auto flex max-w-[1600px] flex-col gap-2 px-2 pb-2", sortie ? "min-h-screen lg:h-screen lg:min-h-0" : "min-h-screen")}>
        <header className="flex shrink-0 items-center gap-x-3 border-b border-ink-600">
          <h1 className="flex shrink-0 items-center gap-2 text-base font-semibold tracking-wider text-ink-50" title={S.appTitle}>
            <svg viewBox="-12 -12 24 24" className="h-5 w-5 text-brass-500" aria-hidden>
              <circle r="10.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />
              <path d="M0-10L2.2-2.2L10 0L2.2 2.2L0 10L-2.2 2.2L-10 0L-2.2-2.2Z" fill="currentColor" opacity="0.35" />
              <path d="M0-10L2.2-2.2L0 0L-2.2-2.2Z" fill="currentColor" />
            </svg>
            <span className="hidden 2xl:inline">{S.appTitle}</span>
          </h1>
          <Tabs tabs={TABS} value={tab} size="sm" onChange={(id) => { setIntent(null); change(id); }} className="shrink-0 border-b-0" />
          <div ref={setToolbar} className="flex min-w-0 flex-1 justify-end py-1" />
          <PoiBadge poi={poi} />
        </header>

        <main className="min-h-0 min-w-0 flex-1">
          {/* 出撃タブは隠すだけで外さない (結果と計算を保つ) */}
          <div className={sortie ? "lg:h-full" : "hidden"}>
            <Workspace toolbar={sortie ? toolbar : null} />
          </div>
          {tab === "map" && <MapTab />}
          {tab === "enemy" && <EnemyTab />}
          {tab === "estimate" && <EstimateTab />}
          {tab === "settings" && <SettingsTab />}
        </main>
      </div>
    </NavProvider>
  );
};
