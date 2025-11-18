import React from "react";
import { useState } from "react";

import { MapInput } from "./MapInput";
import { FleetDisplay } from "./FleetDisplay";
import { AddShipButton } from "./AddShipButton";

interface FleetsProps {
  fleets: Fleet[];
  state: any;
}

export const Fleets = ({ fleets, state }: FleetsProps) => {
  return (
    <ul className="flex flex-row gap-4 group">
      {fleets.map((fleet: Fleet, index: number) => (
        <li key={index} className="sim_board w-100">
          <div className="p-2">Fleet {index + 1}</div>
          <FleetDisplay fleet={fleet} state={state} />
        </li>
      ))}
    </ul>
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
    <div className="flex flex-col gap-4 group">
      <div className="flex flex-col gap-4 w-100 sim_board transition-all duration-200 active:scale-[0.98] group-active:scale-[0.98]">
        <MapInput setEnemyFleets={setEnemyFleets} state={state} />
        <ul className="flex flex-row place-content-center items-center">
          <li className="flex items-center">
            <button
              className="p-2 transition-transform duration-150 hover:scale-125 active:scale-95"
              onClick={() =>
                setIndex(
                  (index - 1 + (enemyFleets?.length ?? 1)) %
                    (enemyFleets?.length ?? 1)
                )
              }
            >
              <div className="w-4 h-4 rounded-xs rotate-45 border-l-2 border-l-gray-500 border-b-2 border-b-gray-500"></div>
            </button>
          </li>
          {enemyFleets?.map((_: EnemyFleet, i: number) => (
            <li key={i} className="flex items-center">
              <button
                className={`p-2 transition-all duration-150 hover:scale-125 active:scale-95`}
                onClick={() => setIndex(i)}
              >
                <div
                  className={` w-4 h-4 rounded-full ${buttonColor(i)}`}
                ></div>
              </button>
            </li>
          ))}
          <li className="flex items-center">
            <button
              className="p-2 transition-transform duration-150 hover:scale-125 active:scale-95"
              onClick={() => setIndex((index + 1) % (enemyFleets?.length ?? 1))}
            >
              <div className="w-4 h-4 rounded-xs rotate-45 border-r-2 border-r-gray-500 border-t-2 border-t-gray-500"></div>
            </button>
          </li>
        </ul>
        <div className="pt-4 px-2 text-xl text-gray-600">
          敵艦隊 {index + 1} (確率:
          {((fleet?.probability ?? 0) * 100).toFixed(1)}%)
        </div>

        <FleetDisplay fleet={fleet!} state={state} />
        <AddShipButton
          index={index}
          setEnemyFleets={setEnemyFleets}
          state={state}
        />
      </div>
    </div>
  );
};
