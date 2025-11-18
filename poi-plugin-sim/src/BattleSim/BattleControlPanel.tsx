import { Button } from "@/components/Button";
import React from "react";

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
    <div className="sim_panel flex flex-col gap-4">
      <div className="flex flex-row gap-4 items-center">
        <label htmlFor="count" className="text-xl font-medium text-gray-700">
          Count:
        </label>
        <input
          id="count"
          type="number"
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="border border-gray-300 rounded px-4 py-2 w-32"
        />
      </div>
      <Button onClick={() => setSimTrigger((prev) => !prev)}>Simulate</Button>
    </div>
  );
};
