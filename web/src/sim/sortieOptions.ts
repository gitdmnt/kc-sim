/** 出撃シミュレーションのゲージ・マスの効果の設定 → sim-core の GaugeInput / SortieNode。 */
import type { EnemyComp as SimComp, GaugeInput, GaugeMorale, GaugePhase, Maelstrom, ResourceAmounts, SortieNode, TankType } from "@sim-core";
import type { EnemyCompSet } from "@shared/data/types";

export type GaugeKind = "kill" | "hp" | "tp";

/** ゲージ 1 本 (編成セットは呼び出し側が選んだもの、無ければボスマスの編成) */
export interface GaugePhaseSettings {
  kind: GaugeKind;
  remaining: number;
  /** HP ゲージ: 最終形態の編成と、最終形態になる残り HP */
  finalSet?: EnemyCompSet;
  finalThreshold?: number;
  /** 輸送ゲージ: 戦車隊と、S 勝利 1 回の TP (手入力) */
  tank?: TankType;
  tpPerSortie?: number;
  /** 複数ゲージの 2 本目以降: この本の間のルーティングの phase */
  phase?: number;
}

export interface GaugeSettings extends GaugePhaseSettings {
  /** 2 本以上のゲージを順に削る。あれば上の 1 本の設定より優先 */
  phases?: GaugePhaseSettings[];
  /** 士気を出撃間で持ち越す (待ち時間を出す) */
  morale?: GaugeMorale;
}

/** マスの効果 (資源・揚陸マスの獲得量、渦潮の損失)。手入力 */
export interface NodeEffect {
  resource?: ResourceAmounts;
  maelstrom?: Maelstrom;
}

/** ゲージの設定 → GaugeInput。`comps` は編成セットを sim-core の編成にする関数。 */
export const buildGauge = (g: GaugeSettings, comps: (set: EnemyCompSet) => SimComp[]): GaugeInput => {
  const one = (p: GaugePhaseSettings): GaugePhase => ({
    kind: p.kind,
    remaining: p.remaining,
    ...(p.kind === "hp" && p.finalSet ? { finalComps: comps(p.finalSet) } : {}),
    ...(p.kind === "hp" && p.finalThreshold ? { finalThreshold: p.finalThreshold } : {}),
    ...(p.kind === "tp" && p.tank ? { tank: p.tank } : {}),
    ...(p.kind === "tp" && p.tpPerSortie ? { tpPerSortie: p.tpPerSortie } : {}),
  });
  return {
    ...one(g),
    ...(g.phases?.length ? { phases: g.phases.map((p) => ({ ...one(p), ...(p.phase !== undefined ? { phase: p.phase } : {}) })) } : {}),
    ...(g.morale ? { morale: g.morale } : {}),
  };
};

/** マスの効果を海域のマスに書き込む。値の無い効果と、海域に無いマスは無視する。 */
export const applyNodeEffects = (nodes: Record<string, SortieNode>, effects: Record<string, NodeEffect>): void => {
  for (const [letter, e] of Object.entries(effects)) {
    const node = nodes[letter];
    if (!node) continue;
    if (e.resource && Object.values(e.resource).some((v) => v)) node.resource = e.resource;
    if (e.maelstrom?.rate) node.maelstrom = e.maelstrom;
  }
};
