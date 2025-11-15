import React, { Dispatch, SetStateAction, useEffect, useState } from "react";
import { connect } from "react-redux";
import { Temporal } from "@js-temporal/polyfill";

import { getShipNameFromEugenId } from "./utils/poiAPIWrapper";

interface OwnProps {
  enemy: EnemyFleet[] | undefined;
  setEnemy: Dispatch<SetStateAction<EnemyFleet[] | undefined>>;
}

type Props = StateProps & OwnProps;

const UnconnectedInteractiveEnemyEditor = ({
  state,
  enemy,
  setEnemy,
}: Props) => {
  const [area, setArea] = useState<number>(1);
  const [map, setMap] = useState<number>(1);
  const [stage, setStage] = useState<string>("A");

  useEffect(() => {
    const fetchData = async () => {
      const enemyFleets = await fetchEnemyFromKCNav(area, map, stage);
      setEnemy(enemyFleets);
    };
    fetchData();
  }, [area, map, stage]);

  return (
    <div className="bg-white p-4 rounded shadow">
      <h2 className="text-xl mb-4">敵艦隊エディター</h2>
      <div>
        <span className="mr-2">海域:</span>
        <input
          className="border p-1 mr-2 w-12"
          type="number"
          value={area}
          onChange={(e) => setArea(parseInt(e.target.value, 10))}
        ></input>
        <span>-</span>
        <input
          className="border p-1 mr-2 w-12"
          type="number"
          value={map}
          onChange={(e) => setMap(parseInt(e.target.value, 10))}
        ></input>
        <input
          className="border p-1 mr-2 w-12"
          type="text"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
        ></input>
      </div>
      <ul>
        {enemy?.map((fleet: EnemyFleet, index: number) => (
          <li key={index} className="mt-4">
            <ul className="flex flex-col gap-2 bg-gray-200 rounded p-2 w-64">
              {fleet.ships.map((ship: Ship, shipIndex: number) => (
                <li
                  key={shipIndex}
                  className="flex flex-row justify-between items-center bg-white p-2 rounded shadow"
                >
                  <div>
                    <div className="text-lg mb-2">
                      {getShipNameFromEugenId(ship.eugenId, state)}
                    </div>
                    <div className="flex flex-row text-sm text-gray-600 gap-1">
                      <div>耐久 {ship.status.hp}</div>
                      <div>火力 {ship.status.firepower}</div>
                      <div>装甲 {ship.status.armor}</div>
                    </div>
                  </div>
                  <button
                    className="bg-gray-400 w-5 h-5 rounded-full"
                    onClick={() =>
                      removeEnemyShip(index, shipIndex, enemy, setEnemy)
                    }
                  ></button>
                </li>
              ))}
              <li className="bg-gray-100 rounded p-2 text-sm text-gray-600">
                <select
                  value={"Select Enemy Ships"}
                  onChange={(e) =>
                    addEnemyShip(e, index, enemy, setEnemy, state)
                  }
                >
                  <option>Select Enemy Ship</option>
                  {Object.entries(state.const.$ships)
                    .filter(
                      ([eugenId, _]) =>
                        // Add your filter condition here
                        parseInt(eugenId) > 1500
                    )
                    .map(([eugenId, shipConst]: [string, any]) => (
                      <option key={eugenId} value={eugenId}>
                        {shipConst.api_name}
                      </option>
                    ))}
                </select>
              </li>
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
};

const addEnemyShip = (
  e: React.ChangeEvent<HTMLSelectElement>,
  index: number,
  enemyFleets: EnemyFleet[] | undefined,
  setEnemyFleets: React.Dispatch<
    React.SetStateAction<EnemyFleet[] | undefined>
  >,
  state: any
) => {
  const selectedEugenId = parseInt(e.target.value, 10);
  const shipConstData = state.const.$ships;
  const shipTypeId = shipConstData[selectedEugenId].api_stype;

  const newShip: Ship = {
    eugenId: selectedEugenId,
    shipTypeId,
    status: {
      hp: 20,
      firepower: 30,
      armor: 10,
    },
    equips: [],
  };

  const newEnemyFleet = enemyFleets
    ? enemyFleets[index]
    : {
        area: 0,
        map: 0,
        node: "A",
        probability: 1,
        ships: [],
      };

  newEnemyFleet.ships = [...newEnemyFleet.ships, newShip];

  const newEnemyFleets = enemyFleets ? [...enemyFleets] : [];
  newEnemyFleets[index] = newEnemyFleet;

  setEnemyFleets(newEnemyFleets);
};

const removeEnemyShip = (
  fleetIndex: number,
  shipIndex: number,
  enemyFleet: EnemyFleet[] | undefined,
  setEnemyFleet: React.Dispatch<React.SetStateAction<EnemyFleet[] | undefined>>
) => {
  if (enemyFleet) {
    const newShips = enemyFleet[fleetIndex].ships.filter(
      (_, index) => index !== shipIndex
    );
    const newEnemyFleet = [...enemyFleet];
    newEnemyFleet[fleetIndex] = {
      ...newEnemyFleet[fleetIndex],
      ships: newShips,
    };
    setEnemyFleet(newEnemyFleet);
  }
};

const mapStateToProps = (state: any): StateProps => ({
  state,
});

// 4. connect関数の型引数にOwnPropsを追加します
export const InteractiveEnemyEditor = connect<StateProps, {}, OwnProps>(
  mapStateToProps
)(UnconnectedInteractiveEnemyEditor);

const fetchEnemyFromKCNav = async (
  area: number,
  map: number,
  stage: string
) => {
  const date = Temporal.Now.plainDateISO().subtract({ months: 1 }).toString();
  const response = await fetch(
    `https://tsunkit.net/api/routing/maps/${area}-${map}/nodes/${stage}/enemycomps?start=${date}`
  );
  const data = await response?.json();
  const entries = data.result.entries;
  const totalCount = entries.reduce(
    (sum: number, entry: any) => sum + entry.count,
    0
  );
  const enemyFleets = entries.map((entry: any) => {
    return {
      area,
      map,
      node: stage,
      probability: entry.count / totalCount,
      ships: entry.mainFleet.map((enemy: any) => ({
        eugenId: enemy.id,
        shipTypeId: 0, // You may want to fetch or calculate the shipTypeId based on eugenId
        status: {
          hp: enemy.hp,
          firepower: enemy.fp,
          armor: enemy.armor,
        },
        equips: enemy.equips
          .filter((id: number) => id !== -1)
          .map((id: number) => ({
            eugenId: id,
            equipTypeId: 0, // You may want to fetch or calculate the equipTypeId based on eugenId
            status: { firepower: 0 }, // You may want to fill in actual equip status
          })),
      })),
    };
  });
  return enemyFleets;
};
