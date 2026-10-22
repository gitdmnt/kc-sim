import React, { useMemo, useRef, useState } from "react";
import { STORAGE_PREFIX } from "../fleet";
import { Badge, S, Tabs } from "../ui";
import type { TabItem } from "../ui";
import { EnemyTab } from "./enemy/EnemyTab";
import { MapTab } from "./map/MapTab";
import { FleetTab } from "./fleet/FleetTab";
import { LogTab } from "./log/LogTab";
import { EstimateTab } from "./estimate/EstimateTab";
import { SimTab } from "./sim/SimTab";
import { SettingsTab } from "./SettingsTab";
import { NavProvider } from "./nav";
import type { NavIntent, TabId } from "./nav";
import { useSettings } from "./settings";

const TABS: TabItem<TabId>[] = [
  { id: "fleet", label: S.tabs.fleet },
  { id: "map", label: S.tabs.map },
  { id: "enemy", label: S.tabs.enemy },
  { id: "sim", label: S.tabs.sim },
  { id: "estimate", label: S.tabs.estimate },
  { id: "log", label: S.tabs.log },
  { id: "settings", label: S.tabs.settings },
];

const TAB_KEY = `${STORAGE_PREFIX}tab`;

const initialTab = (): TabId => {
  try {
    const v = localStorage.getItem(TAB_KEY) as TabId | null;
    if (v && TABS.some((t) => t.id === v)) return v;
  } catch {
    // ignore
  }
  return "fleet";
};

export const Shell = () => {
  const [tab, setTab] = useState<TabId>(initialTab);
  const settings = useSettings();

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

  return (
    <NavProvider value={nav}>
    <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-4 p-4">
      <header className="flex items-center gap-x-6 border-b border-ink-600">
        <h1 className="hidden shrink-0 items-center gap-2.5 py-2 text-lg font-semibold tracking-wider text-ink-50 lg:flex">
          <svg viewBox="-12 -12 24 24" className="h-6 w-6 text-brass-500" aria-hidden>
            <circle r="10.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />
            <path d="M0-10L2.2-2.2L10 0L2.2 2.2L0 10L-2.2 2.2L-10 0L-2.2-2.2Z" fill="currentColor" opacity="0.35" />
            <path d="M0-10L2.2-2.2L0 0L-2.2-2.2Z" fill="currentColor" />
          </svg>
          {S.appTitle}
        </h1>
        <Tabs tabs={TABS} value={tab} onChange={(id) => { setIntent(null); change(id); }} className="min-w-0 flex-1 overflow-x-auto border-b-0" />
        {settings.useSampleState && <Badge tone="warn" className="shrink-0">サンプルデータ</Badge>}
      </header>

      <main className="min-w-0 flex-1">
        {tab === "fleet" && <FleetTab />}
        {tab === "map" && <MapTab />}
        {tab === "enemy" && <EnemyTab />}
        {tab === "sim" && <SimTab />}
        {tab === "estimate" && <EstimateTab />}
        {tab === "log" && <LogTab />}
        {tab === "settings" && <SettingsTab />}
      </main>
    </div>
    </NavProvider>
  );
};
