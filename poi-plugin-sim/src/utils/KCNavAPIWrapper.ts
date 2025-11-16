import { Temporal } from "@js-temporal/polyfill";
import EnemyCompsSample from "./KCNavEnemyCompsAPISampleResponse.json";
import MapSample from "./KCNavMapAPISampleResponse.json";

const CACHE_DURATION_MS = 31 * 24 * 60 * 60 * 1000; // 1 month

// Mock implementation of fetchEnemyFromKCNav for testing purposes
export const fetchEnemyFromKCNav = async (
  area: number,
  map: number,
  node: string
): Promise<EnemyFleet[]> => {
  const useMockApi = localStorage.getItem("debug-useMockApi") === "true";

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

  const enemyFleets = useMockApi
    ? await callKCNavEnemyCompsAPIMock(area, map, node)
    : await callKCNavEnemyCompsAPI(area, map, node);

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
  const mockShip = {
    eugenId: 1501 + 10 * (area - 1) + (map - 1),
    shipTypeId: 0,
    status: {
      hp: Math.floor(1000 * rand),
      firepower: 1000,
      armor: 1000,
    },
    equips: [],
  };

  const fromMockJSON = parseKCNavEnemyComps(
    EnemyCompsSample,
    area,
    map,
    _node
  ).map((fleet) => {
    fleet.ships = [mockShip, ...fleet.ships];
    return fleet;
  });
  return fromMockJSON;
};

const callKCNavEnemyCompsAPI = async (
  area: number,
  map: number,
  node: string
) => {
  console.log("Fetching enemy compositions from KCNav API...");
  const date = Temporal.Now.plainDateISO().subtract({ months: 1 }).toString();
  const response = await fetch(
    `https://tsunkit.net/api/routing/maps/${area}-${map}/nodes/${node}/enemycomps?start=${date}`
  );
  const data = await response?.json();
  const enemyFleets = parseKCNavEnemyComps(data, area, map, node);
  return enemyFleets;
};

const parseKCNavEnemyComps = (
  data: any,
  area: number,
  map: number,
  node: string
): EnemyFleet[] => {
  const entries = data.result.entries;
  const totalCount = entries.reduce(
    (sum: number, entry: any) => sum + entry.count,
    0
  );
  const enemyFleets = entries.map((entry: any) => {
    return {
      area,
      map,
      node,
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
      formation: formationMap[entry.formation],
    };
  });
  return enemyFleets;
};

const formationMap: { [key: string]: Formation } = {
  1: "line_ahead",
  2: "double_line",
  3: "diamond",
  4: "echelon",
  5: "line_abreast",
  6: "vanguard",
  undefined: undefined,
};

export const fetchMapFromKCNav = async (
  area: number,
  map: number
): Promise<string[]> => {
  const useMockApi = localStorage.getItem("debug-useMockApi") === "true";

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

  const mapData = useMockApi
    ? await callKCNavMapAPIMock(area, map)
    : await callKCNavMapAPI(area, map);

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
