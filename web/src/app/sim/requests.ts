/** 作業台の入力 → Worker で回す計算 (出撃 / 単一マス戦闘) と、その結果に付ける表示用の情報。 */
import type { BattleInput, BattleKind, SimulationSummary, SortieSummary } from "@sim-core";
import type { EnemyComp, EnemyCompSet } from "@shared/data/types";
import type { MasterData, Preset } from "@shared/fleet/types";
import {
  buildBattleInput,
  buildEnemyShips,
  buildFriendShips,
  buildSquadrons,
  enemyFormationOf,
  friendFleet,
  friendFormationOf,
  landBaseWaves,
} from "@shared/sim/adapter";
import type { FriendBuild } from "@shared/sim/adapter";
import type { FitEntry } from "@shared/sim/fit";
import { bonusAt, buildBonuses, debuffsAt } from "@shared/sim/bonuses";
import { isBalloonNode } from "@shared/sim/nodeEffects";
import type { EventBonusResponse } from "@shared/sim/bonuses";
import { DataApiError, getDataApi } from "../../data/api";
import type { MapData } from "../../data/mapData";
import { runInWorker, runSortieInWorker } from "../../sim/client";
import { allocateCounts, mergeSummaries } from "../../sim/runner";
import { buildSortieInput, enemyCombinedNote, hasEnemyEscort, mapLookup } from "../../sim/sortieAdapter";
import type { EventBonusSettings, SortieSettings } from "../../sim/sortieAdapter";
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
  /** 目標マス (主要率をこのマスで数えた)。省略はボス */
  target?: string;
  /** 敵連合艦隊を主力だけで近似したマス */
  enemyCombined: string[];
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
  /** 敵連合艦隊を主力だけで近似したマス (選んだ編成に随伴があれば そのマス) */
  enemyCombined: string[];
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

const eventBonusCache = new Map<string, Promise<EventBonusResponse | null>>();
/** 海域のイベント特効。データの無い海域 (404) は null。通信の失敗は reject (ページを開いている間、海域ごとに 1 度だけ取得)。 */
export const loadEventBonuses = (map: string): Promise<EventBonusResponse | null> => {
  let p = eventBonusCache.get(map);
  if (!p) {
    p = getDataApi()
      .eventBonuses(map)
      .then(
        (r) => r.data,
        (e) => {
          if (e instanceof DataApiError && e.status === 404) return null;
          eventBonusCache.delete(map);
          throw e;
        }
      );
    eventBonusCache.set(map, p);
  }
  return p;
};

/** 前提の欄に出す、使った特効データの説明 */
const eventBonusNote = (e: EventBonusSettings): string => {
  const r = e.response;
  const meta = [r.date, r.note].filter(Boolean).join(", ");
  return `イベント特効: ${r.source === "manual" ? "手入力データ" : "kancolle-replay"}${meta ? ` (${meta})` : ""}${e.debuff ? "、装甲破砕済み" : ""}`;
};

/** 結果の味方の並び (sim-core: 主力の後に随伴) の艦名。随伴は頭に「随伴」 */
const friendNamesOf = (f: FriendBuild): string[] => [
  ...f.input.map((s) => s.name ?? `#${s.id}`),
  ...(f.escort ?? []).map((s) => `随伴 ${s.name ?? `#${s.id}`}`),
];

interface Common {
  fit: FitEntry[] | null;
  useServerEstimates: boolean;
  seed: number;
  /** イベント特効 (無い海域・適用しないときは undefined) */
  eventBonus?: EventBonusSettings;
  /** 特効データを取得できなかった (未適用と注記する) */
  eventBonusFailed?: boolean;
}

const EVENT_MISSING = "イベント特効を取得できず未適用";

export const sortieRequest = (
  preset: Preset,
  master: MasterData,
  data: MapData,
  st: SortieSettings,
  o: Common
): SimRequest<SimOutcome> => {
  const build = buildSortieInput(preset, master, data, st, { fitBonuses: o.fit ?? undefined, useServerEstimates: o.useServerEstimates, eventBonus: o.eventBonus });
  const base = [
    ...(st.applyFit && !o.fit ? [FIT_MISSING] : []),
    ...(o.eventBonusFailed ? [EVENT_MISSING] : []),
    ...(o.eventBonus ? [eventBonusNote(o.eventBonus)] : []),
    ...build.warnings,
  ];
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
            friendNames: friendNamesOf(build.friend),
            uncertain: build.uncertain,
            target: st.target,
            compSets: build.compSets,
            enemyCombined: build.enemyCombined,
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
  o: Common & { applyFit: boolean; kind: BattleKind; node: string }
): SimRequest<SimOutcome> => {
  const chosen = [...set.comps].sort((a, b) => b.weight - a.weight).filter((c) => compId === "all" || String(c.id) === compId);
  if (chosen.length === 0) throw new Error("敵編成がありません");
  const friend = buildFriendShips(preset, master, { fitBonuses: o.fit ?? undefined, applyFit: o.applyFit });
  if (friend.input.length === 0) throw new Error("味方艦がいません");
  if (friend.combined && (friend.escort?.length ?? 0) === 0) throw new Error("随伴艦隊に艦がいません");
  const lookup = mapLookup(data);
  const builds = chosen.map((c) => buildEnemyShips(c.main, lookup, { useServerEstimates: o.useServerEstimates }));
  const fleet = friendFleet(friend, friendFormationOf(preset));
  const lbas = landBaseWaves(preset.lbas, o.node, master);
  const extras: Partial<BattleInput> = {};
  const bonusWarnings: string[] = [];
  if (o.eventBonus) {
    const e = o.eventBonus;
    // 波ごとの基地 (landBaseWaves と同じ順: 出撃の隊、目標が node の波)
    const waveBases = (preset.lbas ?? []).flatMap((b) =>
      b.mode === "sortie" && buildSquadrons(b, master).length > 0 ? b.targets.filter((t) => t === o.node).map(() => b) : []
    );
    const b = buildBonuses(preset, e.response, master, { unconfirmed: e.unconfirmed, accEva: e.accEva, lbas: waveBases });
    const ships = b.bonuses.map((x) => bonusAt(x, o.node));
    if (ships.some((x) => x)) extras.bonuses = ships;
    const escort = friend.combined ? (b.escortBonuses ?? []).map((x) => bonusAt(x, o.node)) : [];
    if (escort.some((x) => x)) extras.escortBonuses = escort;
    const bases = (b.lbasBonuses ?? []).map((x) => bonusAt(x, o.node));
    if (bases.some((x) => x)) extras.lbasBonuses = bases;
    const debuffs = e.debuff ? debuffsAt(e.response, o.node) : [];
    if (debuffs.length) extras.debuffs = debuffs;
    bonusWarnings.push(eventBonusNote(e), ...b.warnings);
  }
  const balloons = isBalloonNode(data.detail.map.world, data.detail.map.no, o.node);
  const inputs = chosen.map((c, i) => ({ ...buildBattleInput(fleet, builds[i].input, { kind: o.kind, enemyFormation: enemyFormationOf(c), lbas, balloons }), ...extras }));
  const enemyCombined = hasEnemyEscort(chosen) ? [o.node] : [];
  const assumptions: AssumptionData = {
    friend,
    enemy: builds,
    applyFit: o.applyFit,
    serverEstimates: o.useServerEstimates,
    warnings: [
      ...new Set([
        ...(o.applyFit && !o.fit ? [FIT_MISSING] : []),
        ...(o.eventBonusFailed ? [EVENT_MISSING] : []),
        ...bonusWarnings,
        ...(enemyCombined.length > 0 ? [enemyCombinedNote(enemyCombined)] : []),
        ...friend.warnings,
        ...builds.flatMap((b) => b.warnings),
      ]),
    ],
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
            friendNames: friendNamesOf(friend),
            enemyCombined,
            assumptions,
            seed: o.seed,
          };
        }),
      };
    },
  };
};
