export const getFleets = (state: any) => {
  const fleets: Fleet[] = state.info.fleets.map((fleet: any) =>
    fleetInfoFetcher(fleet, state)
  );

  return fleets;
};

// wasmに送るための数字あるいは直和型だけのデータ構造たち

// storeのfleetデータを整形してFleet型に変換する関数
const fleetInfoFetcher = (fleet: any, state: any): Fleet => {
  return {
    ships: fleet.api_ship
      .filter((shipId: number) => shipId !== -1) // 配備されていないスロットを除外
      .map((shipId: number) => shipInfoFetcher(shipId, state)),
    formation: undefined,
  };
};

// storeのshipデータを整形、定数リストと照合してShip型に変換する関数
const shipInfoFetcher = (shipId: number, state: any): Ship => {
  // storeから所持艦娘のデータと定数データを取得
  const allShipData = state.info.ships;
  const shipConstData = state.const.$ships;
  const shipTypeConstData = state.const.$shipTypes;

  const eugenId = allShipData[shipId].api_ship_id;
  const name = getShipNameFromEugenId(eugenId, state);
  const shipTypeId = shipConstData[eugenId].api_stype;
  const shipTypeName = shipTypeConstData[shipTypeId].api_name;

  const status: ShipStatus = shipStatusFetcher(allShipData[shipId]);

  const equipSlots = allShipData[shipId].api_slot;
  const equips: Equipment[] = equipsFetcher(equipSlots, state);

  return {
    eugenId,
    name,
    shipTypeId,
    shipTypeName,
    status,
    equips,
  };
};

const shipStatusFetcher = (shipData: any): ShipStatus => {
  return {
    hp: shipData.api_nowhp,
    firepower: shipData.api_karyoku[0],
    armor: shipData.api_soukou[0],
  };
};

const equipsFetcher = (equipSlots: number[], state: any): Equipment[] => {
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

export const getShipNameFromEugenId = (eugenId: number, state: any): string => {
  return state.const.$ships[eugenId]?.api_name || "不明な艦船";
};

export const getShipTypeNameFromId = (
  shipTypeId: number,
  state: any
): string => {
  return state.const.$shipTypes[shipTypeId]?.api_name || "不明な艦種";
};

export const getEquipNameFromEugenId = (
  eugenId: number,
  state: any
): string => {
  return state.const.$equips[eugenId]?.api_name || "不明な装備";
};

export const getArea = (state: any): { id: number; name: string }[] => {
  const area = Object.values(state.const.$mapareas).map((area: any) => ({
    id: area.api_id,
    name: area.api_name,
  }));
  return area;
};

export const getMapsInArea = (
  state: any,
  areaId: number
): { id: number; name: string }[] => {
  return Object.values(state.const.$maps)
    .filter((map: any) => map.api_maparea_id === areaId)
    .map((map: any) => ({ id: map.api_no, name: map.api_name }));
};

export const shipTypeGroupMap: {
  [key: number]: {
    shipTypeGroupId: number;
    shipTypeGroupName: string;
    shipTypeName: string;
  };
} = {
  1: {
    shipTypeGroupId: 1,
    shipTypeGroupName: "海防艦",
    shipTypeName: "海防艦",
  },
  2: {
    shipTypeGroupId: 2,
    shipTypeGroupName: "駆逐艦",
    shipTypeName: "駆逐艦",
  },
  3: {
    shipTypeGroupId: 3,
    shipTypeGroupName: "軽巡級",
    shipTypeName: "軽巡洋艦",
  },
  4: {
    shipTypeGroupId: 3,
    shipTypeGroupName: "軽巡級",
    shipTypeName: "重雷装巡洋艦",
  },
  5: {
    shipTypeGroupId: 4,
    shipTypeGroupName: "重巡級",
    shipTypeName: "重巡洋艦",
  },
  6: {
    shipTypeGroupId: 4,
    shipTypeGroupName: "重巡級",
    shipTypeName: "航空巡洋艦",
  },
  7: {
    shipTypeGroupId: 5,
    shipTypeGroupName: "航空母艦",
    shipTypeName: "軽空母",
  },
  8: {
    shipTypeGroupId: 6,
    shipTypeGroupName: "戦艦",
    shipTypeName: "高速戦艦",
  },
  9: {
    shipTypeGroupId: 6,
    shipTypeGroupName: "戦艦",
    shipTypeName: "低速戦艦",
  },
  10: {
    shipTypeGroupId: 6,
    shipTypeGroupName: "戦艦",
    shipTypeName: "航空戦艦",
  },
  11: {
    shipTypeGroupId: 5,
    shipTypeGroupName: "航空母艦",
    shipTypeName: "正規空母",
  },
  12: {
    shipTypeGroupId: 6,
    shipTypeGroupName: "戦艦",
    shipTypeName: "超弩級戦艦",
  },
  13: {
    shipTypeGroupId: 7,
    shipTypeGroupName: "潜水艦",
    shipTypeName: "潜水艦",
  },
  14: {
    shipTypeGroupId: 7,
    shipTypeGroupName: "潜水艦",
    shipTypeName: "潜水空母",
  },
  15: {
    shipTypeGroupId: 8,
    shipTypeGroupName: "補助艦艇",
    shipTypeName: "補給艦",
  },
  16: {
    shipTypeGroupId: 8,
    shipTypeGroupName: "補助艦艇",
    shipTypeName: "水上機母艦",
  },
  17: {
    shipTypeGroupId: 8,
    shipTypeGroupName: "補助艦艇",
    shipTypeName: "揚陸艦",
  },
  18: {
    shipTypeGroupId: 5,
    shipTypeGroupName: "航空母艦",
    shipTypeName: "装甲空母",
  },
  19: {
    shipTypeGroupId: 8,
    shipTypeGroupName: "補助艦艇",
    shipTypeName: "工作艦",
  },
  20: {
    shipTypeGroupId: 8,
    shipTypeGroupName: "補助艦艇",
    shipTypeName: "潜水母艦",
  },
  21: {
    shipTypeGroupId: 3,
    shipTypeGroupName: "軽巡級",
    shipTypeName: "練習巡洋艦",
  },
  22: {
    shipTypeGroupId: 8,
    shipTypeGroupName: "補助艦艇",
    shipTypeName: "補給艦",
  },
};
