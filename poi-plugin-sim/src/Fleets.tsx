export const Fleets = ({ fleets, state }: any) => {
  return (
    <ul className="flex flex-row gap-4">
      {fleets.map((fleet: any, index: number) => (
        <li key={index} className="bg-gray-200 p-2 w-64 rounded">
          <h2 className="p-2 text-gray-600">Fleet {index + 1}</h2>
          <ul>
            {fleet.ships.map((ship: any, shipIndex: number) => (
              <li key={shipIndex} className="bg-white p-2 rounded shadow mb-2">
                <div className="text-lg">
                  {state.const.$ships[ship.eugenId].api_name}
                </div>
                <div className="flex flex-row text-sm text-gray-600 mb-2 gap-1">
                  <div>耐久 {ship.status.hp}</div>
                  <div>火力 {ship.status.firepower}</div>
                </div>
                <ul className="flex flex-col gap-1 text-sm text-gray-600 p-2 bg-gray-200 rounded">
                  {ship.equips.map((equip: any, equipIndex: number) => (
                    <li key={equipIndex}>
                      <div className="flex flex-row justify-between">
                        <div>{state.const.$equips[equip.eugenId].api_name}</div>
                        <div>火力 +{equip.status.firepower}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
};
