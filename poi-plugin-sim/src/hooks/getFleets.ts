export const getFleets = (state: any) => {
  const fleets: Fleet[] = state.info.fleets.map((fleet: any) =>
    fleetInfoFetcher(fleet, state)
  );

  return fleets;
};

// wasmに送るための数字あるいは直和型だけのデータ構造たち

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

// storeのfleetデータを整形してFleet型に変換する関数
const fleetInfoFetcher = (fleet: any, state: any): Fleet => {
  return {
    ships: fleet.api_ship
      .filter((shipId: number) => shipId !== -1) // 配備されていないスロットを除外
      .map((shipId: number) => shipInfoFetcher(shipId, state)),
  };
};

// storeのshipデータを整形、定数リストと照合してShip型に変換する関数
const shipInfoFetcher = (shipId: number, state: any): Ship => {
  // storeから所持艦娘のデータと定数データを取得
  const allShipData = state.info.ships;
  const shipConstData = state.const.$ships;

  const eugenId = allShipData[shipId].api_ship_id;
  const shipTypeId = shipConstData[eugenId].api_stype;

  const status: ShipStatus = shipStatusFetcher(allShipData[shipId]);

  const equipSlots = allShipData[shipId].api_slot;
  const equips: Equip[] = equipsFetcher(equipSlots, state);

  return {
    eugenId,
    shipTypeId,
    status,
    equips,
  };
};

const shipStatusFetcher = (shipData: any): ShipStatus => {
  return {
    hp: shipData.api_nowhp,
    firepower: shipData.api_karyoku[0],
  };
};

const equipsFetcher = (equipSlots: number[], state: any): Equip[] => {
  const allEquipData = state.info.equips;
  const equipConstData = state.const.$equips;

  return equipSlots
    .filter((equipId: number) => equipId !== -1) // 装備がないスロットを除外
    .map((equipId: number) => allEquipData[equipId]) // 実際の装備データに変換
    .map((equipData: any) => {
      const eugenId = equipData.api_slotitem_id;
      const equipTypeId = equipConstData[eugenId].api_type[2]; // 装備種別IDはapi_typeの3番目の要素

      const firepower = equipConstData[eugenId].api_houg; // 火力ステータス
      return {
        eugenId,
        equipTypeId,
        status: {
          firepower,
        },
      };
    });
};
