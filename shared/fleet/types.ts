/** 艦隊プリセットのデータモデル。poi / DeckBuilder / 手入力のいずれからも作れる。 */

export type PresetFormation =
  | "line_ahead"
  | "double_line"
  | "diamond"
  | "echelon"
  | "line_abreast"
  | "vanguard"
  // 連合艦隊用 (api_formation 11-14)
  | "combined_anti_sub"
  | "combined_forward"
  | "combined_diamond"
  | "combined_battle";

/** 通常艦隊、または連合艦隊 (機動部隊 / 水上部隊 / 輸送護衛部隊)。連合艦隊は ships が主力、escort が随伴。 */
export type PresetFleetType =
  | "single"
  | "carrier_task_force"
  | "surface_task_force"
  | "transport_escort";

/** 基地航空隊の行動 (poi: api_action_kind 1 出撃, 2 防空, 0 待機・その他)。シミュレーションで飛ぶのは出撃だけ */
export type AirBaseMode = "sortie" | "defense" | "standby";

/** 基地航空隊 1 隊。 */
export interface PresetAirBase {
  mode: AirBaseMode;
  /** 4 中隊。空きは null。搭載数は slotSize (既定 18、偵察機 4) */
  squadrons: (PresetEquip | null)[];
  /** 2 波の目標マス (同じマス 2 つ = 集中)。"" は未指定。海域ごとに選び直す */
  targets: [string, string];
}

export type PresetSource = "manual" | "poi" | "deckbuilder" | "import";

export interface PresetEquip {
  masterId: number;
  /** 改修値 ★0-10 (poi: api_level) */
  improvement: number;
  /** 熟練度 0-7 (poi: api_alv) */
  proficiency: number;
  /** 搭載数。不明なら undefined (poi: api_onslot) */
  slotSize?: number;
}

/** ゲーム内で実際に見えていたステータス (装備・改修込みの合計値)。 */
export interface ObservedShipStats {
  maxHp: number;
  nowHp: number;
  firepower: number;
  torpedo: number;
  antiAir: number;
  armor: number;
  evasion: number;
  asw: number;
  los: number;
  luck: number;
  /** 射程 1:短 2:中 3:長 4:超長 5:超超長 */
  range: number;
  speed: number;
}

export interface PresetShip {
  masterId: number;
  level: number;
  /** 近代化改修による上昇分 (poi: api_kyouka[4]) */
  luckMod: number;
  /** 近代化改修による耐久上昇分 (api_kyouka[5]) */
  hpMod: number;
  /** 近代化改修による対潜上昇分 (api_kyouka[6]) */
  aswMod: number;
  /** コンディション (poi: api_cond) */
  morale: number;
  /** スロット順。空きスロットは null。 */
  equips: (PresetEquip | null)[];
  /** 補強増設。無ければ null/undefined */
  exSlot?: PresetEquip | null;
  /** 実測値。poi からの取り込み時は全て入る。DeckBuilder 取り込みでは一部のみ。 */
  observed?: Partial<ObservedShipStats>;
}

export interface Preset {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  fleetType: PresetFleetType;
  formation: PresetFormation;
  ships: PresetShip[];
  /** 連合艦隊の随伴艦隊 (fleetType が single 以外のとき) */
  escort?: PresetShip[];
  /** 基地航空隊 (最大 3 隊) */
  lbas?: PresetAirBase[];
  hqLevel?: number;
  source?: PresetSource;
  note?: string;
}

// ---- poi の master data (state.const) の必要部分 ----

/** `[lv1 値, lv99 値]` の形式。艦娘マスターでは api_kaih/api_tais/api_saku が欠けることがある。 */
export interface ShipMaster {
  api_id: number;
  api_name?: string;
  api_stype?: number;
  api_ctype?: number;
  api_taik?: number[];
  api_houg?: number[];
  api_raig?: number[];
  api_tyku?: number[];
  api_souk?: number[];
  api_luck?: number[];
  api_kaih?: number[];
  api_tais?: number[];
  api_saku?: number[];
  api_leng?: number;
  api_soku?: number;
  api_maxeq?: number[];
  /** 燃料・弾薬の最大値 (推定器が出撃中の燃料を見積もるのに使う) */
  api_fuel_max?: number;
  api_bull_max?: number;
  api_slot_num?: number;
  api_yomi?: string;
  api_sort_id?: number;
}

export interface EquipMaster {
  api_id: number;
  api_name?: string;
  api_type?: number[];
  api_houg?: number;
  api_raig?: number;
  api_baku?: number;
  api_tyku?: number;
  api_souk?: number;
  api_tais?: number;
  api_houm?: number;
  api_houk?: number;
  api_saku?: number;
  api_leng?: number;
  api_sortno?: number;
  api_luck?: number;
}

export interface MasterData {
  ships: Record<number, ShipMaster | undefined>;
  equips: Record<number, EquipMaster | undefined>;
}
