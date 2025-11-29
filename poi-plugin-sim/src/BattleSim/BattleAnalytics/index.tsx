// @ts-ignore
import React from "react";
import { connect } from "react-redux";

import { ResultRatioBar } from "./ResultRatioBar";

const BattleResultAvarage = ({
  fleetResults,
  fleet,
  state,
}: {
  fleetResults: Fleet[] | undefined;
  fleet: Fleet;
  state: any;
}) => {
  console.log(fleetResults);

  const shipHpAfterLists: number[][] =
    fleetResults?.map((fleetResult: Fleet) =>
      fleetResult.ships.map((shipResult: Ship) => shipResult.status.nowHp)
    ) ?? [];

  const calculateAveragesByIndex = (listOfLists: number[][]): number[] => {
    if (listOfLists.length === 0) {
      return [];
    }
    // reduceを使ってインデックスごとに合計を計算
    const sums = listOfLists.reduce((acc, currentList) => {
      currentList.forEach((value, index) => {
        acc[index] = (acc[index] || 0) + value;
      });
      return acc;
    }, [] as number[]);

    // 合計をリストの数で割って平均を計算
    return sums.map((sum) => sum / listOfLists.length);
  };

  // インデックスごとの平均HPを計算
  const shipAverageHpAfterList = calculateAveragesByIndex(shipHpAfterLists);

  return (
    <ul className="flex flex-col gap-4 w-100 sim_board">
      {fleet.ships.map((ship: Ship, shipIndex: number) => (
        <li className="flex flex-col gap-2 sim_card" key={shipIndex}>
          <div className="text-gray-800 text-3xl">
            {state.const.$ships[ship.id].api_name}
          </div>
          <div className="text-lg text-gray-600">
            {ship.status.nowHp} →{" "}
            {shipAverageHpAfterList[shipIndex]?.toFixed(2)}
          </div>
        </li>
      ))}
    </ul>
  );
};

interface OwnProps {
  friend: Fleet;
  enemy: EnemyFleet[] | undefined;
  reports: BattleReport[];
}

type Props = OwnProps & StateProps;

const UnconnectedAnalytics = ({ state, friend, enemy, reports }: Props) => {
  // 各試行の friendFleetResults から hpAfter のリストを作成
  const friendFleetResults: Fleet[] | undefined = reports.map(
    (res) => res.friendFleet
  );

  const enemyFleetResultsList: Fleet[][] = [];
  reports.forEach((res: BattleReport) => {
    const enemyIndex = res.enemyFleet.index;
    if (!enemyFleetResultsList[enemyIndex]) {
      enemyFleetResultsList[enemyIndex] = [];
    }
    enemyFleetResultsList[enemyIndex].push(res.enemyFleet);
  }) ?? [];

  return (
    <div className="sim_panel flex flex-col gap-8">
      <ResultRatioBar reports={reports} />
      <div className="flex flex-row gap-6">
        <div className="w-108 py-4 shadow-inner rounded">
          <BattleResultAvarage
            fleetResults={friendFleetResults!}
            fleet={friend}
            state={state}
          />
        </div>
        <ul className="flex flex-row gap-4 overflow-scroll rounded shadow-inner p-4 bg-gray-500">
          {enemy?.map((fleet: EnemyFleet, fleetIndex: number) => (
            <li key={fleetIndex}>
              <BattleResultAvarage
                fleetResults={enemyFleetResultsList![fleetIndex]!}
                fleet={fleet}
                state={state}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export const BattleAnalytics = connect<StateProps, {}, OwnProps>(
  (state: any): StateProps => ({ state })
)(UnconnectedAnalytics);
