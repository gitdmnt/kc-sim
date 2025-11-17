import React from "react";
import { enemyList } from "@utils/KancolleDataWrapper";

interface Props {
  index: number;
  setEnemyFleets: React.Dispatch<
    React.SetStateAction<EnemyFleet[] | undefined>
  >;
  state: any;
}

export const AddShipButton: React.FC<Props> = ({
  index,
  setEnemyFleets,
  state,
}) => {
  const enemyOptions = enemyList(state);

  return (
    <button className="p-2 bg-white shadow-inner overflow-hidden rounded w-full text-xs text-gray-600">
      <select
        value={"敵艦を追加"}
        onChange={(e) => {
          const selectedShipId = parseInt(e.target.value, 10);
          const selectedShip = enemyOptions.find(
            (enemy) => enemy.id === selectedShipId
          );
          if (selectedShip) {
            setEnemyFleets((prev) => {
              if (!prev) return prev;
              return prev.map((fleet, i) => {
                if (i !== index) return fleet;
                return { ...fleet, ships: [...fleet.ships, selectedShip] };
              });
            });
          }
        }}
      >
        <option value="敵艦を追加">敵艦を追加</option>
        {enemyOptions.map((enemy) => (
          <option key={enemy.id} value={enemy.id}>
            {enemy.name}
          </option>
        ))}
      </select>
    </button>
  );
};
