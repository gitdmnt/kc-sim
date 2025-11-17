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
      .filter((instanceId: number) => instanceId !== -1) // 配備されていないスロットを除外
      .map((instanceId: number) => shipInfoFetcher(instanceId, state)),
    formation: undefined,
  };
};

// storeのshipデータを整形、定数リストと照合してShip型に変換する関数
const shipInfoFetcher = (instanceId: number, state: any): Ship => {
  // storeから所持艦娘のデータと定数データを取得
  const allShipData = state.info.ships;
  const shipConstData = state.const.$ships;
  const shipTypeConstData = state.const.$shipTypes;

  const id = allShipData[instanceId].api_ship_id;
  const name = getShipNameFromId(id, state);
  const shipTypeId = shipConstData[id].api_stype;
  const shipTypeName = shipTypeConstData[shipTypeId].api_name;

  const status: ShipStatus = shipStatusFetcher(allShipData[instanceId]);

  const equipSlots = allShipData[instanceId].api_slot.map(
    (instanceId: number) => state.info.equips[instanceId]?.api_slotitem_id ?? -1
  );
  const equips: Equipment[] = equipsFetcher(equipSlots, state);

  return {
    id,
    name,
    shipTypeId,
    shipTypeName,
    status,
    equips,
  };
};

const shipStatusFetcher = (shipData: any): ShipStatus => {
  const range = ["none", "short", "medium", "long", "very_long"][
    shipData.api_leng
  ];
  return {
    maxHp: shipData.api_maxhp ?? 0,
    nowHp: shipData.api_nowhp ?? 0,
    firepower: shipData.api_karyoku[0] ?? 0,
    armor: shipData.api_soukou[0] ?? 0,
    torpedo: shipData.api_raisou[0] ?? 0,
    evasion: shipData.api_kaihi[0] ?? 0,
    antiAircraft: shipData.api_taiku[0] ?? 0,
    airplaneSlots: [...shipData.api_onslot!],
    antiSubmarineWarfare: shipData.api_taisen[0] ?? 0,
    speed: shipData.api_soku ?? 0,
    scouting: shipData.api_sakuteki[0] ?? 0,
    range: range as unknown as Range,
    luck: shipData.api_lucky[0] ?? 0,
    condition: shipData.api_cond ?? 49,
  };
};

export const equipsFetcher = (
  equipSlots: number[],
  state: any
): Equipment[] => {
  return equipSlots
    .filter((equipId: number) => equipId !== -1) // 装備がないスロットを除外
    .map((id) => {
      const e = getEquipConstFromId(id, state);
      if (!e) {
        return {
          id,
          name: "不明な装備",
          equipTypeId: undefined,
          status: undefined,
        };
      }
      const name = e ? e.api_name : "不明な装備";
      const eTypeId = e ? e.api_type : undefined;
      const equipStatus: EquipmentStatus = {
        firepower: e.api_houg ?? 0,
        armor: e.api_souk ?? 0,
        torpedo: e.api_raig ?? 0,
        bombing: e.api_baku ?? 0,
        aircraftCost: e.api_cost ?? 0,
        aircraftRange: e.api_distance ?? 0,
        evasion: e.api_kaihi ?? 0,
        aiming: e.api_meich ?? 0,
        range: e.api_range ?? ("none" as unknown as Range),
        scouting: e.api_sakuteki ?? 0,
        speed: e.api_soku ?? 0,
        antiSubmarineWarfare: e.api_tais ?? 0,
        antiAircraft: e.api_taiku ?? 0,
      };
      return {
        id,
        name: name,
        equipTypeId: eTypeId,
        status: equipStatus,
      };
    });
};

export const getShipConstFromId = (shipId: number, state: any): any => {
  return state.const.$ships[shipId];
};

export const getShipNameFromId = (shipId: number, state: any): string => {
  return state.const.$ships[shipId]?.api_name || "不明な艦船";
};

export const getShipTypeNameFromId = (
  shipTypeId: number,
  state: any
): string => {
  return state.const.$shipTypes[shipTypeId]?.api_name || "不明な艦種";
};

export const getEquipConstFromId = (equipId: number, state: any): any => {
  return state.const.$equips[equipId];
};

export const getEquipNameFromId = (equipId: number, state: any): string => {
  return state.const.$equips[equipId]?.api_name || "不明な装備";
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
