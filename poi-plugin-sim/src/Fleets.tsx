import { useState, useEffect } from "react";
import {
  getArea,
  getEquipNameFromEugenId,
  getMapsInArea,
  getShipNameFromEugenId,
} from "./utils/poiAPIWrapper";
import { fetchEnemyFromKCNav } from "./utils/KCNavAPIWrapper";

interface FleetsProps {
  fleets: Fleet[];
  state: any;
}

export const Fleets = ({ fleets, state }: FleetsProps) => {
  return (
    <ul className="flex flex-row gap-4">
      {fleets.map((fleet: Fleet, index: number) => (
        <li key={index} className="bg-gray-200 p-2 w-64 rounded">
          <h2 className="p-2 text-gray-600">Fleet {index + 1}</h2>
          <FleetDisplay fleet={fleet} state={state} />
        </li>
      ))}
    </ul>
  );
};

const InputMap = ({
  setEnemyFleets,
  state,
}: {
  setEnemyFleets: React.Dispatch<
    React.SetStateAction<EnemyFleet[] | undefined>
  >;
  state: any;
}) => {
  const [area, setArea] = useState<number>(1);
  const [map, setMap] = useState<number>(1);
  const [node, setNode] = useState<string>("A");

  useEffect(() => {
    const fetchData = async () => {
      const enemyFleets = await fetchEnemyFromKCNav(area, map, node);
      setEnemyFleets(enemyFleets);
    };
    fetchData();
  }, [area, map, node]);
  const areas = getArea(state);
  const maps = getMapsInArea(state, area);

  return (
    <div className="bg-white text-gray-600 p-4 rounded shadow-inner shadow-gray-300 flex flex-row gap-2 items-center flex-wrap text-xs">
      <select
        value={area}
        onChange={(e) => setArea(parseInt(e.target.value, 10))}
        className="mr-2"
      >
        {areas.map((areaObj) => (
          <option key={areaObj.id} value={areaObj.id}>
            {areaObj.name} ({areaObj.id})
          </option>
        ))}
      </select>
      <select
        value={map}
        onChange={(e) => setMap(parseInt(e.target.value, 10))}
      >
        {maps.map((mapObj) => (
          <option key={mapObj.id} value={mapObj.id}>
            {mapObj.name} ({mapObj.id})
          </option>
        ))}
      </select>
      <select value={node} onChange={(e) => setNode(e.target.value)}>
        {["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((nodeStr) => (
          <option key={nodeStr} value={nodeStr}>
            {nodeStr}
          </option>
        ))}
      </select>
    </div>
  );
};

interface EnemyFleetsProps {
  enemyFleets: EnemyFleet[] | undefined;
  setEnemyFleets: React.Dispatch<
    React.SetStateAction<EnemyFleet[] | undefined>
  >;
  state: any;
}

export const EnemyFleets = ({
  enemyFleets,
  setEnemyFleets,
  state,
}: EnemyFleetsProps) => {
  const [index, setIndex] = useState(0);

  const buttonColor = (i: number) => {
    return i === index
      ? "bg-gray-200 text-gray-600"
      : "bg-gray-300 text-gray-400";
  };

  const fleet = enemyFleets
    ? enemyFleets[index]
    : { area: 0, map: 0, node: "", probability: 0, ships: [] };

  return (
    <>
      <div className="flex flex-col">
        <ul className="flex flex-row gap-1">
          {enemyFleets?.map((_: EnemyFleet, index: number) => (
            <li key={index}>
              <button
                className={`px-4 py-1 rounded-t-md text-sm ${buttonColor(
                  index
                )}`}
                onClick={() => setIndex(index)}
              >
                {index + 1}
              </button>
            </li>
          ))}
        </ul>
        <div
          key={index}
          className="flex flex-col gap-2 bg-gray-200 p-2 w-64 rounded"
        >
          <InputMap setEnemyFleets={setEnemyFleets} state={state} />
          <div className="p-2 text-gray-600">
            敵艦隊 {index + 1} (確率:{" "}
            {((fleet?.probability ?? 0) * 100).toFixed(1)}%)
          </div>
          <FleetDisplay fleet={fleet!} state={state} />
        </div>
      </div>
    </>
  );
};

const FleetDisplay = ({ fleet, state }: { fleet: Fleet; state: any }) => {
  return (
    <ul>
      {fleet.ships.map((ship: any, shipIndex: number) => (
        <li key={shipIndex} className="bg-white p-2 rounded shadow mb-2">
          <div className="group">
            <div className="px-1 text-md">
              {getShipNameFromEugenId(ship.eugenId, state)}
            </div>
            <div className="flex flex-row gap-1 text-xs text-gray-600 p-1 rounded">
              <div>耐久 {ship.status.hp}</div>
              <div>火力 {ship.status.firepower}</div>
              <div>装甲 {ship.status.armor}</div>
            </div>
            <ul
              className="
              flex flex-col gap-1 text-xs text-gray-600 bg-gray-200 rounded
              overflow-hidden max-h-0 opacity-0
              transition-all ease-in-out duration-500
              group-hover:max-h-96 group-hover:opacity-100 group-hover:p-2"
            >
              {ship.equips.map((equip: Equip, equipIndex: number) => (
                <li key={equipIndex}>
                  <div className="flex flex-row justify-between">
                    <div>{getEquipNameFromEugenId(equip.eugenId, state)}</div>
                    <div>火力 +{equip.status.firepower}</div>
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
