// reduxのstateを読み込むための型
interface StateProps {
  state: any;
}

// 艦隊全体の情報を表す型
interface Fleet {
  ships: Ship[];
  formation: Formation;
}
interface EnemyFleet {
  area: number;
  map: number;
  node: string;
  probability: number;
  ships: Ship[];
  formation: Formation;
}

// 艦娘の情報を表す型
interface Ship {
  id: number; // 艦娘の名前ごとの固有ID
  name: string;
  shipTypeId?: number; // 艦種ID
  shipTypeName?: string; // 艦種名
  status: ShipStatus;
  equips: Equipment[];
}

// 艦娘のステータスを表す型
interface ShipStatus {
  maxHp: number; // 耐久最大値
  nowHp: number; // 耐久
  firepower: number; // 火力
  armor: number; // 装甲
  torpedo: number; // 雷装
  antiAircraft: number; // 対空
  condition: number; // コンディション
  evasion?: number; // 回避
  airplaneSlots?: number[]; // 各スロットの搭載数
  antiSubmarineWarfare?: number; // 対潜
  speed?: number; // 速力
  scouting?: number; // 索敵
  range?: Range; // 射程
  luck?: number; // 運
}

enum Range {
  None = "none",
  Short = "short",
  Medium = "medium",
  Long = "long",
  VeryLong = "very_long",
  VeryVeryLong = "very_very_long",
}

// 装備の情報を表す型
interface Equipment {
  id: number; // 装備の名前ごとの固有ID
  name?: string;
  equipTypeId?: number[]; // 装備種別ID
  status?: EquipmentStatus;
}

// 装備のステータスを表す型
interface EquipmentStatus {
  firepower: number; // 火力
  armor: number; // 装甲
  torpedo: number; // 雷装
  bombing: number; // 爆装
  aircraftCost?: number; // 航空機コスト
  aircraftRange?: number; // 航空機の航続距離 (0)
  evasion: number; // 回避 または 迎撃 (局戦の場合)
  aiming: number; // 命中 または 対爆 (局戦の場合)
  range: Range; // 射程
  scouting: number; // 索敵
  speed: number; // 速力
  antiSubmarineWarfare: number; // 対潜
  antiAircraft: number; // 対空

  /*
  api_atap: 0 // ? (0)
api_bakk: 0  // 爆撃回避 (0)
api_baku: 0 bombing: number // 爆装
api_broken: Array(4) [ 0, 16, 22, … ] // 廃棄時に得られる資源
api_cost: 0 aircraftCost?: number // 航空機コスト
api_distance: 0 aircraftRange?: number // 航空機の航続距離 (0)
api_houg: 21 firepower: number // 火力
api_houk: -1 evasion: number // 回避 または 迎撃 (局戦の場合)
api_houm: -1 aiming: number // 命中 または 対爆 (局戦の場合)
api_id: 137
api_leng: 4 range: number // 射程
api_luck: 0 // 運 (0)
api_name: "381mm/50 三連装砲改"
api_raig: 0 torpedo: number // 雷装
api_raik: 0 // 雷撃回避 (0)
api_raim: 0 // 雷撃命中 (0)
api_rare: 5 // レアリティ
api_sakb: 0 // 索敵妨害 (0)
api_saku: 0 scouting: number // 索敵
api_soku: 0 speed: number // 速力
api_sortno: 137
api_souk: 0 armor: number // 装甲
api_taik: 0 // 耐久 (0)
api_tais: 0 antiSubmarineWarfare: number // 対潜
api_tyku: 4 antiAircraft: number // 対空
api_type: Array(5) [ 1, 1, 3, … ]
api_usebull: "0" // ?
  */
}

type Formation =
  | "line_ahead"
  | "double_line"
  | "diamond"
  | "echelon"
  | "line_abreast"
  | "vanguard"
  | undefined;

interface BattleReport {
  result: BattleResult; // SS:0, S:1, A:2, B:3, C:4, D:5 E:6
  friendFleetResults: ShipSnapshot[];
  enemyIndex: number;
  enemyFleetResults: ShipSnapshot[];
}

enum BattleResult {
  SS = "SS",
  S = "S",
  A = "A",
  B = "B",
  C = "C",
  D = "D",
  E = "E",
  None = undefined,
}

interface ShipSnapshot {
  hp: number;
}
