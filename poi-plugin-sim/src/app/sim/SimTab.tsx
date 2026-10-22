import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BattleKind, SimulationSummary } from "@sim-core";
import { getDataApi } from "../../data/api";
import { useAbyssalData } from "../../data/names";
import { FORMATION_NAME } from "../../data/routing";
import type { EnemyComp, EnemyCompSet, ShipDetail } from "../../data/types";
import { useMapData, useMapList } from "../../data/useMapData";
import { Button, Card, EmptyState, Field, NumberInput, ProgressBar, Select, Tabs, S, cx, useToast } from "../../ui";
import { buildBattleInput, buildEnemyShips, buildFriendShips, enemyFormationOf, friendFormationOf } from "../../sim/adapter";
import type { EnemyBuild, FriendBuild } from "../../sim/adapter";
import { runInWorker } from "../../sim/client";
import type { SimHandle } from "../../sim/client";
import { allocateCounts, mergeSummaries } from "../../sim/runner";
import type { Job } from "../../sim/runner";
import { makeApplyEstimates } from "../../estimate/estimate";
import { estimatesForSimulation } from "../../estimate/store";
import { SortieSim } from "./SortieSim";
import { useIntentFor } from "../nav";
import { useApp } from "../context";
import { BundleBanner, DataError } from "../DataState";
import { usePresets } from "../fleet/presets";
import { Assumptions } from "./Assumptions";
import type { AssumptionData } from "./Assumptions";
import { pct } from "./bars";
import { RankCard, ShipTable } from "./results";

type Mode = "battle" | "sortie";

interface CompRun {
  comp: EnemyComp;
  count: number;
  summary: SimulationSummary;
  build: EnemyBuild;
}
interface RunResult {
  total: SimulationSummary;
  comps: CompRun[];
  friendNames: string[];
  assumptions: AssumptionData;
  ms: number;
  count: number;
  seed: number;
}

const COUNT_PRESETS = [1_000, 10_000, 100_000, 1_000_000];
// エンジンは他の戦闘種別 (空襲など) も持つが、このタブで選べるのは通常の 3 種
const KIND_LABEL = { day: "昼戦のみ", dayNight: "昼戦 → 夜戦", nightOnly: "夜戦マス" } as const;
type OfferedKind = keyof typeof KIND_LABEL;
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

const latestSet = (sets: EnemyCompSet[], difficulty: number) =>
  sets.filter((s) => s.difficulty === difficulty).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];

export const SimTab = () => {
  const intent = useIntentFor("sim");
  const [mode, setMode] = useState<Mode>(intent?.mode ?? "battle");
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        variant="pill"
        className="w-fit"
        tabs={[
          { id: "battle", label: "戦闘 (ノード単位)" },
          { id: "sortie", label: "出撃 (マップ通し)" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === "battle" ? <BattleSim /> : <SortieSim />}
    </div>
  );
};

const BattleSim = () => {
  const { catalog } = useApp();
  const toast = useToast();
  const { presets } = usePresets();

  const intent = useIntentFor("sim");
  const [presetId, setPresetId] = useState<string>(intent?.presetId ?? "");
  const [mapKey, setMapKey] = useState(intent?.map ?? "1-5");
  const [node, setNode] = useState(intent?.node ?? "J");
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [compId, setCompId] = useState<string>("all");
  const [formation, setFormation] = useState<string>("preset");
  const [kind, setKind] = useState<BattleKind>("day");
  const [count, setCount] = useState(10_000);
  const [seed, setSeed] = useState(12345);
  const [applyFit, setApplyFit] = useState(true);

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewComp, setViewComp] = useState<number | null>(null);
  const handle = useRef<SimHandle | null>(null);

  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  useEffect(() => {
    if (!presetId && presets[0]) setPresetId(presets[0].id);
  }, [presets, presetId]);

  const maps = useMapList();
  const md = useMapData(mapKey);
  const names = useAbyssalData(md.data);
  const compNodes = md.data?.detail.enemyCompNodes ?? [];
  useEffect(() => {
    if (md.data && !compNodes.includes(node)) setNode(compNodes[compNodes.length - 1] ?? "");
  }, [md.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const sets = (node && md.data?.comps[node]) || [];
  const diffs = [...new Set(sets.map((s) => s.difficulty))].sort();
  const diff = difficulty !== null && diffs.includes(difficulty) ? difficulty : diffs[diffs.length - 1];
  const set = diff !== undefined ? latestSet(sets, diff) : undefined;
  const compList = useMemo(() => [...(set?.comps ?? [])].sort((a, b) => b.weight - a.weight), [set]);

  const running = progress !== null;
  const canRun = !!preset && preset.ships.length > 0 && compList.length > 0 && !running;

  const run = async () => {
    if (!preset || !set) return;
    setError(null);
    setProgress({ done: 0, total: count });
    const t0 = performance.now();
    try {
      const chosen = compId === "all" ? compList : compList.filter((c) => String(c.id) === compId);
      if (chosen.length === 0) throw new Error("敵編成を選択してください");

      // 敵ごとの隠しステータス推定 (best) を取得
      const ids = [...new Set(chosen.flatMap((c) => [...c.main, ...c.escort].map((s) => s.shipId)))];
      // 海域データ (API または静的バンドル) に含まれる推定値を使う
      const details = new Map<number, ShipDetail>(ids.flatMap((id): [number, ShipDetail][] => (md.data?.ships.get(id) ? [[id, md.data.ships.get(id)!]] : [])));
      let fit;
      if (applyFit) {
        try {
          fit = (await getDataApi().fitBonuses()).data;
        } catch {
          toast.push("装備ボーナスを取得できず、差し引かずに実行します", "info");
        }
      }

      const friend: FriendBuild = buildFriendShips(preset, catalog.master, { fitBonuses: fit, applyFit });
      if (friend.input.length === 0) throw new Error("味方艦がいません");
      const lookup = { ship: names.shipById, equip: names.equipById, detail: (id: number) => details.get(id) };

      const counts = allocateCounts(count, chosen.map((c) => c.weight));
      const friendFormation = formation === "preset" ? friendFormationOf(preset) : (formation as ReturnType<typeof friendFormationOf>);
      // 設定で有効なら推定タブの推定値 (n ≥ 30) を API の値より優先する
      const est = estimatesForSimulation();
      const builds = chosen.map((c) => buildEnemyShips(c.main, lookup, est && makeApplyEstimates(est.results)));
      const jobs: Job[] = chosen.map((c, i) => ({
        key: String(c.id),
        count: counts[i],
        seed: seed + i * 1_000_003,
        input: buildBattleInput(friend.input, builds[i].input, { kind, friendFormation, enemyFormation: enemyFormationOf(c) }),
      }));

      const h = runInWorker(jobs.filter((j) => j.count > 0), (done, total) => setProgress({ done, total }));
      handle.current = h;
      const results = await h.promise;
      const byKey = new Map(results.map((r) => [r.key, r.summary]));
      const runs: CompRun[] = chosen
        .map((comp, i) => ({ comp, count: counts[i], build: builds[i], summary: byKey.get(String(comp.id)) }))
        .filter((r): r is CompRun => !!r.summary);
      const total = mergeSummaries(runs.map((r) => r.summary), { skipEnemy: runs.length > 1 });
      setResult({
        total,
        comps: runs,
        friendNames: friend.input.map((s) => s.name ?? `#${s.id}`),
        assumptions: { friend, enemy: runs.map((r) => r.build), applyFit, estimates: est },
        ms: performance.now() - t0,
        count,
        seed,
      });
      setViewComp(runs.length > 0 ? 0 : null);
    } catch (e) {
      if ((e as Error).message !== "cancelled") setError((e as Error).message);
    } finally {
      handle.current = null;
      setProgress(null);
    }
  };

  const cancel = () => handle.current?.cancel();

  if (maps.error && !md.data) return <DataError error={maps.error} />;

  const mapList = maps.data?.maps ?? [];
  const viewed = result && viewComp !== null ? result.comps[viewComp] : undefined;

  return (
    <div className="flex flex-col gap-4">
      {(md.data?.source === "bundle" || maps.data?.source === "bundle") && <BundleBanner generatedAt={md.data?.generatedAt} />}
      <Card title="シミュレーション設定" bodyClassName="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Field label="味方艦隊 (プリセット)" className="col-span-2">
          <Select value={preset?.id ?? ""} onChange={(e) => setPresetId(e.target.value)} disabled={presets.length === 0}>
            {presets.length === 0 && <option value="">プリセットなし (艦隊編成タブで作成)</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.ships.length}隻)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="海域" className="col-span-1">
          <Select value={mapKey} onChange={(e) => setMapKey(e.target.value)}>
            {mapList.filter((m) => m.compSetCount > 0 || m.key === mapKey).map((m) => (
              <option key={m.key} value={m.key}>
                {m.key} {m.name}
              </option>
            ))}
            {mapList.length === 0 && <option value={mapKey}>{mapKey}</option>}
          </Select>
        </Field>
        <Field label="ノード">
          <Select value={node} onChange={(e) => setNode(e.target.value)} disabled={compNodes.length === 0}>
            {compNodes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {compNodes.length === 0 && <option value="">データなし</option>}
          </Select>
        </Field>
        {diffs.length > 1 ? (
          <Field label="難易度">
            <Select value={diff} onChange={(e) => setDifficulty(Number(e.target.value))}>
              {diffs.map((d) => (
                <option key={d} value={d}>
                  {["通常", "丁", "丙", "乙", "甲"][d] ?? d}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="敵編成" className="col-span-2">
          <Select value={compId} onChange={(e) => setCompId(e.target.value)} disabled={compList.length === 0}>
            <option value="all">出現率で重み付け (全 {compList.length} 編成)</option>
            {compList.map((c) => (
              <option key={c.id} value={c.id}>
                {pct(c.weight)} — {c.main.map((s) => names.shipName(s.shipId)).slice(0, 3).join("、")}
                {c.main.length > 3 ? "…" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="味方陣形">
          <Select value={formation} onChange={(e) => setFormation(e.target.value)}>
            <option value="preset">プリセット ({preset ? S.formations[preset.formation] : "-"})</option>
            {(["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast", "vanguard"] as const).map((f, i) => (
              <option key={f} value={f}>
                {FORMATION_NAME[i + 1]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="戦闘種別">
          <Select value={kind} onChange={(e) => setKind(e.target.value as BattleKind)}>
            {(Object.keys(KIND_LABEL) as OfferedKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="試行回数" className="col-span-2">
          <div className="flex items-center gap-1.5">
            <NumberInput className="w-28" min={1} max={1_000_000} step={1} value={count} onChange={setCount} />
            {COUNT_PRESETS.map((c) => (
              <Button key={c} size="sm" variant={c === count ? "primary" : "secondary"} onClick={() => setCount(c)}>
                {c >= 1_000_000 ? "1M" : `${c / 1000}k`}
              </Button>
            ))}
          </div>
        </Field>
        <Field label="乱数シード">
          <div className="flex items-center gap-1.5">
            <NumberInput className="w-full" min={0} max={2 ** 31} value={seed} onChange={setSeed} />
            <Button size="sm" onClick={() => setSeed(randomSeed())} title="ランダムなシード">
              ⟳
            </Button>
          </div>
        </Field>
        <label className="flex items-end gap-2 pb-1.5 text-sm text-ink-100">
          <input type="checkbox" className="h-4 w-4 accent-accent-500" checked={applyFit} onChange={(e) => setApplyFit(e.target.checked)} />
          装備ボーナスを考慮
        </label>

        <div className="col-span-2 flex items-end gap-3 md:col-span-4 xl:col-span-6">
          {running ? (
            <>
              <Button variant="danger" onClick={cancel}>
                キャンセル
              </Button>
              <div className="flex-1">
                <ProgressBar value={progress?.done ?? 0} max={progress?.total ?? 1} tone="accent" className="h-2.5" />
                <div className="mt-1 text-[11px] text-ink-300 tabular-nums">
                  {(progress?.done ?? 0).toLocaleString()} / {(progress?.total ?? 0).toLocaleString()} 戦
                </div>
              </div>
            </>
          ) : (
            <Button variant="primary" disabled={!canRun} onClick={() => void run()}>
              ▶ シミュレーション実行
            </Button>
          )}
          {!running && md.loading && <span className="text-xs text-ink-400">{S.common.loading}</span>}
          {!running && !md.loading && compList.length === 0 && (
            <span className="text-xs text-warn-400">このノードの敵編成データがありません</span>
          )}
          {error && <span className="text-xs text-danger-400">エラー: {error}</span>}
        </div>
      </Card>

      {result ? (
        <>
          <div className="text-xs text-ink-300">
            {result.count.toLocaleString()} 戦 / seed {result.seed} / {(result.ms / 1000).toFixed(2)} 秒 (
            {Math.round(result.count / (result.ms / 1000)).toLocaleString()} 戦/秒)
          </div>
          <RankCard summary={result.total} />

          {result.comps.length > 1 && (
            <Card title="敵編成別" bodyClassName="p-0">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-ink-300">
                  <tr>
                    <th className="px-3 py-2">編成</th>
                    <th className="px-3 py-2 text-right">出現率</th>
                    <th className="px-3 py-2 text-right">試行</th>
                    <th className="px-3 py-2 text-right">S以上</th>
                    <th className="px-3 py-2 text-right">A以上</th>
                    <th className="px-3 py-2 text-right">旗艦撃沈</th>
                    <th className="px-3 py-2 text-right">味方撃沈あり</th>
                  </tr>
                </thead>
                <tbody>
                  {result.comps.map((r, i) => (
                    <tr
                      key={r.comp.id}
                      onClick={() => setViewComp(i)}
                      className={cx("cursor-pointer border-t border-ink-700 hover:bg-ink-700/60", i === viewComp && "bg-accent-600/15")}
                    >
                      <td className="max-w-80 truncate px-3 py-2">
                        {r.comp.main.map((s) => names.shipName(s.shipId)).join("、")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(r.comp.weight)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.count.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(r.summary.rankRates.SS + r.summary.rankRates.S)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {pct(r.summary.rankRates.SS + r.summary.rankRates.S + r.summary.rankRates.A)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(r.summary.enemyFlagshipSunkRate)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(r.summary.friendSunkAnyRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-2">
            <ShipTable
              title="味方艦隊 (全試行の合計)"
              lines={result.friendNames.map((name) => ({ name }))}
              ships={result.total.friend}
              showMvp
            />
            {viewed && (
              <ShipTable
                title={`敵艦隊${result.comps.length > 1 ? ` (選択した編成: ${pct(viewed.comp.weight)})` : ""}`}
                lines={viewed.build.input.map((s) => ({ name: s.name ?? `#${s.id}` }))}
                ships={viewed.summary.enemy}
              />
            )}
          </div>

          <Assumptions data={result.assumptions} />
        </>
      ) : (
        !running && <EmptyState title="結果はまだありません" description="設定を選んで「シミュレーション実行」を押してください。計算は Web Worker で行われ、画面は固まりません。" className="py-16" />
      )}
    </div>
  );
};
