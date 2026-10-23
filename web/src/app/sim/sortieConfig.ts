/** 出撃の追加条件 (撤退・補給・ゲージ・マスごとの進撃・マスの効果・資源) の保存形式と、SortieSettings への変換。 */
import type { Advance, ResourceAmounts, TankType } from "@sim-core";
import type { EnemyCompSet } from "@shared/data/types";
import type { PresetShip } from "@shared/fleet/types";
import type { GaugeKind, GaugePhaseSettings, NodeEffect } from "../../sim/sortieOptions";
import type { SortieSettings } from "../../sim/sortieAdapter";

/** ゲージ 1 本の設定 */
export interface PhaseConfig {
  kind: GaugeKind;
  remaining: number;
  /** HP ゲージ: 最終形態になる残り HP (空 = 最終形態の旗艦の最大 HP) */
  finalThreshold?: number;
  /** 輸送ゲージ: 戦車隊と、S 勝利 1 回の TP (空 = 編成から計算) */
  tank?: TankType;
  tpPerSortie?: number;
  /** 追加のゲージ: この本の間のルーティングの phase (空 = 1 本目の phase + 本数) */
  phase?: number;
}

export interface GaugeConfig extends Omit<PhaseConfig, "kind"> {
  kind: "none" | GaugeKind;
  /** HP ゲージ最終形態の編成セット (`難易度:取得日時`)。"" はボスマスと同じ */
  finalSetKey: string;
  /** 2 本目以降のゲージ (1 本目を削ったあと順に削る) */
  extra: PhaseConfig[];
  /** 士気を出撃間で持ち越す (待ち時間を出す) */
  morale: { enabled: boolean; waitMinutes: number; untilMorale: number };
}

/** 海域ごとに保存する出撃の条件 */
export interface SortieMapPrefs {
  gauge: GaugeConfig;
  /** マス → 撤退 / 強行。無いマスは撤退の設定に従って進撃 */
  advance: Record<string, Advance>;
  /** マス → 資源・揚陸マスの獲得量、渦潮の損失 */
  effects: Record<string, NodeEffect>;
}

export const DEFAULT_GAUGE: GaugeConfig = {
  kind: "none",
  remaining: 4,
  finalSetKey: "",
  extra: [],
  morale: { enabled: false, waitMinutes: 0, untilMorale: 40 },
};
export const DEFAULT_SORTIE_MAP: SortieMapPrefs = { gauge: DEFAULT_GAUGE, advance: {}, effects: {} };

/** 保存した海域の条件 (欠けた項目は既定値で埋める) */
export const mapPrefsOf = (maps: Record<string, Partial<SortieMapPrefs> | undefined>, map: string): SortieMapPrefs => {
  const m = maps[map];
  return { ...DEFAULT_SORTIE_MAP, ...m, gauge: { ...DEFAULT_GAUGE, ...m?.gauge } };
};

/** 海域を問わない出撃の条件 (WorkspacePrefs の一部) */
export interface SortieGlobalPrefs {
  useFcf: boolean;
  underway: boolean;
  rations: boolean;
  /** 入渠時間がこの分数を超える艦に高速修復材を使う (null は使わない) */
  bucketAboveMin: number | null;
  /** 支援艦隊などの 1 出撃あたりの費用 */
  extraPerSortie: ResourceAmounts;
  /** 連続出撃: 出撃から出撃へ士気を持ち越し、その間は回復を待つ */
  consecutive: { enabled: boolean; waitMinutes: number; untilMorale: number };
  /** 海域 → 条件 */
  sortieMaps: Record<string, SortieMapPrefs>;
}

export const DEFAULT_SORTIE_GLOBAL: SortieGlobalPrefs = {
  useFcf: true,
  underway: true,
  rations: true,
  bucketAboveMin: null,
  extraPerSortie: {},
  consecutive: { enabled: false, waitMinutes: 0, untilMorale: 40 },
  sortieMaps: {},
};

export const setKeyOf = (s: EnemyCompSet) => `${s.difficulty}:${s.retrievedAt}`;

/** 護衛退避に使う司令部施設 (旗艦の装備) */
export const FCF_EQUIPS: Record<number, { name: string; fleet: string }> = {
  107: { name: "艦隊司令部施設", fleet: "連合艦隊" },
  272: { name: "遊撃部隊 艦隊司令部", fleet: "遊撃部隊" },
  413: { name: "精鋭水雷戦隊 司令部", fleet: "水雷戦隊" },
};

/** 旗艦が積んでいる司令部施設の装備 ID (無ければ undefined) */
export const flagshipFcf = (flagship: PresetShip | undefined): number | undefined =>
  [...(flagship?.equips ?? []), flagship?.exSlot].map((e) => e?.masterId).find((id): id is number => id !== undefined && id in FCF_EQUIPS);

/** ゲージを足す (直前の本を写し、phase は自動)。1 本目が未指定なら HP ゲージにする */
export const addGauge = (g: GaugeConfig): GaugeConfig => {
  const kind = g.kind === "none" ? "hp" : g.kind;
  const last: PhaseConfig = g.extra[g.extra.length - 1] ?? { kind, remaining: g.remaining };
  return { ...g, kind, extra: [...g.extra, { ...last, phase: undefined }] };
};

/** 条件 → buildSortieInput の追加設定 (撤退・補給・ゲージ・進撃・マスの効果・資源・連続出撃) */
export const sortieOptionsOf = (
  p: SortieGlobalPrefs & { onHeavy: boolean; allowDamecon: boolean; onModerate: boolean },
  m: SortieMapPrefs,
  bossSets: EnemyCompSet[]
): Pick<SortieSettings, "retreat" | "underway" | "rations" | "gaugeInput" | "advance" | "nodeEffects" | "repair" | "extraPerSortie" | "consecutive"> => {
  const g = m.gauge;
  const finalSet = g.kind === "hp" && g.finalSetKey ? bossSets.find((s) => setKeyOf(s) === g.finalSetKey) : undefined;
  const phase = (c: PhaseConfig): GaugePhaseSettings => ({
    kind: c.kind,
    remaining: c.remaining,
    ...(c.kind === "hp" && c.finalThreshold ? { finalThreshold: c.finalThreshold } : {}),
    ...(c.kind === "tp" && c.tank ? { tank: c.tank } : {}),
    ...(c.kind === "tp" && c.tpPerSortie ? { tpPerSortie: c.tpPerSortie } : {}),
    ...(c.phase ? { phase: c.phase } : {}),
  });
  const main = g.kind === "none" ? undefined : { ...phase({ ...g, kind: g.kind }), ...(finalSet ? { finalSet } : {}) };
  return {
    retreat: { onHeavy: p.onHeavy, allowDamecon: p.allowDamecon, onModerate: p.onModerate, useFcf: p.useFcf },
    underway: p.underway,
    rations: p.rations,
    advance: m.advance,
    nodeEffects: m.effects,
    ...(main && {
      gaugeInput: {
        ...main,
        ...(g.extra.length > 0 ? { phases: [main, ...g.extra.map(phase)] } : {}),
        ...(g.morale.enabled ? { morale: { waitMinutes: g.morale.waitMinutes, untilMorale: g.morale.untilMorale } } : {}),
      },
    }),
    ...(p.bucketAboveMin !== null ? { repair: { bucketAboveSec: p.bucketAboveMin * 60 } } : {}),
    extraPerSortie: p.extraPerSortie,
    ...(p.consecutive.enabled ? { consecutive: { waitMinutes: p.consecutive.waitMinutes, untilMorale: p.consecutive.untilMorale } } : {}),
  };
};
