import { simulate } from "../sim-core/pkg/sim_core";
import { Fleets } from "./Fleets";
import { connectComponent } from "./hooks/connectComponent";

export const BattleSim = ({ friend, enemy, stage }: any) => {
  const count = 1000;
  const result = simulate(friend, enemy, count);

  return (
    <>
      <ConnectedBattleDisplay friend={friend} enemy={enemy} stage={stage} />
      <Analytics result={result} />
    </>
  );
};

const BattleDisplay = ({ state, friend, enemy, stage }: any) => {
  return (
    <div>
      <div>{stage}</div>
      <div>
        <Fleets fleets={[friend]} state={state} />
      </div>
      <div>{enemy && <Fleets fleets={[enemy]} state={state} />}</div>
    </div>
  );
};

const ConnectedBattleDisplay = connectComponent(BattleDisplay);

const Analytics = ({ result }: any) => {
  return <div>{result}</div>;
};
