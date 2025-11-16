// reduxのstateを読み込むための型
interface StateProps {
  state: any;
}

// 艦隊全体の情報を表す型
interface Fleet {
  ships: Ship[];
}

// 艦娘の情報を表す型
interface Ship {
  eugenId: number; // 艦娘の名前ごとの固有ID
  shipTypeId: number; // 艦種ID
  status: ShipStatus;
  equips: Equip[];
}

// 艦娘のステータスを表す型
interface ShipStatus {
  hp: number; // 耐久
  firepower: number; // 火力
  armor: number; // 装甲
}

// 装備の情報を表す型
interface Equip {
  eugenId: number; // 装備の名前ごとの固有ID
  equipTypeId: number; // 装備種別ID
  status: EquipStatus;
}

// 装備のステータスを表す型
interface EquipStatus {
  firepower: number; // 火力
}

interface BattleResult {
  result: 0 | 1 | 2 | 3 | 4 | 5 | 6; // SS:0, S:1, A:2, B:3, C:4, D:5 E:6
  friendFleetResults: ShipResult[];
  enemyIndex: number;
  enemyFleetResults: ShipResult[];
}
interface ShipResult {
  hpBefore: number;
  hpAfter: number;
}

interface EnemyFleet {
  area: number;
  map: number;
  node: string;
  probability: number;
  ships: Ship[];
}
