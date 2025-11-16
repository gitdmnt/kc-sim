import { connect } from "react-redux";

const battleResultToIndex = (result: BattleResult): number | undefined => {
  switch (result) {
    case "SS":
      return 0;
    case "S":
      return 1;
    case "A":
      return 2;
    case "B":
      return 3;
    case "C":
      return 4;
    case "D":
      return 5;
    case "E":
      return 6;
    default:
      return undefined;
  }
};

const RESULT_LABELS: string[] = ["SS", "S", "A", "B", "C", "D", "E"];

const COLORS: Record<string, string> = {
  SS: "hsl(50, 60%, 70%)",
  S: "hsl(50, 60%, 50%)",
  A: "hsl(10, 80%, 40%)",
  B: "hsl(20, 80%, 60%)",
  C: "hsl(40, 80%, 60%)",
  D: "hsl(120, 60%, 30%)",
  E: "hsl(210, 50%, 50%)",
};

const StackedRatioBar = ({ counts }: { counts: number[] }) => {
  const total = counts.reduce((s, c) => s + c, 0) || 1;
  return (
    // 親を relative にして overlay を上に置く
    <div className="w-full h-6 rounded overflow-hidden flex border-gray-300 border">
      {counts.map((count, i) => {
        const pct = (count / total) * 100;
        const label = RESULT_LABELS[i];

        return (
          <div
            key={label}
            style={{ width: `${pct}%`, backgroundColor: COLORS[label] }}
            className="h-full"
            title={`${label}: ${count} (${pct.toFixed(1)}%)`}
          />
        );
      })}
    </div>
  );
};

// ResultRatioBar 内で呼ぶ
const ResultRatioBar = ({ reports }: { reports: BattleReport[] }) => {
  const results: BattleResult[] = reports.map((res: any) => res.result);
  const resultCounts: number[] = [0, 0, 0, 0, 0, 0, 0]; // SS, S, A, B, C, D, E
  results.forEach((res: BattleResult) => {
    const index = battleResultToIndex(res);
    if (index !== undefined) {
      resultCounts[index]++;
    }
  });
  const resultRatio: number[] = resultCounts.map((count) =>
    reports.length > 0 ? (count / reports.length) * 100 : 0
  );

  return (
    <>
      <StackedRatioBar counts={resultCounts} />
      <div className="flex gap-2 text-xs mt-1">
        {RESULT_LABELS.map((label, i) => (
          <div key={label} className="flex items-center gap-1">
            <span
              style={{ background: COLORS[label] }}
              className="w-3 h-3 block"
            />
            {label} {resultRatio[i].toFixed(1)}%
          </div>
        ))}
      </div>
    </>
  );
};

const BattleResultAvarage = ({
  fleetResults,
  fleet,
  state,
}: {
  fleetResults: ShipSnapshot[][] | undefined;
  fleet: Fleet;
  state: any;
}) => {
  const shipHpAfterLists: number[][] =
    fleetResults?.map((fleetResult: ShipSnapshot[]) =>
      fleetResult.map((shipResult: ShipSnapshot) => shipResult.hp)
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
    <ul className="flex flex-col gap-2 w-64 board">
      {fleet.ships.map((ship: Ship, shipIndex: number) => (
        <li className="flex flex-col gap-1 card" key={shipIndex}>
          <div className="text-gray-800">
            {state.const.$ships[ship.eugenId].api_name}
          </div>
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
  reports: BattleReport[];
}

type Props = OwnProps & StateProps;

const UnconnectedAnalytics = ({ state, friend, enemy, reports }: Props) => {
  // 各試行の friendFleetResults から hpAfter のリストを作成
  const friendFleetResults: ShipSnapshot[][] | undefined = reports.map(
    (res) => res.friendFleetResults
  );

  const enemyFleetResultsList: ShipSnapshot[][][] = [];
  reports.forEach((res: any) => {
    const enemyIndex = res.enemyIndex;
    if (!enemyFleetResultsList[enemyIndex]) {
      enemyFleetResultsList[enemyIndex] = [];
    }
    enemyFleetResultsList[enemyIndex].push(res.enemyFleetResults);
  }) ?? [];

  return (
    <div className="panel flex flex-col gap-4">
      <ResultRatioBar reports={reports} />
      <div className="flex flex-row gap-3">
        <div className="w-68 p-2 shadow-inner rounded">
          <BattleResultAvarage
            fleetResults={friendFleetResults!}
            fleet={friend}
            state={state}
          />
        </div>
        <ul className="flex flex-row gap-4 overflow-scroll rounded shadow-inner p-2 bg-gray-500">
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
