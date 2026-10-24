/** 作業台の入力 → Worker で回す計算 (出撃 / 単一マス戦闘) と、その結果に付ける表示用の情報。 */
import type { BattleInput, BattleKind, ShipInput, SimulationSummary, SortieSummary } from "@sim-core";
import type { EnemyComp, EnemyCompSet } from "@shared/data/types";
import type { MasterData, Preset } from "@shared/fleet/types";
import {
  buildBattleInput,
  buildEnemyFleet,
  buildFriendShips,
  buildSquadrons,
  friendFleet,
  friendFormationOf,
  landBaseWaves,
  raidBases,
} from "@shared/sim/adapter";
import type { FitEntry } from "@shared/sim/fit";
import { bonusAt, buildBonuses, debuffsAt } from "@shared/sim/bonuses";
import { isAtollNode, isBalloonNode } from "@shared/sim/nodeEffects";
import { getDataApi } from "../../data/api";
import type { MapData } from "../../data/mapData";
import { runInWorker, runSortieInWorker } from "../../sim/client";
import { allocateCounts, mergeSummaries } from "../../sim/runner";
import { buildSortieInput, extraFleet, mapLookup, supportInput } from "../../sim/sortieAdapter";
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
  /** 基地空襲の被害 (hpLostMean) の各基地の番号 (第n基地) */
  baseNumbers: number[];
  assumptions: AssumptionData;
  seed: number;
}

export interface CompRun {
  comp: EnemyComp;
  count: number;
  summary: SimulationSummary;
  /** 主力の後に随伴 (頭に「随伴」) */
  enemyNames: string[];
}

export interface BattleOutcome {
  kind: "battle";
  total: SimulationSummary;
  comps: CompRun[];
  friendNames: string[];
  /** 基地空襲の被害 (hpLostMean) の各基地の番号 (第n基地) */
  baseNumbers: number[];
  assumptions: AssumptionData;
  seed: number;
}

export type SimOutcome = SortieOutcome | BattleOutcome;

/** 装備ボーナスの定義 (boot に入っている)。取得できなければ null (その計算は未適用で回す)。 */
export const loadFitBonuses = (): Promise<FitEntry[] | null> =>
  getDataApi()
    .boot()
    .then(
      (r) => r.data.fitBonuses,
      () => null
    );

const FIT_MISSING = "装備ボーナスを取得できず未適用";

/** 前提の欄に出す、使った特効データの説明 */
const eventBonusNote = (e: EventBonusSettings): string => {
  const r = e.response;
  const meta = [r.date, r.note].filter(Boolean).join(", ");
  return `イベント特効: ${r.source === "manual" ? "手入力データ" : "kancolle-replay"}${meta ? ` (${meta})` : ""}${e.debuff ? "、装甲破砕済み" : ""}`;
};

/** 結果の並び (sim-core: 主力の後に随伴) の艦名。随伴は頭に「随伴」 */
const namesOf = (ships: ShipInput[], escort: ShipInput[] = []): string[] => [
  ...ships.map((s) => s.name ?? `#${s.id}`),
  ...escort.map((s) => `随伴 ${s.name ?? `#${s.id}`}`),
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
            friendNames: namesOf(build.friend.input, build.friend.escort),
            uncertain: build.uncertain,
            target: st.target,
            compSets: build.compSets,
            baseNumbers: build.baseNumbers,
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

/** 単一マス戦闘で足す艦隊・空襲 (Conditions の設定) */
export interface BattleExtras {
  /** 選んだマスがボス (支援は決戦支援、それ以外は道中支援) */
  boss: boolean;
  /** 支援艦隊 (道中 / 決戦)。無い枠は出さない */
  support?: SortieSettings["support"];
  /** 友軍艦隊が来る確率 (0..1)。省略は友軍なし */
  friendChance?: number;
  /** 選んだ編成が基地航空隊を空襲する */
  baseRaid?: boolean;
}

/** 単一マス戦闘。`compId` は "all" (出現率で重み付け) か編成 ID。 */
export const battleRequest = (
  preset: Preset,
  master: MasterData,
  data: MapData,
  set: EnemyCompSet,
  compId: string,
  o: Common & BattleExtras & { applyFit: boolean; kind: BattleKind; node: string }
): SimRequest<SimOutcome> => {
  const chosen = [...set.comps].sort((a, b) => b.weight - a.weight).filter((c) => compId === "all" || String(c.id) === compId);
  if (chosen.length === 0) throw new Error("敵編成がありません");
  const fitOpts = { fitBonuses: o.fit ?? undefined, applyFit: o.applyFit };
  const friend = buildFriendShips(preset, master, fitOpts);
  if (friend.input.length === 0) throw new Error("味方艦がいません");
  if (friend.combined && (friend.escort?.length ?? 0) === 0) throw new Error("随伴艦隊に艦がいません");
  const lookup = mapLookup(data);
  const enemies = chosen.map((c) => buildEnemyFleet(c, lookup, { useServerEstimates: o.useServerEstimates }));
  const fleet = friendFleet(friend, friendFormationOf(preset));
  const lbas = landBaseWaves(preset.lbas, o.node, master);
  const extras: Partial<BattleInput> = {};
  const extraWarnings: string[] = [];
  const supportOpt = o.boss ? o.support?.boss : o.support?.node;
  const support = supportOpt && supportInput(preset, o.boss ? "supportBoss" : "supportNode", supportOpt, master, fitOpts, extraWarnings);
  if (support) extras.support = { ...support, ...(o.boss ? { boss: true } : {}) };
  const ffFleet = o.friendChance !== undefined ? extraFleet(preset, "friendFleet", master, fitOpts, extraWarnings) : null;
  if (ffFleet) extras.friendFleet = { fleet: ffFleet, chance: o.friendChance };
  const raid = o.baseRaid ? raidBases(preset.lbas, master) : { bases: [], numbers: [] };
  if (o.baseRaid && raid.bases.length === 0) extraWarnings.push("基地空襲: 中隊のある基地航空隊がありません");
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
    const ff = ffFleet ? (b.friendFleetBonuses ?? []).map((x) => bonusAt(x, o.node)) : [];
    if (ff.some((x) => x)) extras.friendFleetBonuses = ff;
    const debuffs = e.debuff ? debuffsAt(e.response, o.node) : [];
    if (debuffs.length) extras.debuffs = debuffs;
    bonusWarnings.push(eventBonusNote(e), ...b.warnings);
  }
  const balloons = isBalloonNode(data.detail.map.world, data.detail.map.no, o.node);
  const atoll = isAtollNode(data.detail.map.world, data.detail.map.no, o.node);
  const inputs = enemies.map((e) => ({
    ...buildBattleInput(fleet, e.fleet, { kind: o.kind, lbas, balloons, atoll }),
    ...extras,
    ...(raid.bases.length > 0 ? { baseRaid: { enemy: e.fleet, bases: raid.bases } } : {}),
  }));
  const assumptions: AssumptionData = {
    friend,
    enemy: enemies.map((e) => e.build),
    applyFit: o.applyFit,
    serverEstimates: o.useServerEstimates,
    warnings: [
      ...new Set([
        ...(o.applyFit && !o.fit ? [FIT_MISSING] : []),
        ...(o.eventBonusFailed ? [EVENT_MISSING] : []),
        ...bonusWarnings,
        ...friend.warnings,
        ...extraWarnings,
        ...enemies.flatMap((e) => e.build.warnings),
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
            return summary ? [{ comp, count: counts[i], summary, enemyNames: namesOf(enemies[i].fleet.ships, enemies[i].fleet.escort) }] : [];
          });
          return {
            kind: "battle",
            total: mergeSummaries(comps.map((r) => r.summary), { skipEnemy: comps.length > 1 }),
            comps,
            friendNames: namesOf(friend.input, friend.escort),
            baseNumbers: raid.numbers,
            assumptions,
            seed: o.seed,
          };
        }),
      };
    },
  };
};
