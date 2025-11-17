/* @ts-ignore */
import { wiki } from "@kancolle/data";
import {
  getShipConstFromEugenId,
  getEquipConstFromEugenId,
  equipsFetcher,
} from "./poiAPIWrapper";

export const enemyList = (state: any): Ship[] => {
  const enemyOptions: Ship[] = Object.values(wiki.enemy)
    .map((enemy: any) => {
      const data = getShipConstFromEugenId(enemy._api_id, state);
      if (!data) return null;
      return {
        eugenId: enemy._api_id,
        name: enemy._japanese_name,
        shipTypeId: enemy._type,
        shipTypeName: data.api_stype,
        status: {
          nowHp: enemy._hp,
          maxHp: enemy._hp,
          firepower: enemy._firepower,
          armor: enemy._armor,
          torpedo: enemy._torpedo,
          evasion: enemy._evasion,
          antiAircraft: enemy._aa,
          airplaneSlots: undefined,
          antiSubmarineWarfare: enemy._asw,
          speed: enemy._speed,
          scouting: undefined,
          range: ["none", "short", "medium", "long", "very_long"][
            enemy._range
          ] as unknown as Range,
          luck: enemy._luck,
          condition: 49,
        },
        equips: [],
      };
    })
    .filter((ship) => ship !== null)
    .toSorted((a, b) => (a.eugenId < b.eugenId ? -1 : 1));
  return enemyOptions;
};

export const completeEnemyStatusFromKanColleData = (
  ship: Ship,
  state: any
): Ship => {
  const enemyDataFromWiki = wiki.enemy[ship.eugenId];
  const shipConstData = getShipConstFromEugenId(ship.eugenId, state);
  const updatedStatus: ShipStatus = {
    ...ship.status,
    evasion: enemyDataFromWiki?._evasion,
    airplaneSlots: enemyDataFromWiki?._slots,
    antiSubmarineWarfare: enemyDataFromWiki?._asw,
    speed: enemyDataFromWiki?._speed,
    scouting: enemyDataFromWiki?._scouting,
    range: ["none", "short", "medium", "long", "very_long"][
      enemyDataFromWiki?._range
    ] as unknown as Range,
  };
  const updatedEquips: Equipment[] = equipsFetcher(
    ship.equips.map((e) => e.eugenId),
    state
  );
  return {
    ...ship,
    shipTypeId: enemyDataFromWiki?._type,
    shipTypeName: shipConstData ? shipConstData.api_stype : undefined,
    status: updatedStatus,
    equips: updatedEquips,
  };
};
