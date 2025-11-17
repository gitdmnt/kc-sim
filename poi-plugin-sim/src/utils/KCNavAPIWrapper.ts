import { Temporal } from "@js-temporal/polyfill";
import EnemyCompsSample from "./KCNavEnemyCompsAPISampleResponse.json";
import MapSample from "./KCNavMapAPISampleResponse.json";

const CACHE_DURATION_MS = 31 * 24 * 60 * 60 * 1000; // 1 month

///
/// Fetch enemy fleet compositions from KCNav API.
/// Enemy status is partially masked due to API limitations;
/// - evasion
/// - airplaneSlots
/// - antiSubmarineWarfare
/// - speed
/// - scouting
/// - range
/// - luck
///

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
    id: 1501 + 10 * (area - 1) + (map - 1),
    name: "Mock Enemy Ship",
    shipTypeId: 0,
    shipTypeName: "Mock Ship Type",
    status: {
      maxHp: Math.floor(1000 * rand),
      nowHp: Math.floor(1000 * rand),
      firepower: 1000,
      armor: 1000,
      torpedo: 500,
      evasion: 200,
      antiAircraft: 300,
      airplaneSlots: [10, 10, 10],
      antiSubmarineWarfare: 150,
      speed: 10,
      scouting: 5,
      range: "none" as unknown as Range,
      luck: 10,
      condition: 49,
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

const formationMap: { [key: string]: Formation } = {
  1: "line_ahead",
  2: "double_line",
  3: "diamond",
  4: "echelon",
  5: "line_abreast",
  6: "vanguard",
  undefined: undefined,
};

interface KCNavEnemyCompsResponse {
  result: {
    entryCount: number;
    entries: KCNavEnemyCompsEntry[];
  };
}

interface KCNavEnemyCompsEntry {
  map: string;
  node: string;
  mainFleet: KCNavEnemyShipData[];
  escortFleet?: KCNavEnemyShipData[];
  formation: number;
  count: number;
  airpower: number[];
  lbasAirpower?: number[];
  uncertainAirpowerItems?: number[];
  diffiulty?: number;
  masterId?: number;
}

interface KCNavEnemyShipData {
  id: number;
  name: string;
  lvl: number;
  hp: number;
  fp: number;
  torp: number;
  aa: number;
  armor: number;
  equips: number[];
}

const parseKCNavEnemyComps = (
  data: KCNavEnemyCompsResponse,
  area: number,
  map: number,
  node: string
): EnemyFleet[] => {
  const entries = data.result.entries;
  const totalCount = entries.reduce(
    (sum: number, entry: any) => sum + entry.count,
    0
  );
  const enemyFleets: EnemyFleet[] = entries.map((entry: any): EnemyFleet => {
    return {
      area,
      map,
      node,
      probability: entry.count / totalCount,
      ships: entry.mainFleet.map((enemy: any): Ship => {
        return parseKCNavEnemyDataToEnemyFleet(enemy);
      }),

      formation: formationMap[entry.formation],
    };
  });
  return enemyFleets;
};

const parseKCNavEnemyDataToEnemyFleet = (data: KCNavEnemyShipData): Ship => {
  return {
    id: data.id,
    name: data.name,
    shipTypeId: undefined,
    shipTypeName: undefined,
    status: {
      maxHp: data.hp ?? 0,
      nowHp: data.hp ?? 0,
      firepower: data.fp ?? 0,
      armor: data.armor ?? 0,
      torpedo: data.torp ?? 0,
      evasion: undefined,
      antiAircraft: data.aa ?? 0,
      airplaneSlots: undefined,
      antiSubmarineWarfare: undefined,
      speed: undefined,
      scouting: undefined,
      range: undefined,
      luck: undefined,
      condition: 49,
    },
    equips: data.equips.map((id) => {
      return {
        id,
        name: undefined,
        equipTypeId: undefined,
        status: undefined,
      };
    }),
  };
};

///
/// Fetch map nodes from KCNav API
///

export const fetchMapFromKCNav = async (
  area: number,
  map: number
): Promise<[string, string][]> => {
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
  nodes.push([rand.toFixed(2).toString(), "mock"]);
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

/// [from, to, type of destination1, type of destination2]
/// type1: 0=start, 4=normal, 5=boss, 10=airRaid, 90=noBattle, 91=noBattle(能動分岐)
/// type2: 0=start, 4=normal(battle?), 5=boss, 6=noBattle,
///
/// (type1, type2) =
/// (-1, -1): unreachable route
/// (0, 0): start
/// (2, 2): resource
/// (8, 2): goal (7-4)
/// (3, 3): whirlpool
/// (4, 4): normal battle
/// (7, 4): air warfare
/// (10, 4): air raid battle
/// (11, 4): night battle
/// (15, 4): asw + air raid battle
/// (5, 5): boss battle
/// (90, 6): no battle
/// (91, 6): no battle (active branching)
/// (9, 7): air scout (6-3, g, h)
/// (8, 8): goal (1-6)
/// (6, 9): transport
const parseKCNavMapNodes = (data: any): [string, string][] => {
  const nodes: [string, string][] = Object.values(data.result.route)
    .filter((node: any) => node[3] === 4 || node[3] === 5) // 修正: type1/type2 両方をチェック
    .map((node: any) => [node[1], nodeType1Map(node[2], node[3])]);

  const unique = new Map<string, string>();
  for (const [id, type] of nodes) {
    if (!unique.has(id)) {
      unique.set(id, type); // 最初に出現した id を保持
    }
  }
  return Array.from(unique.entries()) as [string, string][];
};

const nodeType1Map = (typeId1: number, typeId2: number): string => {
  if (typeId1 === -1 && typeId2 === -1) return "unreachable";
  if (typeId1 === 0 && typeId2 === 0) return "start";
  if (typeId1 === 2 && typeId2 === 2) return "resource";
  if (typeId1 === 8 && typeId2 === 2) return "goal";
  if (typeId1 === 3 && typeId2 === 3) return "whirlpool";
  if (typeId1 === 4 && typeId2 === 4) return "normal_battle";
  if (typeId1 === 7 && typeId2 === 4) return "air_warfare";
  if (typeId1 === 10 && typeId2 === 4) return "air_raid";
  if (typeId1 === 11 && typeId2 === 4) return "night_battle";
  if (typeId1 === 15 && typeId2 === 4) return "asw_air_raid_battle";
  if (typeId1 === 5 && typeId2 === 5) return "boss_battle";
  if (typeId1 === 90 && typeId2 === 6) return "no_enemy";
  if (typeId1 === 91 && typeId2 === 6) return "no_enemy_active_branching";
  if (typeId1 === 9 && typeId2 === 7) return "air_scout";
  if (typeId1 === 8 && typeId2 === 8) return "goal";
  if (typeId1 === 6 && typeId2 === 9) return "transport";
  return "unknown";
};
