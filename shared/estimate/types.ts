/** 敵艦の隠しステータス推定器の公開型 (private notes ESTIMATOR)。 */
import type { AttackQuery } from "../../sim-core/pkg/sim_core";
import type { AttackEvent, CapturedBattle, HitKind } from "../capture/types";
import type { Confidence } from "../data/types";

/** 推定するステータス (API の `estimates.stat`)。acc は sim-core の `hiddenAccuracy`。 */
export type EstimatedStat = "ev" | "acc" | "luck";
export const ESTIMATED_STATS: readonly EstimatedStat[] = ["ev", "acc", "luck"];

/**
 * - `evasion`: 敵艦が被弾側 (味方の攻撃)。敵の回避と運 (√(2·運)) が効く。
 * - `accuracy`: 敵艦が攻撃側 (味方への攻撃)。敵の命中 (hiddenAccuracy) と運 (1.5√運) が効く。
 */
export type ObservationRole = "evasion" | "accuracy";

/** 推定に使える 1 回の命中判定。 */
export interface Observation {
  /** 推定対象の敵艦 master id */
  shipId: number;
  role: ObservationRole;
  /** 正規化済みの問い合わせ。対象艦の evasion / luck / hiddenAccuracy はグリッドで上書きされる。 */
  query: AttackQuery;
  outcome: HitKind;
  battleId: string;
  seq: number;
}

/** 戦闘またはイベントを推定に使わなかった理由。 */
export type SkipReason =
  /** 航空戦 stage3 (miss が記録されない) */
  | "air"
  /** かばう (.1) が付いた攻撃 */
  | "protected"
  /** モデルが曖昧な特殊攻撃 (空母カットイン、特殊砲撃、駆逐カットインなど) */
  | "cutin"
  /** 連合艦隊・夜昼戦・航空戦マスなど sim-core の対象外の戦闘 */
  | "unsupportedBattle"
  /** 艦隊スナップショットや味方艦のマスターが無い */
  | "friendData"
  /** 敵艦のマスター・陣形・交戦形態が分からない */
  | "enemyData"
  /** 攻撃側か防御側が見つからない・撃沈済み */
  | "inconsistent"
  /** 味方同士 / 敵同士のイベント (ありえないはず) */
  | "sameSide";

export type SkipCounts = Partial<Record<SkipReason, number>>;

export interface BattleRecord {
  battle: CapturedBattle;
  /** seq 順 */
  events: AttackEvent[];
}

/** 事前分布の出どころ。 */
export interface PriorInfo {
  /** API の estimates.source (例: "kancolle-replay-shipdata")。値が無いときは "flat"。 */
  source: string;
  confidence: Confidence | "none";
  value: number | null;
  /** グリッド上の事前分布の標準偏差 (平坦なら一様分布の sd) */
  sd: number;
}

export interface EstimateResult {
  shipId: number;
  stat: EstimatedStat;
  /** 事後平均 */
  mean: number;
  /** 事後標準偏差 */
  sd: number;
  /** 等裾 90% 信用区間 (グリッド上の 5% / 95% 分位点) */
  ci90: [number, number];
  /** この値に効いた命中判定の数 (ev: 被弾側, acc: 攻撃側, luck: 両方) */
  n: number;
  /** 事前分布の出どころ。`prior.source` と同じ。 */
  priorSource: string;
  prior: PriorInfo;
  /** 事前・事後の周辺分布 (推定直後のみ。保存した結果には含めない) */
  density?: Density;
}

/** グリッド上の周辺分布 (値 = min + i·step、確率の和 1)。 */
export interface Density {
  min: number;
  step: number;
  posterior: number[];
  prior: number[];
}
