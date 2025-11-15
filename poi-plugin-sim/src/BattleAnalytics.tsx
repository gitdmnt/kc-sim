import { connect } from "react-redux";

interface OwnProps {
  friend: Fleet;
  enemy: EnemyFleet[] | undefined;
  result: BattleResult[];
}

type Props = OwnProps & StateProps;

const UnconnectedAnalytics = ({ state, friend, enemy, result }: Props) => {
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
  const friendShipHpAfterLists: number[][] = result.map((res: any) =>
    res.friendFleetResults.map((ship: any) => ship.hpAfter)
  );

  // インデックスごとの平均HPを計算
  const friendShipAverageHpAfterList = calculateAveragesByIndex(
    friendShipHpAfterLists
  );

  const enemyShipHpAfterLists: number[][][] = [];
  result.forEach((res: any) => {
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
    </>
  );
};

export const BattleAnalytics = connect<StateProps, {}, OwnProps>(
  (state: any): StateProps => ({ state })
)(UnconnectedAnalytics);
