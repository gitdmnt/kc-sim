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

interface OwnProps {
  friend: Fleet;
  enemy: EnemyFleet[] | undefined;
  results: BattleResult[];
}

type Props = OwnProps & StateProps;

const UnconnectedAnalytics = ({ state, friend, enemy, results }: Props) => {
  console.log("results: ", results);
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
  const friendShipHpAfterLists: number[][] = results.map((res: any) =>
    res.friendFleetResults.map((ship: any) => ship.hpAfter)
  );

  // インデックスごとの平均HPを計算
  const friendShipAverageHpAfterList = calculateAveragesByIndex(
    friendShipHpAfterLists
  );

  const enemyShipHpAfterLists: number[][][] = [];
  results.forEach((res: any) => {
    const enemyIndex = res.enemyIndex;
    if (!enemyShipHpAfterLists[enemyIndex]) {
      enemyShipHpAfterLists[enemyIndex] = [];
    }
    enemyShipHpAfterLists[enemyIndex].push(
      res.enemyFleetResults.map((ship: any) => ship.hpAfter)
    );
  });

  const enemyShipAverageHpAfterList = enemyShipHpAfterLists.map((lists) =>
    calculateAveragesByIndex(lists)
  );

  return (
    <div className="p-4 bg-white rounded shadow flex flex-col gap-4">
      <ResultRatioBar results={results} />
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
        {enemy?.map((fleet: EnemyFleet, fleetIndex: number) => (
          <li key={fleetIndex}>
            <ul>
              {fleet.ships.map((ship: any, shipIndex: number) => (
                <li key={shipIndex}>
                  <div className="text-lg mb-2">
                    {state.const.$ships[ship.eugenId].api_name} の戦後平均耐久
                  </div>
                  <div>
                    {enemyShipAverageHpAfterList[fleetIndex]?.[
                      shipIndex
                    ]?.toFixed(2)}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const BattleAnalytics = connect<StateProps, {}, OwnProps>(
  (state: any): StateProps => ({ state })
)(UnconnectedAnalytics);
