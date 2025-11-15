import { simulate } from "../sim-core/pkg/sim_core";
import { useEffect, useState } from "react";
import { InteractiveEnemyEditor } from "./InteractiveEnemyEditor";
import { BattleDisplay } from "./BattleDisplay";
import { BattleAnalytics } from "./BattleAnalytics";
interface BattleSimProps {
  friend: Fleet[];
  stage: string;
}

export const BattleSim = ({ friend, stage }: BattleSimProps) => {
  const count = 1000;
  const [result, setResult] = useState<BattleResult[]>([]);
  const [enemyFleets, setEnemyFleets] = useState<EnemyFleet[]>();

  useEffect(() => {
    console.log(friend[0]);
    console.log(enemyFleets);
    const res: BattleResult[] = simulate(friend[0], enemyFleets, count);
    setResult(res);
  }, [friend, enemyFleets]);

  return (
    <div className="flex flex-col gap-4">
      <BattleDisplay
        friend={friend.slice(0, 1)}
        enemyFleets={enemyFleets}
        setEnemyFleets={setEnemyFleets}
        stage={stage}
      />
      {result.length > 0 ? (
        <BattleAnalytics
          friend={friend[0]}
          enemy={enemyFleets}
          result={result}
        />
      ) : null}
    </div>
  );
};
