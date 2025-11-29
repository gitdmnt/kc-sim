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
    <div className="w-full h-10 rounded overflow-hidden flex border-gray-300 border">
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

export const ResultRatioBar = ({ reports }: { reports: BattleReport[] }) => {
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
      <div className="flex gap-2 text-lg mt-1">
        {RESULT_LABELS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <span
              style={{ background: COLORS[label] }}
              className="w-6 h-6 block"
            />
            {label} {resultRatio[i].toFixed(1)}%
          </div>
        ))}
      </div>
    </>
  );
};
