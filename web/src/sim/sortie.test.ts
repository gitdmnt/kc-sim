import { describe, expect, test } from "bun:test";
import type { SortieSummary } from "@sim-core";
import { DataApi } from "../data/api";
import { loadMapData } from "../data/mapData";
import type { MapBundle, RoutingDoc } from "@shared/data/types";
import { MemoryStorage } from "../fleet/storage";
import type { MasterData, Preset } from "@shared/fleet/types";
import {
  buildSortieInput, compSourceLabel, flagNames, hasStartRules, pickSet, selectNodes, startNodes, uncertainNodes,
} from "./sortieAdapter";
import { geometricSorties, mergeSortieSummaries, runSortieJob } from "./runner";

const ZD = { mean: 0, p50: 0, p90: 0 };
const routing: RoutingDoc = {
  map: "9-9",
  defaults: { select: { F: "D" }, flags: ["open"] },
  nodes: {
    Start1: { rules: [{ to: "A" }] },
    Start2: { rules: [{ to: "B" }] },
    A: { rules: [{ when: { m: "flag", name: "open" }, to: "B" }, { uncertain: true, random: [{ to: "B", p: 0.5 }, { to: "F", p: 0.5 }] }] },
    F: { rules: [{ select: ["D", "J"] }] },
    B: { end: true },
  },
};

describe("routing scans", () => {
  test("start / select / flags / uncertain", () => {
    expect(startNodes(routing)).toEqual(["Start1", "Start2"]);
    expect(startNodes(null)).toEqual(["Start"]);
    expect(selectNodes(routing)).toEqual({ F: ["D", "J"] });
    expect(flagNames(routing)).toEqual([{ name: "open", default: true }]);
    expect([...uncertainNodes(routing)]).toEqual(["A"]);
  });
});

describe("pickSet", () => {
  const set = (difficulty: number, retrievedAt: string) => ({ difficulty, retrievedAt, periodStart: null, periodEnd: null, totalCount: 1, source: "kcnav", comps: [] });
  test("exact newest, else highest difficulty with fallback flag", () => {
    const sets = [set(0, "2026-01-01"), set(0, "2026-02-01"), set(3, "2026-01-01")];
    expect(pickSet(sets, 0)).toMatchObject({ fallback: false, set: { retrievedAt: "2026-02-01" } });
    expect(pickSet(sets, 4)).toMatchObject({ fallback: true, set: { difficulty: 3 } });
    expect(pickSet([], 0)).toBeUndefined();
  });
});

const master: MasterData = { ships: { 1: { api_id: 1, api_name: "艦", api_stype: 2, api_houg: [10], api_raig: [20], api_tyku: [5], api_souk: [5], api_kaih: [40, 80], api_tais: [20, 60], api_saku: [10, 30], api_luck: [10], api_taik: [20], api_leng: 1, api_soku: 10 } }, equips: {} };
const preset: Preset = { id: "p", name: "p", createdAt: 0, updatedAt: 0, fleetType: "single", formation: "line_ahead", hqLevel: 100, ships: [{ masterId: 1, level: 50, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [], observed: { maxHp: 30, nowHp: 30, firepower: 10, torpedo: 20, antiAir: 5, armor: 5, evasion: 50, asw: 30, los: 20, luck: 10, range: 1, speed: 10 } }] };

const bundle: MapBundle = {
  format: "kc-sim-map-bundle", version: 1, generatedAt: "", map: { id: 99, key: "9-9", world: 9, no: 9, name: "t", isEvent: false, maxHp: null, requiredDefeatCount: null },
  nodes: [
    { letter: "Start1", x: 0, y: 0, colorNo: 0, eventId: 0, eventKind: null, type: "start", isBoss: false },
    { letter: "A", x: 1, y: 1, colorNo: 4, eventId: 4, eventKind: null, type: "battle", isBoss: false },
    { letter: "B", x: 2, y: 2, colorNo: 5, eventId: 5, eventKind: null, type: "boss", isBoss: true },
  ],
  edges: [], routing,
  enemyComps: { A: [{ difficulty: 0, retrievedAt: "x", periodStart: null, periodEnd: null, totalCount: 10, source: "kcnav", comps: [{ id: 1, formation: 4, count: 10, weight: 1, airpower: [], main: [{ shipId: 1501, level: 1, hp: 20, fp: 5, tp: 15, aa: 6, ar: 5, equips: [1501] }], escort: [] }] }] },
  // API.md §5: 平坦な Ship & { estimates, best }
  ships: { "1501": { id: 1501, name: "イ", nameEn: null, yomi: null, stype: 2, ctype: null, speed: 10, range: 1, slotNum: 1, isAbyssal: true, hp: 20, fp: 5, tp: 15, aa: 6, ar: 5, luck: null, maxStats: null, slots: [0], equips: [1501], flags: null, estimates: [], best: { ev: { value: 14, confidence: "datamined", source: "s" } } } },
  equipments: { "1501": { id: 1501, name: "砲", type: [1, 1, 1, 1, 0], typeId: 1, icon: 1, fp: 1, tp: 0, aa: 0, ar: 0, bomb: 0, asw: 0, los: 0, acc: 0, ev: 0, luck: 0, range: 1, radius: null, cost: null, isAbyssal: true } as any },
};

describe("loadMapData fallback", () => {
  const offlineApi = new DataApi({ baseUrl: () => "http://x", storage: new MemoryStorage(), fetch: (async () => { throw new TypeError("down"); }) as any });
  test("uses the static bundle when the API is offline", async () => {
    const d = await loadMapData("9-9", { api: offlineApi, bundle: { loadMap: async () => bundle } });
    expect(d.source).toBe("bundle");
    expect(d.detail.enemyCompNodes).toEqual(["A"]);
    expect(d.ships.get(1501)?.ship.name).toBe("イ");
    expect(d.equips.get(1501)?.name).toBe("砲");
  });
  test("rethrows the offline error when there is no bundle", async () => {
    await expect(loadMapData("9-9", { api: offlineApi, bundle: { loadMap: async () => null } })).rejects.toMatchObject({ kind: "offline" });
  });
  test("a 404 from the API is not masked by the bundle", async () => {
    const api404 = new DataApi({ baseUrl: () => "http://x", storage: new MemoryStorage(), fetch: (async () => new Response("{}", { status: 404 })) as any });
    await expect(loadMapData("9-9", { api: api404, bundle: { loadMap: async () => bundle } })).rejects.toMatchObject({ status: 404 });
  });
  test("API: passes minObserved and keeps the per-node source selection", async () => {
    const urls: string[] = [];
    const selection = [{ difficulty: 0, source: "poi-observed", observedCount: 42, minObserved: 40 }];
    const json = (url: string): unknown =>
      url.includes("/enemy-comps") ? { map: "9-9", node: "A", minObserved: 40, selection, sets: bundle.enemyComps.A.map((s) => ({ ...s, source: "poi-observed", totalCount: 42 })) }
      : url.endsWith("/maps/9-9") ? { map: bundle.map, nodes: bundle.nodes, edges: [], routing, enemyCompNodes: ["A"] }
      : url.includes("/ships/") ? { ship: bundle.ships["1501"], estimates: [], best: {} }
      : { equipments: [] };
    const api = new DataApi({
      baseUrl: () => "http://x", storage: new MemoryStorage(),
      fetch: (async (url: string) => (urls.push(url), new Response(JSON.stringify(json(url))))) as unknown as typeof fetch,
    });
    const d = await loadMapData("9-9", { api, minObserved: 40 });
    expect(urls).toContain("http://x/api/v1/maps/9-9/nodes/A/enemy-comps?minObserved=40");
    expect(d.compSelection).toEqual({ A: selection });
    expect(d.comps.A[0].source).toBe("poi-observed");
  });
});

describe("buildSortieInput", () => {
  const data = {
    key: "9-9", source: "bundle" as const, stale: false,
    detail: { map: bundle.map, nodes: bundle.nodes, edges: [], routing, enemyCompNodes: ["A"] },
    comps: bundle.enemyComps,
    compSelection: {},
    ships: new Map([[1501, { ship: bundle.ships["1501"] as any, estimates: [], best: { ev: { value: 14, confidence: "datamined" as const, source: "s" } } }]]),
    equips: new Map([[1501, bundle.equipments["1501"]]]),
  };
  const settings = {
    start: "Start1", selects: { F: "J" }, flags: { open: false }, difficulty: 0, night: "bossOnly" as const,
    retreat: { onHeavy: true }, formations: { A: "diamond" as const }, hqLevel: 100, applyFit: false,
  };

  test("maps nodes, comps, config and policy", () => {
    const b = buildSortieInput(preset, master, data, settings);
    const inp = b.input;
    expect(inp.hqLevel).toBe(100);
    expect(inp.config).toMatchObject({ start: "Start1", selects: { F: "J" }, flags: { open: false }, difficulty: 0 });
    expect(inp.policy).toMatchObject({ night: "bossOnly", formations: { A: "diamond" } });
    expect(inp.map.nodes.B).toEqual({ kind: "boss", boss: true });
    expect(inp.map.nodes.A.comps).toHaveLength(1);
    expect(inp.map.nodes.A.comps![0].fleet.formation).toBe("echelon");
    expect(inp.map.nodes.A.comps![0].fleet.ships[0]).toMatchObject({ id: 1501, shipType: 2, stats: { evasion: 14 } });
    expect(inp.friend.ships[0]).toMatchObject({ speed: 10, maxHp: 30 });
    expect(inp.friend.formation).toBeUndefined();
    // boss has no comps → warning
    expect(b.warnings.some((w) => w.includes("ボスマス"))).toBe(true);
    expect(b.warnings.some((w) => w.includes("空きマス扱い: B"))).toBe(true);
    expect([...b.uncertain]).toEqual(["A"]);
    expect(Object.keys(b.compSets)).toEqual(["A"]);
    expect(compSourceLabel(b.compSets.A)).toBe("KCNav");
    expect(compSourceLabel({ source: "poi-observed", totalCount: 1234 })).toBe("観測 (n=1,234)");
  });

  test("gauge input and missing routing", () => {
    const g = buildSortieInput(preset, master, data, { ...settings, gaugeInput: { kind: "hp", remaining: 300, finalSet: data.comps.A[0] } });
    expect(g.input.gauge).toMatchObject({ kind: "hp", remaining: 300 });
    expect(g.input.gauge!.finalComps).toHaveLength(1);
    expect(() => buildSortieInput(preset, master, { ...data, detail: { ...data.detail, routing: null } }, settings)).toThrow("ルーティング");
  });

  test("start omitted → sim-core picks it (start rules or Start)", () => {
    const { start: _, ...auto } = settings;
    const b = buildSortieInput(preset, master, data, auto);
    expect(b.input.config).not.toHaveProperty("start");
    expect(hasStartRules(routing)).toBe(false);
    expect(hasStartRules({ ...routing, start: { rules: [{ to: "Start2" }] } })).toBe(true);
  });
});

const sum = (count: number, o: Partial<SortieSummary> = {}): SortieSummary => ({
  count,
  paths: [{ path: ["Start", "A"], rate: 0.5 }, { path: ["Start", "B"], rate: 0.5 }],
  otherPathsRate: 0,
  nodes: { A: { reachRate: 0.5, battleRate: 0.5, rankRates: { SS: 0, S: 1, A: 0, B: 0, C: 0, D: 0, E: 0 }, retreatRate: 0, retreatHeavyRate: 0, retreatModerateRate: 0, nightRate: 0 } },
  boss: { reachRate: 0.5, rankRates: { SS: 0, S: 1, A: 0, B: 0, C: 0, D: 0, E: 0 }, killRate: 0.5, flagshipSunkRate: 0.5, flagshipDamageMean: 10 },
  retreatRate: 0.1, sunkRate: 0, battlesMean: 2, nodesMean: 3, fuelUsedMean: 5, ammoUsedMean: 6,
  bauxiteMean: 0, repair: { fuel: ZD, steel: ZD, timeSec: ZD, timeSecTotal: ZD },
  friend: [{ sunkRate: 0, heavyRate: 0.1, moderateRate: 0.2, damageTakenMean: 10, hpMissingMean: 5, fuelUsedMean: 1, ammoUsedMean: 1, bauxiteMean: 0, proficiencyLostMean: 0, repair: { fuel: ZD, steel: ZD, timeSec: ZD }, damecon: { usedRate: 0 } }],
  warnings: ["w1"], ...o,
});

describe("mergeSortieSummaries", () => {
  test("weights by sortie count; node reach uses all sorties; paths merge", () => {
    const a = sum(100);
    const b = sum(300, {
      paths: [{ path: ["Start", "A"], rate: 1 }], otherPathsRate: 0,
      nodes: { A: { ...sum(1).nodes.A, reachRate: 1, battleRate: 1, rankRates: { SS: 0, S: 0, A: 1, B: 0, C: 0, D: 0, E: 0 } } },
      boss: { ...sum(1).boss, reachRate: 0 },
      warnings: ["w2"],
    });
    const m = mergeSortieSummaries([a, b]);
    expect(m.count).toBe(400);
    expect(m.paths[0]).toEqual({ path: ["Start", "A"], rate: (0.5 * 100 + 300) / 400 });
    expect(m.otherPathsRate).toBeCloseTo(0, 9);
    expect(m.nodes.A.reachRate).toBeCloseTo((50 + 300) / 400);
    // rank rates are conditional on battles: 50 S-battles vs 300 A-battles
    expect(m.nodes.A.rankRates.S).toBeCloseTo(50 / 350);
    expect(m.boss.reachRate).toBeCloseTo(0.125);
    expect(m.warnings.sort()).toEqual(["w1", "w2"]);
    expect(m.friend[0].damageTakenMean).toBeCloseTo(10);
  });
});

describe("runSortieJob", () => {
  test("chunks, progress, separate gauge run", () => {
    const calls: [number, boolean][] = [];
    const seen: number[] = [];
    const g = { kind: "kill" as const, expectedSorties: 4, p50Sorties: 3, p90Sorties: 9, cappedRate: 0, runs: 10, remaining: 3 };
    const out = runSortieJob(
      (input, n) => (calls.push([n, !!input.gauge]), sum(n, input.gauge ? { gauge: g } : {})),
      { input: { friend: { ships: [] }, hqLevel: 1, map: {} as any }, count: 25, seed: 1, gaugeInput: { friend: { ships: [] }, hqLevel: 1, map: {} as any, gauge: g as any } },
      { chunk: 10, onProgress: (d, t) => seen.push(d / t) }
    );
    expect(calls).toEqual([[10, false], [10, false], [5, false], [20_000 > 25 ? 25 : 25, true]]);
    expect(out.count).toBe(25);
    expect(out.gauge?.expectedSorties).toBe(4);
    expect(seen.at(-1)).toBe(1);
  });
  test("geometric fallback", () => {
    expect(geometricSorties(0)).toBeNull();
    const r = geometricSorties(0.5)!;
    expect(r).toEqual({ mean: 2, p50: 1, p90: 4 });
    expect(geometricSorties(1)).toEqual({ mean: 1, p50: 1, p90: 1 });
  });
});
