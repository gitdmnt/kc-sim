import type { PresetShip } from "../fleet/types";

export type AttackPhase =
  | "opening_asw"
  | "opening_torpedo"
  | "shelling1"
  | "shelling2"
  | "shelling3"
  | "closing_torpedo"
  | "night"
  | "air";

export type HitKind = "miss" | "hit" | "crit";
export type Side = "friend" | "enemy";

export interface AttackEvent {
  /** 戦闘内の通し番号 */
  seq: number;
  phase: AttackPhase;
  attackerSide: Side;
  /** 艦隊内インデックス。連合艦隊の随伴は +6。航空攻撃は不明なので -1。 */
  attackerIdx: number;
  defenderSide: Side;
  defenderIdx: number;
  /** 昼戦: api_at_type, 夜戦: api_sp_list。雷撃・航空は null。 */
  attackType: number | null;
  hit: HitKind;
  /** かばう補正 (.1) を除いたダメージ */
  damage: number;
  /** api_damage の小数部 .1 = 旗艦をかばった攻撃 */
  protected: boolean;
  /** 表示装備 (api_si_list)。砲撃・夜戦のみ */
  displayItems?: number[];
  /** 航空: stage3 の爆撃/雷撃 */
  airKind?: "bomb" | "torpedo" | "both";
}

export interface CapturedEnemyShip {
  idx: number;
  masterId: number;
  level: number | null;
  maxHp: number | null;
  nowHp: number | null;
  slots: number[] | null;
  /** api_eParam: [火力, 雷装, 対空, 装甲] */
  params: number[] | null;
}

export interface CapturedEnemy {
  ships: CapturedEnemyShip[];
  /** 連合艦隊の随伴 (idx は 0 始まり、+6 して参照する) */
  escort: CapturedEnemyShip[];
  friendFormation: number | null;
  enemyFormation: number | null;
  /** 1 同航 2 反航 3 T有利 4 T不利 */
  engagement: number | null;
}

export interface CapturedMapInfo {
  /** "1-1" 形式。イベントは "60-1" のような area-map */
  map: string;
  area: number;
  mapNo: number;
  cellId: number;
  /** 解決できた場合のノード名 (A, B...)。無ければ cellId の文字列 */
  node: string;
  difficulty: number | null;
  eventId: number | null;
  eventKind: number | null;
  /** 出撃開始からのノード通し番号 */
  step: number;
}

/** 戦闘開始時の燃料・弾薬 (poi の api_fuel / api_bull と master の最大値)。 */
export interface ShipSupply {
  fuel: number;
  fuelMax: number;
  ammo: number;
  ammoMax: number;
}

export interface CapturedFleet {
  deckId: number;
  ships: PresetShip[];
  escort?: PresetShip[];
  /** ships と同じ並び。取得できない艦は null。古い記録には無い (推定器は出撃内の戦闘数から推定する)。 */
  supply?: (ShipSupply | null)[];
}

export interface BattleResultInfo {
  rank: string | null;
  mvp: number | null;
  dropShipId: number | null;
  raw: unknown;
}

export interface CapturedBattle {
  id: string;
  capturedAt: number;
  /** /kcsapi/ を除いたパス e.g. "api_req_sortie/battle" */
  path: string;
  /** 同一ノード内の夜戦などをまとめるためのキー */
  visitId: string;
  map: CapturedMapInfo | null;
  fleet: CapturedFleet | null;
  enemy: CapturedEnemy;
  enemyMasterIds: number[];
  result?: BattleResultInfo;
  /** 1=未アップロード, 0=済 (IndexedDB で index するため数値) */
  pending: 0 | 1;
  raw: unknown;
  postBody?: unknown;
}

export type StoredEvent = AttackEvent & {
  battleId: string;
  map: string | null;
  node: string | null;
};
