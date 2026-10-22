/** 作業台の入力 → Worker で回す計算 (出撃 / 単一マス戦闘) と、その結果に付ける表示用の情報。 */
import type { BattleKind, SimulationSummary, SortieSummary } from "@sim-core";
import type { EnemyComp, EnemyCompSet } from "@shared/data/types";
import type { MasterData, Preset } from "@shared/fleet/types";
import { buildBattleInput, buildEnemyShips, buildFriendShips, enemyFormationOf, friendFormationOf } from "@shared/sim/adapter";
import type { FitEntry } from "@shared/sim/fit";
import { getDataApi } from "../../data/api";
import type { MapData } from "../../data/mapData";
import { runInWorker, runSortieInWorker } from "../../sim/client";
import { allocateCounts, mergeSummaries } from "../../sim/runner";
import { buildSortieInput, mapLookup } from "../../sim/sortieAdapter";
import type { SortieSettings } from "../../sim/sortieAdapter";
import type { AssumptionData } from "./Assumptions";
import type { SimRequest } from "./useSimRun";

export interface SortieOutcome {
  kind: "sortie";
  summary: SortieSummary;
  data: MapData;
  friendNames: string[];
  uncertain: Set<string>;
  /** ノード → 使った編成セット (出典表示用) */
  compSets: Record<string, EnemyCompSet>;
  assumptions: AssumptionData;
  seed: number;
}

export interface CompRun {
  comp: EnemyComp;
  count: number;
  summary: SimulationSummary;
  enemyNames: string[];
}

export interface BattleOutcome {
  kind: "battle";
  total: SimulationSummary;
  comps: CompRun[];
  friendNames: string[];
  assumptions: AssumptionData;
  seed: number;
}

export type SimOutcome = SortieOutcome | BattleOutcome;

let fitPromise: Promise<FitEntry[] | null> | undefined;
/** 装備ボーナスの定義。取得できなければ null (このページを開いている間は再取得しない)。 */
export const loadFitBonuses = (): Promise<FitEntry[] | null> =>
  (fitPromise ??= getDataApi()
    .fitBonuses()
    .then(
      (r) => r.data,
      () => null
    ));

const FIT_MISSING = "装備ボーナスを取得できず未適用";

interface Common {
  fit: FitEntry[] | null;
  useServerEstimates: boolean;
  seed: number;
}

export const sortieRequest = (
  preset: Preset,
  master: MasterData,
  data: MapData,
  st: SortieSettings,
  o: Common
): SimRequest<SimOutcome> => {
  const build = buildSortieInput(preset, master, data, st, { fitBonuses: o.fit ?? undefined, useServerEstimates: o.useServerEstimates });
  const base = [...(st.applyFit && !o.fit ? [FIT_MISSING] : []), ...build.warnings];
  const { gauge, ...bare } = build.input;
  return {
    start: (count, onProgress) => {
      const h = runSortieInWorker({ input: bare, count, seed: o.seed, ...(gauge ? { gaugeInput: build.input } : {}) }, onProgress);
      return {
        cancel: h.cancel,
        promise: h.promise.then(
          (summary): SimOutcome => ({
            kind: "sortie",
            summary,
            data,
            friendNames: build.friend.input.map((s) => s.name ?? `#${s.id}`),
            uncertain: build.uncertain,
            compSets: build.compSets,
            assumptions: {
              friend: build.friend,
              enemy: build.enemyBuilds,
              applyFit: st.applyFit,
              serverEstimates: o.useServerEstimates,
              warnings: [...new Set([...base, ...summary.warnings])],
            },
            seed: o.seed,
          })
        ),
      };
    },
  };
};

/** 単一マス戦闘。`compId` は "all" (出現率で重み付け) か編成 ID。 */
export const battleRequest = (
  preset: Preset,
  master: MasterData,
  data: MapData,
  set: EnemyCompSet,
  compId: string,
  o: Common & { applyFit: boolean; kind: BattleKind }
): SimRequest<SimOutcome> => {
  const chosen = [...set.comps].sort((a, b) => b.weight - a.weight).filter((c) => compId === "all" || String(c.id) === compId);
  if (chosen.length === 0) throw new Error("敵編成がありません");
  const friend = buildFriendShips(preset, master, { fitBonuses: o.fit ?? undefined, applyFit: o.applyFit });
  if (friend.input.length === 0) throw new Error("味方艦がいません");
  const lookup = mapLookup(data);
  const builds = chosen.map((c) => buildEnemyShips(c.main, lookup, { useServerEstimates: o.useServerEstimates }));
  const friendFormation = friendFormationOf(preset);
  const inputs = chosen.map((c, i) =>
    buildBattleInput(friend.input, builds[i].input, { kind: o.kind, friendFormation, enemyFormation: enemyFormationOf(c) })
  );
  const assumptions: AssumptionData = {
    friend,
    enemy: builds,
    applyFit: o.applyFit,
    serverEstimates: o.useServerEstimates,
    warnings: [...new Set([...(o.applyFit && !o.fit ? [FIT_MISSING] : []), ...friend.warnings, ...builds.flatMap((b) => b.warnings)])],
  };
  return {
    start: (count, onProgress) => {
      const counts = allocateCounts(count, chosen.map((c) => c.weight));
      const jobs = chosen
        .map((c, i) => ({ key: String(c.id), count: counts[i], seed: o.seed + i * 1_000_003, input: inputs[i] }))
        .filter((j) => j.count > 0);
      const h = runInWorker(jobs, onProgress);
      return {
        cancel: h.cancel,
        promise: h.promise.then((results): SimOutcome => {
          const byKey = new Map(results.map((r) => [r.key, r.summary]));
          const comps = chosen.flatMap((comp, i): CompRun[] => {
            const summary = byKey.get(String(comp.id));
            return summary ? [{ comp, count: counts[i], summary, enemyNames: builds[i].input.map((s) => s.name ?? `#${s.id}`) }] : [];
          });
          return {
            kind: "battle",
            total: mergeSummaries(comps.map((r) => r.summary), { skipEnemy: comps.length > 1 }),
            comps,
            friendNames: friend.input.map((s) => s.name ?? `#${s.id}`),
            assumptions,
            seed: o.seed,
          };
        }),
      };
    },
  };
};
