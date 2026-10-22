import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Formation, NightPolicy } from "@sim-core";
import { getDataApi } from "../../data/api";
import { useMapData, useMapList } from "../../data/useMapData";
import { FORMATION_NAME } from "../../data/routing";
import { Button, Card, Checkbox, EmptyState, Field, NumberInput, ProgressBar, Select, S, useToast } from "../../ui";
import { runSortieInWorker } from "../../sim/client";
import type { SimHandle } from "../../sim/client";
import { buildSortieInput, flagNames, hasStartRules, selectNodes, startNodes } from "../../sim/sortieAdapter";
import type { SortieSettings } from "../../sim/sortieAdapter";
import { makeApplyEstimates } from "../../estimate/estimate";
import { estimatesForSimulation } from "../../estimate/store";
import type { SortieSummary } from "@sim-core";
import { useIntentFor } from "../nav";
import { useApp } from "../context";
import { BundleBanner, DataError } from "../DataState";
import { usePresets } from "../fleet/presets";
import { SortieResults } from "./SortieResults";
import type { SortieRunMeta } from "./SortieResults";

const NIGHT_LABEL: Record<NightPolicy, string> = {
  never: "夜戦しない",
  bossOnly: "ボスのみ夜戦",
  always: "全戦闘で夜戦",
  ifNotSRank: "S勝利でなければ夜戦",
  ifNotARank: "A勝利でなければ夜戦",
};
const FORMATIONS: Formation[] = ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast", "vanguard"];
const DIFF = ["通常", "丁", "丙", "乙", "甲"];
const COUNTS = [1_000, 5_000, 10_000, 50_000, 100_000];
const BATTLE_TYPES = ["battle", "boss", "night_battle", "air_battle", "air_raid"];

export const SortieSim = () => {
  const { catalog } = useApp();
  const toast = useToast();
  const { presets } = usePresets();

  const intent = useIntentFor("sim");
  const [presetId, setPresetId] = useState(intent?.presetId ?? "");
  const [mapKey, setMapKey] = useState(intent?.map ?? "1-5");
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [start, setStart] = useState("");
  const [selects, setSelects] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<number | undefined>();
  const [gaugeNo, setGaugeNo] = useState<number | undefined>();
  const [night, setNight] = useState<NightPolicy>("bossOnly");
  const [onHeavy, setOnHeavy] = useState(true);
  const [allowDamecon, setAllowDamecon] = useState(true);
  const [onModerate, setOnModerate] = useState(false);
  const [formations, setFormations] = useState<Record<string, Formation>>({});
  const [gaugeKind, setGaugeKind] = useState<"none" | "kill" | "hp">("none");
  const [remaining, setRemaining] = useState(4);
  const [finalSetKey, setFinalSetKey] = useState("");
  const [count, setCount] = useState(10_000);
  const [seed, setSeed] = useState(12345);
  const [applyFit, setApplyFit] = useState(true);

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [run, setRun] = useState<SortieRunMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<SimHandle<SortieSummary> | null>(null);

  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  useEffect(() => {
    if (!presetId && presets[0]) setPresetId(presets[0].id);
  }, [presets, presetId]);

  const maps = useMapList();
  const mapOptions = (maps.data?.maps ?? []).filter((m) => m.routing);
  const data = useMapData(mapKey);
  const md = data.data;
  const routing = md?.detail.routing ?? null;

  // 海域が変わったら設定をリセット
  const starts = useMemo(() => startNodes(routing), [routing]);
  const autoStart = useMemo(() => hasStartRules(routing), [routing]);
  const selNodes = useMemo(() => selectNodes(routing), [routing]);
  const flagList = useMemo(() => flagNames(routing), [routing]);
  useEffect(() => {
    setStart(hasStartRules(routing) ? "" : starts[0]);
    setSelects({});
    setFlags({});
    setFormations({});
    setPhase(routing?.defaults && (routing.defaults as { phase?: number }).phase);
    setGaugeNo(undefined);
    setFinalSetKey("");
  }, [routing]); // eslint-disable-line react-hooks/exhaustive-deps

  const diffs = useMemo(() => {
    const all = new Set<number>();
    Object.values(md?.comps ?? {}).forEach((sets) => sets.forEach((s) => all.add(s.difficulty)));
    return [...all].sort();
  }, [md]);
  const diff = difficulty !== null && diffs.includes(difficulty) ? difficulty : (diffs[diffs.length - 1] ?? 0);

  const bossLetter = md?.detail.nodes.find((n) => n.isBoss)?.letter;
  const bossSets = (bossLetter && md?.comps[bossLetter]) || [];
  const battleNodes = (md?.detail.nodes ?? []).filter((n) => BATTLE_TYPES.includes(n.type ?? "") && md?.comps[n.letter]?.length);

  const running = progress !== null;
  const canRun = !!preset && preset.ships.length > 0 && !!routing && !running;

  const execute = async () => {
    if (!preset || !md) return;
    setError(null);
    setProgress({ done: 0, total: count });
    const t0 = performance.now();
    try {
      let fit;
      if (applyFit) {
        try {
          fit = (await getDataApi().fitBonuses()).data;
        } catch {
          toast.push("装備ボーナスを取得できず、差し引かずに実行します", "info");
        }
      }
      const finalSet = gaugeKind === "hp" && finalSetKey ? bossSets.find((s) => `${s.difficulty}:${s.retrievedAt}` === finalSetKey) : undefined;
      const st: SortieSettings = {
        start: start || undefined, selects, flags, difficulty: diff, phase, gauge: gaugeNo, night,
        retreat: { onHeavy, allowDamecon, onModerate },
        formations,
        gaugeInput: gaugeKind === "none" ? undefined : { kind: gaugeKind, remaining, finalSet },
        hqLevel: preset.hqLevel ?? 120,
        applyFit,
      };
      // 設定で有効なら推定タブの推定値 (n ≥ 30) を API の値より優先する
      const est = estimatesForSimulation();
      const build = buildSortieInput(preset, catalog.master, md, st, { fitBonuses: fit, apply: est && makeApplyEstimates(est.results) });
      const notes: string[] = [];
      if (est) {
        const ids = new Set(build.enemyBuilds.flatMap((b) => b.reliability.map((r) => r.shipId)));
        const used = est.results.filter((r) => ids.has(r.shipId));
        notes.push(
          used.length > 0
            ? `推定タブの推定値 (${new Date(est.at).toLocaleString()}、n ≥ 30) を ${new Set(used.map((r) => r.shipId)).size} 隻・${used.length} 項目に使用 (API の値より優先)`
            : "推定値を使う設定ですが、この海域の敵艦には n ≥ 30 の推定値がありません"
        );
      }
      const { gauge, ...bare } = build.input;
      const h = runSortieInWorker(
        { input: bare, count, seed, ...(gauge ? { gaugeInput: build.input } : {}) },
        (done, total) => setProgress({ done, total })
      );
      handle.current = h;
      const summary = await h.promise;
      setRun({
        data: md, summary, friendNames: build.friend.input.map((s) => s.name ?? `#${s.id}`),
        warnings: [...notes, ...build.warnings], uncertain: build.uncertain, compSets: build.compSets, ms: performance.now() - t0, seed,
      });
    } catch (e) {
      if ((e as Error).message !== "cancelled") setError((e as Error).message);
    } finally {
      handle.current = null;
      setProgress(null);
    }
  };

  if (maps.error && !md) return <DataError error={maps.error} />;

  return (
    <div className="flex flex-col gap-4">
      {md?.source === "bundle" && <BundleBanner generatedAt={md.generatedAt} />}
      <Card title="出撃設定" bodyClassName="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Field label="味方艦隊" className="col-span-2">
          <Select value={preset?.id ?? ""} onChange={(e) => setPresetId(e.target.value)} disabled={presets.length === 0}>
            {presets.length === 0 && <option value="">プリセットなし (艦隊編成タブで作成)</option>}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.ships.length}隻)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="海域" className="col-span-2">
          <Select value={mapKey} onChange={(e) => setMapKey(e.target.value)}>
            {mapOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {m.key} {m.name}
                {m.routing && m.routing.uncertainCount > 0 ? ` (不確実 ${m.routing.uncertainCount})` : ""}
              </option>
            ))}
            {mapOptions.length === 0 && <option value={mapKey}>{mapKey}</option>}
          </Select>
        </Field>
        {diffs.length > 1 && (
          <Field label="難易度">
            <Select value={diff} onChange={(e) => setDifficulty(Number(e.target.value))}>
              {diffs.map((d) => (
                <option key={d} value={d}>
                  {DIFF[d] ?? d}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {starts.length > 1 && (
          <Field label="出撃地点">
            <Select value={start} onChange={(e) => setStart(e.target.value)}>
              {autoStart && <option value="">自動 (規則)</option>}
              {starts.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {Object.entries(selNodes).map(([node, options]) => (
          <Field key={node} label={`能動分岐 ${node}`}>
            <Select value={selects[node] ?? routing?.defaults?.select?.[node] ?? options[0]} onChange={(e) => setSelects((s) => ({ ...s, [node]: e.target.value }))}>
              {options.map((o) => (
                <option key={o} value={o}>
                  → {o}
                </option>
              ))}
            </Select>
          </Field>
        ))}
        <Field label="夜戦">
          <Select value={night} onChange={(e) => setNight(e.target.value as NightPolicy)}>
            {(Object.keys(NIGHT_LABEL) as NightPolicy[]).map((k) => (
              <option key={k} value={k}>
                {NIGHT_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>

        <div className="col-span-2 flex flex-col gap-1.5 md:col-span-2">
          <span className="text-[13px] font-medium text-ink-200">撤退条件</span>
          <Checkbox label="大破撤退" title="旗艦大破は常に撤退" checked={onHeavy} onChange={(e) => setOnHeavy(e.target.checked)} />
          <Checkbox label="ダメコン持ちの大破は継続" checked={allowDamecon} onChange={(e) => setAllowDamecon(e.target.checked)} disabled={!onHeavy} />
          <Checkbox label="中破撤退" checked={onModerate} onChange={(e) => setOnModerate(e.target.checked)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-200">計算</span>
          <Checkbox label="装備ボーナスを考慮" checked={applyFit} onChange={(e) => setApplyFit(e.target.checked)} />
        </div>

        {flagList.length > 0 && (
          <div className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink-200">フラグ (ギミック)</span>
            {flagList.map((f) => (
              <Checkbox key={f.name} label={`${f.name}${f.default ? " (既定: 有効)" : ""}`} checked={flags[f.name] ?? f.default} onChange={(e) => setFlags((x) => ({ ...x, [f.name]: e.target.checked }))} />
            ))}
          </div>
        )}

        <Field label="ゲージ">
          <Select value={gaugeKind} onChange={(e) => setGaugeKind(e.target.value as typeof gaugeKind)}>
            <option value="none">指定なし</option>
            <option value="kill">撃破数ゲージ</option>
            <option value="hp">HPゲージ</option>
          </Select>
        </Field>
        {gaugeKind !== "none" && (
          <Field label={gaugeKind === "kill" ? "残り撃破数" : "残りHP"}>
            <NumberInput min={1} max={99999} value={remaining} onChange={setRemaining} />
          </Field>
        )}
        {gaugeKind === "hp" && bossSets.length > 1 && (
          <Field label="最終形態の編成セット" className="col-span-2">
            <Select value={finalSetKey} onChange={(e) => setFinalSetKey(e.target.value)}>
              <option value="">ボスマスの編成と同じ</option>
              {bossSets.map((s) => (
                <option key={`${s.difficulty}:${s.retrievedAt}`} value={`${s.difficulty}:${s.retrievedAt}`}>
                  {DIFF[s.difficulty]} / {s.periodStart ?? "?"}〜 ({s.totalCount.toLocaleString()}回)
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="出撃回数" className="col-span-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <NumberInput className="w-24" min={1} max={500_000} value={count} onChange={setCount} />
            {COUNTS.map((c) => (
              <Button key={c} size="sm" variant={c === count ? "primary" : "secondary"} onClick={() => setCount(c)}>
                {c >= 1000 ? `${c / 1000}k` : c}
              </Button>
            ))}
          </div>
        </Field>
        <details className="col-span-2 md:col-span-4 xl:col-span-6">
          <summary className="cursor-pointer text-sm text-ink-300">詳細設定</summary>
          {battleNodes.length > 0 && <p className="mt-2 text-xs text-ink-400">ノード別の陣形「自動」: 潜水艦のみなら単横陣、それ以外は単縦陣</p>}
          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {battleNodes.map((n) => (
              <Field key={n.letter} label={`ノード ${n.letter}`}>
                <Select
                  value={formations[n.letter] ?? ""}
                  onChange={(e) =>
                    setFormations((f) => {
                      const { [n.letter]: _drop, ...rest } = f;
                      return e.target.value ? { ...rest, [n.letter]: e.target.value as Formation } : rest;
                    })
                  }
                >
                  <option value="">自動</option>
                  {FORMATIONS.map((f, i) => (
                    <option key={f} value={f}>
                      {FORMATION_NAME[i + 1]}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
            {battleNodes.length > 0 && (
              <>
                <Field label="フェーズ">
                  <NumberInput min={1} max={20} value={phase ?? 1} onChange={setPhase} />
                </Field>
                <Field label="ゲージ番号">
                  <NumberInput min={1} max={20} value={gaugeNo ?? 1} onChange={setGaugeNo} />
                </Field>
              </>
            )}
            <Field label="乱数シード">
              <div className="flex items-center gap-1.5">
                <NumberInput className="w-full" min={0} max={2 ** 31} value={seed} onChange={setSeed} />
                <Button size="sm" onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))} title="ランダムなシード">
                  ⟳
                </Button>
              </div>
            </Field>
          </div>
        </details>

        <div className="col-span-2 flex items-end gap-3 md:col-span-4 xl:col-span-6">
          {running ? (
            <>
              <Button variant="danger" onClick={() => handle.current?.cancel()}>
                キャンセル
              </Button>
              <div className="flex-1">
                <ProgressBar value={progress?.done ?? 0} max={progress?.total ?? 1} tone="accent" className="h-2.5" />
                <div className="mt-1 text-xs text-ink-300 tabular-nums">
                  {(progress?.done ?? 0).toLocaleString()} / {(progress?.total ?? 0).toLocaleString()} 出撃
                </div>
              </div>
            </>
          ) : (
            <Button variant="primary" size="lg" disabled={!canRun || data.loading} onClick={() => void execute()}>
              実行
            </Button>
          )}
          {data.loading && <span className="text-sm text-ink-400">{S.common.loading}</span>}
          {data.error && <span className="text-sm text-danger-400">{data.error.message}</span>}
          {md && !routing && <span className="text-sm text-warn-400">この海域のルーティングは未登録です</span>}
          {error && <span className="text-sm text-danger-400">エラー: {error}</span>}
        </div>
      </Card>

      {run ? (
        <SortieResults run={run} />
      ) : (
        !running && <EmptyState title="結果はまだありません" description="設定を選んで実行すると、到達率・撤退・クリアまでの出撃回数などを表示します。" className="py-16" />
      )}
    </div>
  );
};
