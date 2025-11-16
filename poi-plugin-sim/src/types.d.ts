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
  eugenId: number; // 艦娘の名前ごとの固有ID
  name: string;
  shipTypeId: number; // 艦種ID
  shipTypeName: string;
  status: ShipStatus;
  equips: Equipment[];
}

// 艦娘のステータスを表す型
interface ShipStatus {
  hp: number; // 耐久
  firepower: number; // 火力
  armor: number; // 装甲
}

// 装備の情報を表す型
interface Equipment {
  eugenId: number; // 装備の名前ごとの固有ID
  equipTypeId: number; // 装備種別ID
  status: EquipmentStatus;
}

// 装備のステータスを表す型
interface EquipmentStatus {
  firepower: number; // 火力
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
