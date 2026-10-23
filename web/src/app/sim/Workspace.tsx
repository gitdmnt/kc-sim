import React, { useEffect, useMemo, useState } from "react";
import { Play, SlidersHorizontal, Square } from "lucide-react";
import type { FitEntry } from "@shared/sim/fit";
import { STORAGE_PREFIX } from "../../fleet";
import type { Preset, PresetFleetType } from "../../fleet";
import { abyssalName } from "../../data/names";
import { useMapData, useMapList } from "../../data/useMapData";
import { pickSet } from "../../sim/sortieAdapter";
import type { SortieSettings } from "../../sim/sortieAdapter";
import { Button, EmptyState, Popover, Select, Tabs, S, cx } from "../../ui";
import type { TabItem } from "../../ui";
import { useApp } from "../context";
import { DataError } from "../DataState";
import { AirBasePanel } from "../fleet/AirBasePanel";
import { FleetPanel } from "../fleet/FleetPanel";
import { PresetMenu } from "../fleet/PresetMenu";
import { usePresets } from "../fleet/presets";
import { useIntentFor } from "../nav";
import { updateSettings, useSettings } from "../settings";
import { BattleRates, BattleResults } from "./BattleResults";
import { Conditions, DIFF, defaultMapConfig, fmtCount } from "./Conditions";
import type { MapConfig } from "./Conditions";
import { usePrefs } from "./prefs";
import type { SimMode } from "./prefs";
import { battleRequest, loadFitBonuses, sortieRequest } from "./requests";
import type { SimOutcome } from "./requests";
import { SortieRates, SortieResults } from "./SortieResults";
import { useSimRun } from "./useSimRun";

/** 自動実行の回数と待ち時間。最も重い海域でも Worker の起動込みで数百 ms に収まる回数 */
const AUTO_COUNT = 10_000;
const AUTO_DELAY_MS = 300;
const BATTLE_TYPES = ["battle", "boss", "night_battle", "air_battle", "air_raid"];
const SELECTED_KEY = `${STORAGE_PREFIX}selectedPreset`;
const FLEET_TYPES = Object.keys(S.fleetTypes) as PresetFleetType[];

/** 左の列で開いている艦隊 (連合艦隊の主力 / 随伴、基地航空隊) */
type FleetTab = "main" | "escort" | "lbas";

/** 艦隊の種別を変える。通常 ⇄ 連合で陣形の系統が変わるので、その系統の既定に戻す */
const withFleetType = (p: Preset, fleetType: PresetFleetType): Preset => {
  const wasCombined = p.fleetType !== "single";
  const combined = fleetType !== "single";
  if (wasCombined === combined) return { ...p, fleetType };
  return { ...p, fleetType, formation: combined ? "combined_battle" : "line_ahead", ...(combined && !p.escort ? { escort: [] } : {}) };
};

const readSelected = (): string | null => {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
};

/**
 * 出撃タブ: 艦隊 (左、上に編成の切り替え) と結果 (右、上に海域・モード・条件・自動・実行) を 1 画面に置く。
 * 入力が変わるたびに自動で計算し直す (useSimRun)。他のタブに移っても隠すだけで状態を保つ。
 */
export const Workspace = () => {
  const { catalog, poi } = useApp();
  const settings = useSettings();
  const [prefs, setPrefs] = usePrefs();
  const mode = prefs.mode;
  const [fleetTab, setFleetTab] = useState<FleetTab>("main");

  // 海域タブからの遷移
  const intent = useIntentFor("sortie");
  useEffect(() => {
    if (!intent) return;
    setPrefs({ ...(intent.mode && { mode: intent.mode }), ...(intent.map && { map: intent.map }), ...(intent.node && { node: intent.node }) });
  }, [intent?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- プリセット ----
  const store = usePresets();
  const [selectedId, setSelectedId] = useState(readSelected);
  const select = (id: string | null) => {
    setSelectedId(id);
    try {
      if (id) localStorage.setItem(SELECTED_KEY, id);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      // ignore
    }
  };
  const preset = store.presets.find((p) => p.id === selectedId) ?? store.presets[0] ?? null;

  // ---- 海域 ----
  const maps = useMapList();
  const md = useMapData(prefs.map);
  // 海域を切り替えた直後は前の海域のデータが残っている
  const data = md.data?.key === prefs.map ? md.data : undefined;
  const routing = data?.detail.routing ?? null;
  const mapOptions = (maps.data?.maps ?? []).filter((m) => (mode === "sortie" ? m.routing : m.compSetCount > 0) || m.key === prefs.map);

  // 分岐規則 (los ルール・述語) が使う索敵の係数
  const losCns = useMemo(() => {
    const found = new Set<number>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (typeof o.cn === "number") found.add(o.cn);
      Object.values(o).forEach(walk);
    };
    walk(routing);
    return [...found].sort();
  }, [routing]);

  const diffs = useMemo(() => {
    const all = new Set<number>();
    Object.values(data?.comps ?? {}).forEach((sets) => sets.forEach((s) => all.add(s.difficulty)));
    return [...all].sort();
  }, [data]);
  const diff = prefs.difficulty !== null && diffs.includes(prefs.difficulty) ? prefs.difficulty : (diffs[diffs.length - 1] ?? 0);

  // 海域ごとの条件 (別の海域の設定は持ち越さない)
  const [cfgState, setCfgState] = useState<{ key: string; cfg: MapConfig } | null>(null);
  const defaultCfg = useMemo(() => defaultMapConfig(routing), [routing]);
  const cfg = cfgState?.key === prefs.map ? cfgState.cfg : defaultCfg;
  const setCfg = (p: Partial<MapConfig>) => setCfgState({ key: prefs.map, cfg: { ...cfg, ...p } });

  const nodes = data?.detail.nodes ?? [];
  const bossLetter = nodes.find((n) => n.isBoss)?.letter;
  const bossSets = (bossLetter && data?.comps[bossLetter]) || [];
  const battleNodes = nodes.filter((n) => BATTLE_TYPES.includes(n.type ?? "") && data?.comps[n.letter]?.length);

  // 単一マス戦闘: ノード (既定はボス) と敵編成
  const compNodes = data?.detail.enemyCompNodes ?? [];
  const node =
    prefs.node && compNodes.includes(prefs.node) ? prefs.node : bossLetter && compNodes.includes(bossLetter) ? bossLetter : compNodes[compNodes.length - 1];
  const nodeSet = node && data ? pickSet(data.comps[node] ?? [], diff)?.set : undefined;
  const compList = useMemo(() => [...(nodeSet?.comps ?? [])].sort((a, b) => b.weight - a.weight), [nodeSet]);
  const compId = cfg.compNode === node && compList.some((c) => String(c.id) === cfg.compId) ? cfg.compId : "all";
  const shipName = (id: number) => {
    const ship = data?.ships.get(id)?.ship;
    return ship ? abyssalName(ship) : catalog.shipName(id);
  };

  // ---- 計算の入力 ----
  const [fit, setFit] = useState<FitEntry[] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadFitBonuses().then((f) => alive && setFit(f));
    return () => {
      alive = false;
    };
  }, []);

  // 名前・メモの変更では計算し直さない
  const presetKey = preset ? JSON.stringify([preset.fleetType, preset.ships, preset.escort, preset.lbas, preset.formation, preset.hqLevel]) : "";
  // 出撃の目標マス (海域ごとに保存)。この海域に無いマスならボス
  const target = nodes.some((n) => n.letter === prefs.targets[prefs.map] && !n.isBoss) ? prefs.targets[prefs.map] : undefined;
  const condKey = JSON.stringify([mode, diff, cfg, node, compId, target, prefs.night, prefs.onHeavy, prefs.allowDamecon, prefs.onModerate, prefs.applyFit, prefs.battleKind, prefs.seed, settings.useEstimates]);
  const built = useMemo(() => {
    if (!preset || preset.ships.length === 0 || !data || (prefs.applyFit && fit === undefined)) return { req: null, error: null };
    const common = { fit: fit ?? null, useServerEstimates: settings.useEstimates, seed: prefs.seed };
    try {
      if (mode === "sortie") {
        if (!routing) return { req: null, error: null };
        const finalSet = cfg.gaugeKind === "hp" && cfg.finalSetKey ? bossSets.find((s) => `${s.difficulty}:${s.retrievedAt}` === cfg.finalSetKey) : undefined;
        const st: SortieSettings = {
          start: cfg.start || undefined,
          target,
          selects: cfg.selects,
          flags: cfg.flags,
          difficulty: diff,
          phase: cfg.phase,
          gauge: cfg.gaugeNo,
          night: prefs.night,
          retreat: { onHeavy: prefs.onHeavy, allowDamecon: prefs.allowDamecon, onModerate: prefs.onModerate },
          formations: cfg.formations,
          gaugeInput: cfg.gaugeKind === "none" ? undefined : { kind: cfg.gaugeKind, remaining: cfg.remaining, finalSet },
          hqLevel: preset.hqLevel ?? 120,
          applyFit: prefs.applyFit,
        };
        return { req: sortieRequest(preset, catalog.master, data, st, common), error: null };
      }
      if (!nodeSet || !node) return { req: null, error: null };
      return { req: battleRequest(preset, catalog.master, data, nodeSet, compId, { ...common, applyFit: prefs.applyFit, kind: prefs.battleKind, node }), error: null };
    } catch (e) {
      return { req: null, error: (e as Error).message };
    }
  }, [presetKey, data, fit, condKey, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const sim = useSimRun<SimOutcome>(built.req, { auto: prefs.auto, autoCount: AUTO_COUNT, delayMs: AUTO_DELAY_MS });
  const out = sim.result?.value.kind === mode ? sim.result.value : null;
  const bigRun = sim.progress !== null && sim.progress.total > AUTO_COUNT;
  const error = built.error ?? sim.error;

  const noMaster = catalog.shipOptions.length === 0;
  const loadError = (maps.error && !maps.data ? maps.error : null) ?? md.error;

  const meta = sim.result && (
    <span
      className="shrink-0 text-xs text-ink-500 tabular-nums"
      title={`seed ${sim.result.value.seed} · ${(sim.result.ms / 1000).toFixed(2)} 秒${out?.kind === "sortie" && out.data.source === "bundle" ? " · 同梱データ" : ""}`}
    >
      {sim.result.count.toLocaleString()} {sim.result.value.kind === "sortie" ? "出撃" : "戦"}
    </span>
  );

  const progress = sim.progress && (
    <span
      className="absolute inset-y-0 left-0 bg-white/25 transition-[width] duration-150"
      role="progressbar"
      aria-valuenow={sim.progress.done}
      aria-valuemax={sim.progress.total}
      style={{ width: `${(sim.progress.done / Math.max(1, sim.progress.total)) * 100}%` }}
    />
  );

  // 左から操作の順: 海域 → モード・条件 → 自動・実行。狭いときは左の操作だけが折り返し、実行は 1 行目の右端に残る
  const bar = (
    <div className="flex min-w-0 items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex shrink-0 items-center gap-1">
          <Select className="h-7! w-32" aria-label="海域" value={prefs.map} onChange={(e) => setPrefs({ map: e.target.value, node: null })}>
            {mapOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name && m.name !== m.key ? `${m.key} ${m.name}` : m.key}
              </option>
            ))}
            {mapOptions.length === 0 && <option value={prefs.map}>{prefs.map}</option>}
          </Select>
          {diffs.length > 1 && (
            <Select className="h-7! w-16" aria-label="難易度" value={diff} onChange={(e) => setPrefs({ difficulty: Number(e.target.value) })}>
              {diffs.map((d) => (
                <option key={d} value={d}>
                  {DIFF[d] ?? d}
                </option>
              ))}
            </Select>
          )}
          {mode === "sortie" && (
            <Select
              className="h-7! w-20"
              aria-label="目標マス"
              title="目標マス: ここで出撃を終え、到達・突破・S勝利をこのマスで数える (海域ごとに保存)"
              value={target ?? ""}
              onChange={(e) => setPrefs({ targets: { ...prefs.targets, [prefs.map]: e.target.value } })}
            >
              <option value="">ボス</option>
              {nodes
                .filter((n) => !n.isBoss && n.type !== "start")
                .map((n) => (
                  <option key={n.letter} value={n.letter}>
                    {n.letter}
                  </option>
                ))}
            </Select>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <Tabs<SimMode>
            className="shrink-0"
            variant="pill"
            size="sm"
            value={mode}
            onChange={(m) => setPrefs({ mode: m })}
            tabs={[
              { id: "sortie", label: "出撃" },
              { id: "battle", label: "単一戦闘" },
            ]}
          />
          {mode === "battle" && (
            <>
              <Select className="h-7! w-14 shrink-0" aria-label="ノード" value={node ?? ""} disabled={compNodes.length === 0} onChange={(e) => setPrefs({ node: e.target.value })}>
                {compNodes.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <Select
                className="h-7! w-40 min-w-20 shrink"
                aria-label="敵編成"
                value={compId}
                disabled={compList.length === 0}
                onChange={(e) => setCfg({ compId: e.target.value, compNode: node ?? "" })}
              >
                <option value="all">全 {compList.length} 編成</option>
                {compList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {(c.weight * 100).toFixed(1)}% {c.main.slice(0, 3).map((s) => shipName(s.shipId)).join("、")}
                    {c.main.length > 3 ? "…" : ""}
                  </option>
                ))}
              </Select>
            </>
          )}
          <Popover
            size="sm"
            variant="ghost"
            icon
            label={<SlidersHorizontal size={16} aria-hidden />}
            aria-label="条件"
            align="end"
            title="条件: 夜戦・撤退・ゲージ・陣形・回数"
            panelClassName={mode === "sortie" ? "w-[34rem]" : "w-[28rem]"}
          >
            <Conditions
              mode={mode}
              prefs={prefs}
              setPrefs={setPrefs}
              routing={routing}
              cfg={cfg}
              setCfg={setCfg}
              battleNodes={battleNodes}
              bossSets={bossSets}
              formation={preset?.formation ?? null}
              setFormation={(formation) => preset && store.save({ ...preset, formation })}
              combined={!!preset && preset.fleetType !== "single"}
            />
          </Popover>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1 text-xs text-ink-300" title={`入力 (編成・装備・海域・条件) を変えるたびに ${AUTO_COUNT.toLocaleString()} 回で再計算`}>
          <input type="checkbox" className="h-3.5 w-3.5 cursor-pointer accent-accent-500" checked={prefs.auto} onChange={(e) => setPrefs({ auto: e.target.checked })} />
          自動
        </label>
        {bigRun ? (
          <Button size="sm" variant="danger" className="relative w-24 overflow-hidden" onClick={sim.cancel}>
            {progress}
            <Square size={12} aria-hidden />
            中止
          </Button>
        ) : (
          <Button size="sm" variant="primary" className="relative w-24 overflow-hidden" disabled={!built.req} aria-label={`実行 ${fmtCount(prefs.count)}`} onClick={() => sim.run(prefs.count)}>
            {progress}
            <Play size={14} aria-hidden />
            {fmtCount(prefs.count)}
          </Button>
        )}
      </div>
    </div>
  );

  const combined = !!preset && preset.fleetType !== "single";
  const shownTab: FleetTab = fleetTab === "escort" && !combined ? "main" : fleetTab;
  // 隻数・出撃する隊の数を添える
  const fleetTabs: TabItem<FleetTab>[] = [
    { id: "main", label: S.fleet.main, hint: preset ? String(preset.ships.length) : undefined },
    ...(combined ? [{ id: "escort" as const, label: S.fleet.escort, hint: String(preset.escort?.length ?? 0) }] : []),
    { id: "lbas", label: S.fleet.airBases, hint: String(preset?.lbas?.filter((b) => b.mode === "sortie").length ?? 0) },
  ];

  // lg: 2 列 × (操作の行, 本体)。操作の行は列ごとに高さが違っても本体の上端が揃う。狭い画面は 編成 → 艦隊 → 操作 → 結果 の 1 列
  return (
    <div className="grid grid-cols-1 gap-2 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,11fr)_minmax(0,10fr)] lg:grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 lg:col-start-1 lg:row-start-1">
        <PresetMenu store={store} preset={preset} select={select} />
        {preset && (
          <>
            <Select
              className="h-7! w-32 shrink-0"
              aria-label={S.fleet.fleetType}
              value={preset.fleetType}
              onChange={(e) => store.save(withFleetType(preset, e.target.value as PresetFleetType))}
            >
              {FLEET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {S.fleetTypes[t]}
                </option>
              ))}
            </Select>
            <Tabs<FleetTab> className="shrink-0" variant="pill" size="sm" value={shownTab} onChange={setFleetTab} tabs={fleetTabs} />
          </>
        )}
      </div>
      <div className="grid min-w-0 lg:col-start-1 lg:row-start-2 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)]">
        {noMaster ? (
          poi.status === "waiting" ? (
            <EmptyState title={S.common.loading} />
          ) : (
            <EmptyState
              title="艦・装備のデータがありません"
              action={
                <Button variant="primary" onClick={() => updateSettings({ useSampleState: true })}>
                  {S.settings.useSample}
                </Button>
              }
            />
          )
        ) : shownTab === "lbas" && preset ? (
          <AirBasePanel store={store} preset={preset} nodes={battleNodes.map((n) => n.letter)} areaId={Number.parseInt(prefs.map, 10) || undefined} />
        ) : (
          <FleetPanel key={shownTab} store={store} preset={preset} select={select} losCns={losCns} fleet={shownTab === "escort" ? "escort" : "main"} />
        )}
      </div>

      <div className="min-w-0 lg:col-start-2 lg:row-start-1">{bar}</div>
      <section data-results className="flex min-h-0 flex-col rounded-md border border-ink-800 bg-ink-900 lg:col-start-2 lg:row-start-2">
        <div className={cx("flex min-h-0 flex-1 flex-col gap-4 px-4 py-3 transition-opacity duration-200", (sim.stale || !out) && "opacity-45")}>
          {loadError && <DataError error={loadError} />}
          {error && <p className="text-xs text-danger-400">{error}</p>}
          {out?.kind === "sortie" ? (
            <SortieResults out={out} meta={meta} />
          ) : out?.kind === "battle" ? (
            <BattleResults out={out} meta={meta} shipName={shipName} />
          ) : mode === "sortie" ? (
            <SortieRates />
          ) : (
            <BattleRates />
          )}
        </div>
      </section>
    </div>
  );
};
