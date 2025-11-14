// 艦隊全体の情報を表す型
export interface Fleet {
  ships: Ship[];
}

// 艦娘の情報を表す型
export interface Ship {
  eugenId: number; // 艦娘の名前ごとの固有ID
  shipTypeId: number; // 艦種ID
  status: ShipStatus;
  equips: Equip[];
}

// 艦娘のステータスを表す型
export interface ShipStatus {
  hp: number; // 耐久
  firepower: number; // 火力
  armor: number; // 装甲
}

// 装備の情報を表す型
export interface Equip {
  eugenId: number; // 装備の名前ごとの固有ID
  equipTypeId: number; // 装備種別ID
  status: EquipStatus;
}

// 装備のステータスを表す型
export interface EquipStatus {
  firepower: number; // 火力
}
