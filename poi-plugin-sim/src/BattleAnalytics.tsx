import { connect } from "react-redux";

const ResultRatioBar = ({ results }: { results: BattleResult[] }) => {
  const resultLabels = ["SS", "S", "A", "B", "C", "D", "E"];
  const resultCounts = [0, 0, 0, 0, 0, 0, 0];
  results.forEach((res: any) => {
    resultCounts[res.result]++;
  });
  const resultRatio = resultCounts.map(
    (count) => (count / results.length) * 100
  );

  return (
    <ul className="flex flex-row gap-2 text-xs">
      {resultLabels.map((label, index) => (
        <li key={index}>
          {label}: {resultCounts[index]}回 ({resultRatio[index]?.toFixed(2)}%)
        </li>
      ))}
    </ul>
  );
};

const BattleResultAvarage = ({
  fleetResults,
  fleet,
  state,
}: {
  fleetResults: ShipResult[][] | undefined;
  fleet: Fleet;
  state: any;
}) => {
  const shipHpAfterLists: number[][] =
    fleetResults?.map((fleetResult: ShipResult[]) =>
      fleetResult.map((shipResult: ShipResult) => shipResult.hpAfter)
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
    <ul className="flex flex-col gap-2 bg-gray-200 p-2 w-64 rounded">
      {fleet.ships.map((ship: Ship, shipIndex: number) => (
        <li
          className="flex flex-col gap-1 bg-white p-3 shadow rounded"
          key={shipIndex}
        >
          <div className="">{state.const.$ships[ship.eugenId].api_name}</div>
          <div className="text-xs text-gray-600">
            {ship.status.hp} → {shipAverageHpAfterList[shipIndex]?.toFixed(2)}
          </div>
        </li>
      ))}
    </ul>
  );
};

interface OwnProps {
  friend: Fleet;
  enemy: EnemyFleet[] | undefined;
  results: BattleResult[];
}

type Props = OwnProps & StateProps;

const UnconnectedAnalytics = ({ state, friend, enemy, results }: Props) => {
  // 各試行の friendFleetResults から hpAfter のリストを作成
  const friendFleetResults: ShipResult[][] | undefined = results.map(
    (res) => res.friendFleetResults
  );

  const enemyFleetResultsList: ShipResult[][][] = [];
  results.forEach((res: any) => {
    const enemyIndex = res.enemyIndex;
    if (!enemyFleetResultsList[enemyIndex]) {
      enemyFleetResultsList[enemyIndex] = [];
    }
    enemyFleetResultsList[enemyIndex].push(res.enemyFleetResults);
  }) ?? [];

  return (
    <div className="p-4 bg-white rounded shadow flex flex-col gap-4">
      <ResultRatioBar results={results} />
      <div className="flex flex-row gap-4">
        <BattleResultAvarage
          fleetResults={friendFleetResults!}
          fleet={friend}
          state={state}
        />
        <ul className="flex flex-row gap-4">
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
