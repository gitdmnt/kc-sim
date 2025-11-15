import { Temporal } from "@js-temporal/polyfill";

export const fetchEnemyFromKCNav = async (
  area: number,
  map: number,
  stage: string
) => {
  const date = Temporal.Now.plainDateISO().subtract({ months: 1 }).toString();
  const response = await fetch(
    `https://tsunkit.net/api/routing/maps/${area}-${map}/nodes/${stage}/enemycomps?start=${date}`
  );
  const data = await response?.json();
  const entries = data.result.entries;
  const totalCount = entries.reduce(
    (sum: number, entry: any) => sum + entry.count,
    0
  );
  const enemyFleets = entries.map((entry: any) => {
    return {
      area,
      map,
      node: stage,
      probability: entry.count / totalCount,
      ships: entry.mainFleet.map((enemy: any) => ({
        eugenId: enemy.id,
        shipTypeId: 0, // You may want to fetch or calculate the shipTypeId based on eugenId
        status: {
          hp: enemy.hp,
          firepower: enemy.fp,
          armor: enemy.armor,
        },
        equips: enemy.equips
          .filter((id: number) => id !== -1)
          .map((id: number) => ({
            eugenId: id,
            equipTypeId: 0, // You may want to fetch or calculate the equipTypeId based on eugenId
            status: { firepower: 0 }, // You may want to fill in actual equip status
          })),
      })),
    };
  });
  return enemyFleets;
};
