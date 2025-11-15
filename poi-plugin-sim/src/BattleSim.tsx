import { simulate } from "../sim-core/pkg/sim_core";
import { Fleets } from "./Fleets";
import { connectComponent } from "./hooks/connectComponent";
import { BattleResult } from "./types";
import React, { useEffect, useState } from "react";
import { InteractiveEnemyEditor } from "./InteractiveEnemyEditor";

export const BattleSim = ({ friend, stage }: any) => {
  const count = 1000;
  const [result, setResult] = useState<BattleResult[]>([]);
  const [enemy, setEnemy] = useState<any>(undefined);

  useEffect(() => {
    const res: BattleResult[] = simulate(friend, enemy, count);
    setResult(res);
  }, [friend, enemy]);

  return (
    <>
      <InteractiveEnemyEditor enemy={enemy} setEnemy={setEnemy} />
      <ConnectedBattleDisplay friend={friend} enemy={enemy} stage={stage} />
      {result.length > 0 ? (
        <ConnectedAnalytics friend={friend} enemy={enemy} result={result} />
      ) : null}
    </>
  );
};

const BattleDisplay = ({ state, friend, enemy, stage }: any) => {
  return (
    <div>
      <div>{stage}</div>
      <div>
        {friend && enemy ? (
          <Fleets fleets={[friend, enemy]} state={state} />
        ) : null}
      </div>
    </div>
  );
};

const ConnectedBattleDisplay = connectComponent(BattleDisplay);

const Analytics = ({ state, friend, enemy, result }: any) => {
  const resultLabels = ["D", "C", "B", "A", "S", "SS"];
  const resultCounts = [0, 0, 0, 0, 0, 0];
  result.forEach((res: any) => {
    resultCounts[res.result]++;
  });
  const resultRatio = resultCounts.map(
    (count) => (count / result.length) * 100
  );

  console.log("results: ", result);
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

  // 各試行の friendFleetResults から hpAfter のリストを作成
  // 例: [[10, 20], [12, 22], [8, 18]]
  const friendShipHpAfterLists: number[][] = result.map((res: any) =>
    res.friendFleetResults.map((ship: any) => ship.hpAfter)
  );

  // インデックスごとの平均HPを計算
  const friendShipAverageHpAfterList = calculateAveragesByIndex(
    friendShipHpAfterLists
  );

  const enemyShipHpAfterLists: number[][] = result.map((res: any) =>
    res.enemyFleetResults.map((ship: any) => ship.hpAfter)
  );

  const enemyShipAverageHpAfterList = calculateAveragesByIndex(
    enemyShipHpAfterLists
  );

  return (
    <>
      <ul>
        {resultLabels.map((label, index) => (
          <li key={index}>
            {label}: {resultCounts[index]}回 ({resultRatio[index]?.toFixed(2)}%)
          </li>
        ))}
      </ul>
      <ul>
        {friend.ships.map((ship: any, shipIndex: number) => (
          <li key={shipIndex}>
            <div className="text-lg mb-2">
              {state.const.$ships[ship.eugenId].api_name} の戦後平均耐久
            </div>
            <div>{friendShipAverageHpAfterList[shipIndex]?.toFixed(2)}</div>
          </li>
        ))}
      </ul>
      <ul>
        {enemy.ships.map((ship: any, shipIndex: number) => (
          <li key={shipIndex}>
            <div className="text-lg mb-2">
              {state.const.$ships[ship.eugenId].api_name} の戦後平均耐久
            </div>
            <div>{enemyShipAverageHpAfterList[shipIndex]?.toFixed(2)}</div>
          </li>
        ))}
      </ul>
    </>
  );
};

const ConnectedAnalytics = connectComponent(Analytics);
