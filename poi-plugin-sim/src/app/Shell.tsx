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
      <header className="flex flex-col gap-x-6 border-b border-ink-600 lg:flex-row lg:items-center">
        <div className="flex items-center gap-2 py-2">
          <span className="h-5 w-1 rounded-full bg-accent-500" />
          <h1 className="text-base font-semibold tracking-wide text-ink-50">{S.appTitle}</h1>
          {settings.useSampleState && <Badge tone="warn">サンプルデータ</Badge>}
        </div>
        <Tabs tabs={TABS} value={tab} onChange={(id) => { setIntent(null); change(id); }} className="min-w-0 flex-1 overflow-x-auto border-b-0" />
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
