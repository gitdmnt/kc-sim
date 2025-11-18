import React from "react";
import { simulate } from "../../sim-core/pkg/sim_core";
import { useEffect, useState } from "react";
import { BattleDisplay } from "./BattleDisplay";
import { BattleAnalytics } from "./BattleAnalytics";
import { BattleControlPanel } from "./BattleControlPanel";
interface BattleSimProps {
  friend: Fleet[];
  stage: string;
}

export const BattleSim = ({ friend, stage }: BattleSimProps) => {
  const [count, setCount] = useState<number>(1000);
  const [results, setResults] = useState<BattleReport[]>([]);
  const [enemyFleets, setEnemyFleets] = useState<EnemyFleet[]>();
  const [simTrigger, setSimTrigger] = useState<boolean>(false);

  console.log(enemyFleets?.[0]!);

  useEffect(() => {
    const res: BattleReport[] = simulate(friend[0], enemyFleets, count);
    setResults(res);
  }, [simTrigger]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-row gap-4">
        <BattleDisplay
          friend={friend.slice(0, 1)}
          enemyFleets={enemyFleets}
          setEnemyFleets={setEnemyFleets}
          stage={stage}
        />
        <BattleControlPanel
          count={count}
          setCount={setCount}
          setSimTrigger={setSimTrigger}
        />
      </div>
      {results.length > 0 ? (
        <BattleAnalytics
          friend={friend[0]}
          enemy={enemyFleets}
          reports={results}
        />
      ) : null}
    </div>
  );
};
