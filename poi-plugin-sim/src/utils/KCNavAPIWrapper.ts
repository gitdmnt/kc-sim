import { Temporal } from "@js-temporal/polyfill";
import MapSample from "./KCNavMapAPISampleResponse.json";

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 month

// Mock implementation of fetchEnemyFromKCNav for testing purposes
export const fetchEnemyFromKCNav = async (
  area: number,
  map: number,
  node: string
): Promise<EnemyFleet[]> => {
  const cacheKey = `kcnav-enemy-${area}-${map}-${node}`;
  // 1. ローカルストレージからキャッシュを取得
  try {
    const cachedItem = localStorage.getItem(cacheKey);
    if (cachedItem) {
      const { timestamp, data } = JSON.parse(cachedItem);
      // キャッシュが有効期間内かチェック
      if (
        Temporal.Now.instant().epochMilliseconds - timestamp <
        CACHE_DURATION_MS
      ) {
        console.log(`[KCNav] Returning cached data for ${area}-${map}-${node}`);
        return data;
      }
    }
  } catch (error) {
    console.error("Failed to read from localStorage", error);
  }

  const enemyFleets = await callKCNavEnemyCompsAPI(area, map, node);

  try {
    const itemToCache = {
      timestamp: Temporal.Now.instant().epochMilliseconds,
      data: enemyFleets,
    };
    localStorage.setItem(cacheKey, JSON.stringify(itemToCache));
  } catch (error) {
    console.error("Failed to write to localStorage", error);
  }

  return enemyFleets;
};

const callKCNavEnemyCompsAPIMock = async (
  area: number,
  map: number,
  _node: string
) => {
  console.log("Fetching enemy compositions from KCNav EnemyComps API Mock...");
  const rand = Math.random();
  return [
    {
      area: 1,
      map: 1,
      node: "@",
      probability: 0.1,
      ships: [
        {
          eugenId: 1501 + 10 * (area - 1) + (map - 1),
          shipTypeId: 0,
          status: {
            hp: Math.floor(1000 * rand),
            firepower: 1000,
            armor: 1000,
          },
          equips: [],
        },
      ],
    },
    {
      area: 1,
      map: 1,
      node: "#",
      probability: 0.9,
      ships: [
        {
          eugenId: 1502,
          shipTypeId: 0,
          status: {
            hp: 10,
            firepower: 10,
            armor: 10,
          },
          equips: [],
        },
      ],
    },
  ];
};

const callKCNavEnemyCompsAPI = async (
  area: number,
  map: number,
  stage: string
) => {
  console.log("Fetching enemy compositions from KCNav API...");
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

export const fetchMapFromKCNav = async (
  area: number,
  map: number
): Promise<string[]> => {
  const cacheKey = `kcnav-map-${area}-${map}`;
  // 1. ローカルストレージからキャッシュを取得
  try {
    const cachedItem = localStorage.getItem(cacheKey);
    if (cachedItem) {
      const { timestamp, data } = JSON.parse(cachedItem);
      // キャッシュが有効期間内かチェック
      if (
        Temporal.Now.instant().epochMilliseconds - timestamp <
        CACHE_DURATION_MS
      ) {
        console.log(`[KCNav] Returning cached map data for ${area}-${map}`);
        return data;
      }
    }
  } catch (error) {
    console.error("Failed to read from localStorage", error);
  }

  const mapData = await callKCNavMapAPIMock(area, map);

  try {
    const itemToCache = {
      timestamp: Temporal.Now.instant().epochMilliseconds,
      data: mapData,
    };
    localStorage.setItem(cacheKey, JSON.stringify(itemToCache));
  } catch (error) {
    console.error("Failed to write to localStorage", error);
  }

  return mapData;
};

const callKCNavMapAPIMock = async (_area: number, _map: number) => {
  // Mock implementation for testing
  console.log("Fetching map data from KCNav Map API Mock...");
  const rand = Math.random() * 100;
  const data = MapSample;
  const nodes = parseKCNavMapNodes(data);
  nodes.push(rand.toFixed(2).toString());
  return nodes;
};

const callKCNavMapAPI = async (area: number, map: number) => {
  console.log("Fetching map data from KCNav API...");
  const response = await fetch(
    `https://tsunkit.net/api/routing/maps/${area}-${map}`
  );
  const data = await response?.json();
  const nodes = parseKCNavMapNodes(data);
  return nodes;
};

const parseKCNavMapNodes = (data: any): string[] => {
  const nodes: string[] = Object.values(data.result.route)
    .map((node: any) => node[1] as string)
    .filter((node: string) => node !== "1");
  const uniqueNodes = [...new Set(nodes)];
  return uniqueNodes;
};
