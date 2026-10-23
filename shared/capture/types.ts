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
  /**
   * cellId の文字列。ノード名 (A, B…) はクライアントでは解決しない: サーバが edges (edge_id = 行き先の
   * cell 番号) から引く (docs/API.md §3)。古い記録には解決済みの名前が入っていることがある。
   */
  node: string;
  difficulty: number | null;
  eventId: number | null;
  eventKind: number | null;
  /** 出撃開始からのノード通し番号 */
  step: number;
  /** この出撃の CapturedSortie.id。古い記録・出撃開始を取り逃した場合は無い */
  sortieId?: string;
  /** 出撃時の api_cell_data の api_no 一覧 (海域レイアウト)。不明なら無い */
  layout?: number[];
}

/** api_req_map/start・next で到達したマス。 */
export interface CapturedCell {
  /** api_no */
  no: number;
  /** api_from_no (送られてくる場合のみ) */
  from: number | null;
  colorNo: number | null;
  eventId: number | null;
  eventKind: number | null;
  /** api_bosscell_no */
  bossCellNo: number | null;
  /** api_next: 0 なら行き止まり (終端マス) */
  next: number | null;
  /** 能動分岐の選択肢 (api_select_route.api_select_cells) */
  selectCells: number[] | null;
  /** このマスの戦闘 (CapturedBattle.id、記録順) */
  battles: string[];
  /** このマスの戦闘結果 (api_req_sortie|combined_battle/battleresult)。結果を見ていなければ無い */
  result?: CapturedCellResult;
}

/** ドロップ艦 (battleresult の api_get_ship)。 */
export interface CapturedDrop {
  /** api_ship_id (艦の master id) */
  shipId: number;
  /** api_ship_name */
  name?: string;
}

/**
 * 艦隊司令部施設 (FCF) による離脱: battleresult の api_escape。idx は出撃時の艦隊の並び (本隊 1-6 → 護衛 7-12) の
 * 1 始まりの位置。shipIds はそれを出撃時の艦隊スナップショットで引いた master id。
 */
export interface CapturedEscape {
  /** api_escape_idx: 撤退できる (大破した) 艦 */
  idx: number[];
  /** api_tow_idx: 付き添う護衛艦 */
  towIdx: number[];
  shipIds: number[];
  towShipIds: number[];
  /** api_escape_type (単艦: 1 遊撃部隊 FCF, 2 ETS-CF)。無ければ null */
  type: number | null;
  /** goback_port まで見た = 実際にこのマスの後で撤退した */
  retreated: boolean;
}

export interface CapturedCellResult {
  /** api_win_rank ("S" "A" "B" "C" "D" "E") */
  rank: string | null;
  drop: CapturedDrop | null;
  /** api_get_useitem */
  useItem?: { id: number; name?: string };
  /** api_get_eventitem */
  eventItems?: { type: number; id: number; value: number }[];
  /** api_escape_flag (1 なら離脱可能) */
  escapeFlag: number;
  escape?: CapturedEscape;
}

/** 出撃時のマップのゲージ状態 (poi の info.maps / api_get_member/mapinfo の 1 要素)。値はゲームの値のまま。 */
export interface CapturedGauge {
  /** api_gauge_num: 多段ゲージの何本目か */
  gaugeNum: number | null;
  /** api_gauge_type */
  gaugeType: number | null;
  /** api_now_maphp / api_max_maphp (イベント海域) */
  nowHp: number | null;
  maxHp: number | null;
  /** api_eventmap.api_state */
  state: number | null;
  /** api_eventmap.api_selected_rank */
  rank: number | null;
  /** api_cleared (通常海域) */
  cleared: number | null;
  /** api_defeat_count (撃破回数が要る通常海域) */
  defeatCount: number | null;
}

/** api_req_map/start の api_cell_data の 1 要素。 */
export interface CapturedCellData {
  no: number;
  colorNo: number | null;
  passed: number | null;
  distance: number | null;
}

/** boss: ボスマスで終了 / end_node: 行き止まりで終了 / retreat: 途中で帰投 / unknown: 終わりを見ていない */
export type SortieEnd = "boss" | "end_node" | "retreat" | "unknown";

/** 出撃時の艦隊の特徴 (ルート分岐の条件分析用)。 */
export interface SortieFleetFeatures {
  /** 艦種 (api_stype)。艦隊の並び順 */
  stypes: number[];
  escortStypes?: number[];
  /** 艦隊速力 (最も遅い艦) */
  speed: number | null;
  /** 判定式(33) 分岐点係数 1-4 */
  los: { cn1: number; cn2: number; cn3: number; cn4: number } | null;
  hqLevel: number | null;
}

export interface CapturedSortie {
  id: string;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** null は出撃中 */
  endKind: SortieEnd | null;
  map: string;
  area: number;
  mapNo: number;
  difficulty: number | null;
  /** api_req_map/start の api_deck_id */
  deckId: number;
  /** 本隊の艦数。7 隻の第 3 艦隊 = 遊撃部隊。古い記録には無い */
  fleetSize?: number | null;
  /** 随伴艦隊の艦数 (連合艦隊でなければ 0)。古い記録には無い */
  escortSize?: number;
  /** 出撃時のゲージ状態。取れなければ null、古い記録には無い */
  gauge?: CapturedGauge | null;
  /** 母港の api_combined_flag (0 通常, 1 機動, 2 水上, 3 輸送)。不明なら null */
  combined: number | null;
  cellData: CapturedCellData[] | null;
  cells: CapturedCell[];
  fleet: CapturedFleet | null;
  features: SortieFleetFeatures | null;
  /**
   * api_req_map/start・next の応答 (api_data) を到達順に。サーバが cells / cellData をここから導き直す。
   * 古い記録には無い。
   */
  packets?: MapPacket[];
  /** 1=未アップロード, 0=済 */
  pending: 0 | 1;
}

export interface MapPacket {
  path: "api_req_map/start" | "api_req_map/next";
  body: unknown;
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
