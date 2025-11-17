import { connect } from "react-redux";
import { Fleets, EnemyFleets } from "@/BattleSim/FleetBoard";

interface OwnProps {
  friend: Fleet[];
  enemyFleets: EnemyFleet[] | undefined;
  setEnemyFleets: React.Dispatch<
    React.SetStateAction<EnemyFleet[] | undefined>
  >;
  stage: string;
}

type Props = OwnProps & StateProps;

const UnconnectedBattleDisplay = ({
  state,
  friend,
  enemyFleets,
  setEnemyFleets,
  stage,
}: Props) => {
  return (
    <div className="bg-white p-4 rounded shadow">
      <div>{stage}</div>
      <div className="flex flex-row gap-8 place-content-start">
        <div className="pt-6">
          {friend ? <Fleets fleets={friend} state={state} /> : null}
        </div>
        <div>
          {
            <EnemyFleets
              enemyFleets={enemyFleets}
              setEnemyFleets={setEnemyFleets}
              state={state}
            />
          }
        </div>
      </div>
    </div>
  );
};

const mapStateToProps = (state: any): StateProps => ({
  state,
});

export const BattleDisplay = connect<StateProps, {}, OwnProps>(mapStateToProps)(
  UnconnectedBattleDisplay
);
