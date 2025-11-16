import { useState, useEffect } from "react";
import {
  getArea,
  getEquipNameFromEugenId,
  getMapsInArea,
  getShipNameFromEugenId,
} from "./utils/poiAPIWrapper";
import {
  fetchEnemyFromKCNav,
  fetchMapFromKCNav,
} from "./utils/KCNavAPIWrapper";

/* @ts-ignore */
import { wiki } from "@kancolle/data";

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
  const [trigger, setTrigger] = useState<boolean>(false);

  useEffect(() => {
    const fetchData = async () => {
      const enemyFleets = await fetchEnemyFromKCNav(area, map, node);
      setEnemyFleets(enemyFleets);
      const fetchedNodes = await fetchMapFromKCNav(area, map);
      setNodes(fetchedNodes);
    };
    fetchData();
  }, [trigger]);

  const areas = getArea(state);
  const maps = getMapsInArea(state, area);
  const [nodes, setNodes] = useState<string[]>([]);

  return (
    <div className="flex flex-col gap-4 bg-white text-gray-600 p-4 rounded shadow-inner shadow-gray-300 text-xs">
      <div className="flex flex-row gap-2 items-center flex-wrap">
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
          {nodes.map((nodeStr) => (
            <option key={nodeStr} value={nodeStr}>
              {nodeStr}
            </option>
          ))}
        </select>
      </div>
      <button
        className="px-4 py-1 bg-gray-500 text-white rounded-full shadow hover:bg-gray-600 transition-colors duration-200"
        onClick={() => setTrigger(!trigger)}
      >
        Load
      </button>
    </div>
  );
};

const AddShipButton = ({
  index,
  setEnemyFleets,
}: {
  index: number;
  setEnemyFleets: React.Dispatch<
    React.SetStateAction<EnemyFleet[] | undefined>
  >;
}) => {
  // console.log(wiki.enemy);
  const enemyOptions: [Ship, string][] = Object.values(wiki.enemy)
    .map((enemy: any) => {
      return [
        {
          eugenId: enemy._api_id,
          shipTypeId: enemy._type,
          status: {
            hp: enemy._hp,
            firepower: enemy._firepower,
            armor: enemy._armor,
          },
          equips: [],
        },
        enemy._japanese_name,
      ] as [Ship, string];
    })
    .toSorted((a, b) => (a[0].eugenId < b[0].eugenId ? -1 : 1));
  return (
    <button className="p-2 bg-white shadow-inner overflow-hidden rounded w-full text-xs text-gray-600">
      <select
        className=""
        value={"敵艦を追加"}
        onChange={(e) => {
          const selectedEugenId = parseInt(e.target.value, 10);
          const selectedShip = enemyOptions.find(
            (enemy) => enemy[0].eugenId === selectedEugenId
          );
          if (selectedShip) {
            setEnemyFleets((prev) => {
              if (!prev) return prev;
              return prev.map((fleet, i) => {
                if (i !== index) {
                  return fleet;
                }
                return {
                  ...fleet,
                  ships: [...fleet.ships, selectedShip[0]],
                };
              });
            });
          }
        }}
      >
        <option value="敵艦を追加">敵艦を追加</option>
        {enemyOptions.map((enemy) => (
          <option key={enemy[0].eugenId} value={enemy[0].eugenId}>
            {enemy[1]}
          </option>
        ))}
      </select>
    </button>
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
    return i === index ? "bg-gray-500" : "bg-gray-300";
  };

  const fleet = enemyFleets
    ? enemyFleets[index]
    : {
        area: 0,
        map: 0,
        node: "",
        probability: 0,
        ships: [],
        formation: undefined,
      };

  return (
    <div className="flex flex-col gap-2 group">
      <ul className="flex flex-row place-content-center items-center">
        <li className="flex items-center">
          <button
            className="p-1 transition-transform duration-150 hover:scale-125 active:scale-95"
            onClick={() =>
              setIndex(
                (index - 1 + (enemyFleets?.length ?? 1)) %
                  (enemyFleets?.length ?? 1)
              )
            }
          >
            <div className="w-2 h-2 rounded-xs rotate-45 border-l-2 border-l-gray-500 border-b-2 border-b-gray-500"></div>
          </button>
        </li>
        {enemyFleets?.map((_: EnemyFleet, i: number) => (
          <li key={i} className="flex items-center">
            <button
              className={`p-1 transition-all duration-150 hover:scale-125 active:scale-95`}
              onClick={() => setIndex(i)}
            >
              <div className={` w-2 h-2 rounded-full ${buttonColor(i)}`}></div>
            </button>
          </li>
        ))}
        <li className="flex items-center">
          <button
            className="p-1 transition-transform duration-150 hover:scale-125 active:scale-95"
            onClick={() => setIndex((index + 1) % (enemyFleets?.length ?? 1))}
          >
            <div className="w-2 h-2 rounded-xs rotate-45 border-r-2 border-r-gray-500 border-t-2 border-t-gray-500"></div>
          </button>
        </li>
      </ul>
      <div
        key={index}
        className="flex flex-col gap-2 bg-gray-200 p-2 w-64 rounded transition-all duration-200 active:scale-[0.98] group-active:scale-[0.98]"
      >
        <InputMap setEnemyFleets={setEnemyFleets} state={state} />
        <div className="p-2 text-gray-600">
          敵艦隊 {index + 1} (確率:
          {((fleet?.probability ?? 0) * 100).toFixed(1)}%)
        </div>
        <FleetDisplay fleet={fleet!} state={state} />
        <AddShipButton index={index} setEnemyFleets={setEnemyFleets} />
      </div>
    </div>
  );
};

const FleetDisplay = ({ fleet, state }: { fleet: Fleet; state: any }) => {
  return (
    <ul className="flex flex-col gap-2">
      {fleet.ships.map((ship: any, shipIndex: number) => (
        <li
          key={shipIndex}
          className="bg-white p-2 rounded shadow transition-all duration-200 hover:shadow-lg hover:scale-[1.02]"
        >
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
              {ship.equips.map((equip: Equipment, equipIndex: number) => (
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
