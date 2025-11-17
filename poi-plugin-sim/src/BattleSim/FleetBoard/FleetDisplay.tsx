import { getShipNameFromId, getEquipNameFromId } from "@utils/poiAPIWrapper";

interface FleetDisplayProps {
  fleet: Fleet;
  state: any;
}

export const FleetDisplay = ({ fleet, state }: FleetDisplayProps) => {
  return (
    <ul className="flex flex-col gap-2">
      {fleet.ships.map((ship: Ship, shipIndex: number) => (
        <li key={shipIndex} className="card">
          <div className="">
            <div className="px-1 text-md text-gray-800">
              {getShipNameFromId(ship.id, state)}
            </div>
            <div className="flex flex-row flex-wrap gap-1 text-xs text-gray-600 p-1 rounded">
              <div>
                耐久 {ship.status.nowHp}/{ship.status.maxHp}
              </div>
              <div>火力 {ship.status.firepower}</div>
              <div>装甲 {ship.status.armor}</div>
              <div>雷装 {ship.status.torpedo}</div>
              <div>回避 {ship.status.evasion ?? 0}</div>
              <div>対空 {ship.status.antiAircraft}</div>
              <div>対潜 {ship.status.antiSubmarineWarfare ?? 0}</div>
              <div>速力 {ship.status.speed ?? 0}</div>
              <div>索敵 {ship.status.scouting ?? 0}</div>
              <div>射程 {ship.status.range?.toString() ?? "none"}</div>
              <div>運 {ship.status.luck ?? 0}</div>
            </div>
            <ul
              className="
              flex flex-col gap-1 text-xs text-gray-600 bg-gray-200 rounded
              overflow-hidden max-h-0 opacity-0
              transition-all ease-in-out duration-500
              group-hover:max-h-96 group-hover:opacity-100 group-hover:p-2"
            >
              {ship.equips.map((equip: Equipment, equipIndex: number) => (
                <li key={equipIndex}>
                  <div className="flex flex-row justify-between">
                    <div>{getEquipNameFromId(equip.id, state)}</div>
                    <div>火力 +{equip.status?.firepower}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ul>
  );
};
