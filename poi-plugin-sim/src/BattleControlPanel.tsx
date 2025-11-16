interface Props {
  count: number;
  setCount: React.Dispatch<React.SetStateAction<number>>;
  setSimTrigger: React.Dispatch<React.SetStateAction<boolean>>;
}

export const BattleControlPanel = ({
  count,
  setCount,
  setSimTrigger,
}: Props) => {
  return (
    <div className="panel flex flex-col gap-2">
      <div className="flex flex-row gap-2 items-center">
        <label htmlFor="count" className="text-sm font-medium text-gray-700">
          Count:
        </label>
        <input
          id="count"
          type="number"
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="border border-gray-300 rounded px-2 py-1 w-20"
        />
      </div>
      <button onClick={() => setSimTrigger((prev) => !prev)} className="button">
        Simulate
      </button>
    </div>
  );
};
