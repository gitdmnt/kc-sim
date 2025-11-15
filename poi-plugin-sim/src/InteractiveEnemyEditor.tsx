import { connectComponent } from "./hooks/connectComponent";
import { Fleet, Ship } from "./types";

const UnconnectedInteractiveEnemyEditor = ({
  state,
  enemy,
  setEnemy,
}: {
  enemy: Fleet | undefined;
  setEnemy: React.Dispatch<React.SetStateAction<Fleet | undefined>>;
  state: any;
}) => {
  return (
    <div className="bg-white p-4 rounded shadow">
      <h2 className="text-xl mb-4">敵艦隊エディター</h2>
      <ul className="flex flex-col gap-2 bg-gray-200 rounded p-2 w-64">
        {enemy?.ships.map((ship: Ship, shipIndex: number) => (
          <li
            key={shipIndex}
            className="flex flex-row justify-between items-center bg-white p-2 rounded shadow"
          >
            <div>
              <div className="text-lg mb-2">
                {state.const.$ships[ship.eugenId].api_name}
              </div>
              <div className="flex flex-row text-sm text-gray-600 gap-1">
                <div>耐久 {ship.status.hp}</div>
                <div>火力 {ship.status.firepower}</div>
              </div>
            </div>
            <button
              className="bg-gray-400 w-5 h-5 rounded-full"
              onClick={(e) => handleEnemyShipRemove(e, enemy, setEnemy)}
            ></button>
          </li>
        ))}
        <li className="bg-gray-100 rounded p-2 text-sm text-gray-600">
          <select
            value={"Select Enemy Ship"}
            onChange={(e) => handleEnemyShipChange(e, enemy, setEnemy, state)}
          >
            <option>Select Enemy Ship</option>
            {Object.entries(state.const.$ships)
              .filter(
                ([eugenId, _]) =>
                  // Add your filter condition here
                  parseInt(eugenId) > 1500
              )
              .map(([eugenId, shipConst]: [string, any]) => (
                <option key={eugenId} value={eugenId}>
                  {shipConst.api_name}
                </option>
              ))}
          </select>
        </li>
      </ul>
    </div>
  );
};

const handleEnemyShipChange = (
  e: React.ChangeEvent<HTMLSelectElement>,
  enemyFleet: Fleet | undefined,
  setEnemyFleet: React.Dispatch<React.SetStateAction<Fleet | undefined>>,
  state: any
) => {
  const selectedEugenId = parseInt(e.target.value, 10);
  const shipConstData = state.const.$ships;
  const shipTypeId = shipConstData[selectedEugenId].api_stype;

  const newShip: Ship = {
    eugenId: selectedEugenId,
    shipTypeId,
    status: {
      hp: 20,
      firepower: 30,
      armor: 10,
    },
    equips: [],
  };
  if (enemyFleet) {
    setEnemyFleet({
      ...enemyFleet,
      ships: [...enemyFleet.ships, newShip],
    });
  } else {
    setEnemyFleet({
      ships: [newShip],
    });
  }
};

const handleEnemyShipRemove = (
  e: React.MouseEvent<HTMLButtonElement>,
  enemyFleet: Fleet | undefined,
  setEnemyFleet: React.Dispatch<React.SetStateAction<Fleet | undefined>>
) => {
  const button = e.target as HTMLButtonElement;
  const shipIndex = Array.from(
    button.parentElement!.parentElement!.children
  ).indexOf(button.parentElement!);
  if (enemyFleet) {
    const newShips = enemyFleet.ships.filter((_, index) => index !== shipIndex);
    setEnemyFleet({
      ...enemyFleet,
      ships: newShips,
    });
  }
};

export const InteractiveEnemyEditor = connectComponent(
  UnconnectedInteractiveEnemyEditor
);
