import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { initSync, runBattle } from "@sim-core";
import type { BattleInput, ShipInput } from "@sim-core";
import { updateSettings } from "../app/settings";
import type { ShipDetail } from "../data/types";
import {
  applyEstimates, candidatesFromApi, candidatesFromResults, choosePrior, computeInProcess, estimateAll, makeApplyEstimates,
  pickEstimates, uploadEstimates,
} from "./estimate";
import { estimateFromObservations } from "./infer";
import { battleMorale, buildObservations, sortieFuelRates } from "./observe";
import { estimatesForSimulation, getEstimates, setEstimates } from "./store";
import { captureFromRun, syntheticWorld } from "./synthetic";
import type { SyntheticRecord } from "./synthetic";
import type { BattleRecord, EstimateResult, Observation } from "./types";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../sim-core/pkg/sim_core_bg.wasm", import.meta.url)) });
});

const ship = (id: number, o: Partial<ShipInput> = {}): ShipInput => ({
  id, shipType: 2, level: 50, maxHp: 40, morale: 49,
  stats: { firepower: 30, torpedo: 60, antiAir: 20, armor: 60, evasion: 60, asw: 0, los: 10, luck: 10 },
  slots: [{ id: 11, types: [1, 1, 1, 1, 0], stats: { firepower: 2, accuracy: 1 } }, { id: 12, types: [5, 5, 5, 5, 0], stats: { torpedo: 8 } }],
  ...o,
});
const FRIEND = [ship(9101), ship(9102, { fuelMax: 16 }), ship(9103)];
const ENEMY = [ship(1700, { level: 1, maxHp: 300, stats: { firepower: 8, torpedo: 20, antiAir: 5, armor: 200, evasion: 30, luck: 10 }, hiddenAccuracy: 20 })];
const world = syntheticWorld(FRIEND, ENEMY);

const battle = (seed: number, step = 1): SyntheticRecord[] => {
  const input: BattleInput = { friend: { ships: FRIEND }, enemy: { ships: [ENEMY[0], ENEMY[0], ENEMY[0]] }, options: { kind: "dayNight", log: true } };
  return captureFromRun(input, runBattle(input, seed), { id: `s${seed}`, capturedAt: seed * 100, step });
};

describe("observations", () => {
  test("morale cost mirrors the engine", () => {
    expect(battleMorale(49, "day")).toBe(46);
    expect(battleMorale(29, "day")).toBe(20);
    expect(battleMorale(49, "nightAfterDay")).toBe(44);
    expect(battleMorale(49, "nightOnly")).toBe(47);
    expect(battleMorale(2, "day")).toBe(0);
  });

  test("skip reasons: protected, unmodelled cut-ins, unsupported battles", () => {
    const [day] = battle(1);
    const base = buildObservations([day], world);
    const used = new Set(base.observations.map((o) => o.seq));
    const [cut, prot] = day.events.filter((e) => e.phase === "shelling1" && e.attackerSide === "friend" && used.has(e.seq)).map((e) => e.seq);
    const edited: BattleRecord = {
      battle: day.battle,
      events: day.events.map((e) => (e.seq === cut ? { ...e, attackType: 7 } : e.seq === prot ? { ...e, protected: true } : e)),
    };
    const r = buildObservations([edited], world);
    expect(r.observations.length).toBe(base.observations.length - 2);
    expect(r.skipped.cutin).toBe((base.skipped.cutin ?? 0) + 1);
    expect(r.skipped.protected).toBe((base.skipped.protected ?? 0) + 1);

    const combined = buildObservations([{ ...day, battle: { ...day.battle, path: "api_req_combined_battle/battle" } }], world);
    expect(combined.observations).toEqual([]);
    expect(combined.skipped.unsupportedBattle).toBe(day.events.length);

    const noMaster = buildObservations([day], { ...world, master: { ships: {}, equips: world.master.equips } });
    expect(noMaster.skipped.friendData).toBe(day.events.length);
  });

  test("includeCutins: false keeps only normal and double attacks", () => {
    const recs = [1, 2, 3, 4, 5].flatMap((s) => battle(s));
    const all = buildObservations(recs, world).observations;
    const plain = buildObservations(recs, { ...world, includeCutins: false }).observations;
    const special = (o: { query: { special?: string } }) => o.query.special ?? "normal";
    expect(all.some((o) => !["normal", "doubleAttack", "nightDoubleAttack"].includes(special(o)))).toBe(true);
    expect(plain.every((o) => ["normal", "doubleAttack", "nightDoubleAttack"].includes(special(o)))).toBe(true);
  });

  test("fuel without a supply snapshot: estimated from earlier nodes of the sortie", () => {
    const recs = [...battle(11, 1), ...battle(12, 2), ...battle(13, 3), ...battle(14, 1)].map(({ battle: b, events }) => {
      const fleet = { ...b.fleet! };
      delete fleet.supply;
      return { battle: { ...b, fleet }, events };
    });
    const rates = sortieFuelRates(recs, world.lookup);
    const expected = (r: BattleRecord) => (r.battle.id.startsWith("s14") ? [] : Array(r.battle.map!.step - 1).fill(0.2));
    for (const r of recs) expect(rates.get(r.battle.id)).toEqual(expected(r));
    // 3 マス目: 燃料 100 − 2·20 = 60%、最大 16 の艦は 16 − 2·3 = 10 → 62% (75% 未満なので回避が下がる)
    const third = new Set(recs.filter((r) => r.battle.map?.step === 3).map((r) => r.battle.id));
    const obs = buildObservations(recs, world).observations.filter((o) => o.role === "accuracy" && third.has(o.battleId));
    expect([...new Set(obs.map((o) => o.query.defender.fuel))].sort((a, b) => a! - b!)).toEqual([60, 62]);
  });
});

const detail = (rows: ShipDetail["estimates"], best: ShipDetail["best"] = {}): ShipDetail => ({
  ship: { id: 1700 } as ShipDetail["ship"],
  estimates: rows,
  best,
});
const row = (stat: "ev" | "acc" | "luck" | "tacc", value: number, confidence: ShipDetail["estimates"][number]["confidence"], source: string, updatedAt = "2026-01-01") => ({
  stat, value, confidence, source, sd: null, n: null, note: null, updatedAt,
});

describe("priors", () => {
  test("best non-estimator estimate by confidence, then newest", () => {
    const d = detail([
      row("ev", 50, "observed", "estimator:poi"),
      row("ev", 30, "placeholder", "kancolle-replay-shipdata"),
      row("ev", 41, "db_estimate", "a", "2026-01-01"),
      row("ev", 42, "db_estimate", "b", "2026-02-01"),
      row("luck", 9, "datamined", "kancolle-replay-shipdata"),
    ]);
    expect(choosePrior(d, "ev")).toMatchObject({ value: 42, confidence: "db_estimate", source: "b" });
    expect(choosePrior(d, "luck")).toMatchObject({ value: 9, confidence: "datamined" });
    // acc (generic hidden accuracy) is estimator-only, so it has no prior; tacc (torpedo-only) is never used for it
    expect(choosePrior(d, "acc")).toBeUndefined();
    expect(choosePrior(detail([row("tacc", 60, "datamined", "kancolle-replay-shipdata")], { tacc: { value: 60, confidence: "datamined", source: "kancolle-replay-shipdata" } }), "acc")).toBeUndefined();
    expect(choosePrior(undefined, "ev")).toBeUndefined();
  });

  test("prior widths: datamined narrow, db_estimate medium, placeholder flat", () => {
    const obs: Observation[] = [{
      shipId: 1700, role: "evasion", outcome: "hit", battleId: "x", seq: 0,
      query: { kind: "shelling", attacker: FRIEND[0], defender: { ...ENEMY[0], stats: { ...ENEMY[0].stats, evasion: 0, luck: 0 } } },
    }];
    const sd = (confidence: "datamined" | "db_estimate" | "placeholder") =>
      estimateFromObservations(obs, { 1700: { acc: { value: 50, confidence, source: "t" } } }).find((r) => r.stat === "acc")!.prior.sd;
    expect(sd("datamined")).toBeCloseTo(5, 1);
    expect(sd("db_estimate")).toBeCloseTo(15, 0);
    expect(sd("placeholder")).toBeCloseTo(Math.sqrt((201 ** 2 - 1) / 12), 6);
  });
});

describe("estimateAll", () => {
  test("db + api → observations, priors without estimator sources, results", async () => {
    const recs = [1, 2, 3].flatMap((s) => battle(s));
    const db = {
      listBattles: async () => recs.map((r) => r.battle),
      listEvents: async (id: string) => recs.find((r) => r.battle.id === id)!.events,
    };
    const shipDetail = detail([row("ev", 99, "observed", "estimator:poi"), row("ev", 30, "datamined", "kancolle-replay-shipdata")]);
    const api = {
      abyssalShips: async () => ({ data: [world.lookup.ship(1700)!] }),
      abyssalEquipments: async () => ({ data: [world.lookup.equip(11)!, world.lookup.equip(12)!] }),
      ship: async () => ({ data: shipDetail }),
    };
    const seen: number[] = [];
    const out = await estimateAll(db, api, { master: world.master, compute: computeInProcess, onProgress: (d) => seen.push(d) });
    expect(out.observe.observations).toBeGreaterThan(20);
    expect(out.observe.battles).toBe(recs.length);
    expect(out.priorErrors).toEqual([]);
    expect(out.results.map((r) => r.stat)).toEqual(["ev", "acc", "luck"]);
    const ev = out.results[0];
    expect(ev.prior).toMatchObject({ source: "kancolle-replay-shipdata", confidence: "datamined", value: 30 });
    expect(ev.ci90[0]).toBeLessThanOrEqual(30);
    expect(ev.ci90[1]).toBeGreaterThanOrEqual(30);
    expect(seen.length).toBeGreaterThan(0);
  });
});

const result = (stat: "ev" | "acc" | "luck", mean: number, n: number): EstimateResult => ({
  shipId: 1700, stat, mean, sd: 1, ci90: [mean - 2, mean + 2], n, priorSource: "flat",
  prior: { source: "flat", confidence: "none", value: null, sd: 50 },
});

describe("applyEstimates", () => {
  const api = candidatesFromApi([
    row("ev", 30, "placeholder", "p"), row("ev", 35, "datamined", "d"), row("luck", 8, "db_estimate", "e"),
    row("tacc", 60, "placeholder", "p"),
  ]);

  test("observed (n ≥ minN) > datamined > db_estimate > placeholder", () => {
    const local = candidatesFromResults([result("ev", 41.5, 500), result("acc", 22, 10), result("luck", 12, 510)], 1700);
    const picked = pickEstimates([...local, ...api]);
    expect(picked.ev?.value).toBe(41.5);
    expect(picked.acc).toBeUndefined(); // local acc n 10 < 30, and the API has no acc
    expect(picked.tacc?.value).toBe(60);
    expect(picked.luck?.value).toBe(12);
    expect(pickEstimates([...local, ...api], { minN: 600 }).ev?.value).toBe(35);

    const s = applyEstimates(ENEMY[0], [...local, ...api]);
    expect(s.stats.evasion).toBe(41.5);
    expect(s.stats.luck).toBe(12);
    expect(s.torpedoAccuracy).toBe(60);
    expect(s.hiddenAccuracy).toBe(ENEMY[0].hiddenAccuracy); // unchanged: local acc n 10 < 30
    expect(s.stats.firepower).toBe(ENEMY[0].stats.firepower);
  });

  test("hook for buildEnemyShips prefers local results over best", () => {
    const hook = makeApplyEstimates([result("ev", 44, 100)]);
    const s = hook(ENEMY[0], { shipId: 1700, best: { ev: { value: 30, confidence: "datamined", source: "d" }, tacc: { value: 7, confidence: "datamined", source: "d" } } });
    expect(s.stats.evasion).toBe(44);
    expect(s.torpedoAccuracy).toBe(7);
    expect(s.hiddenAccuracy).toBe(ENEMY[0].hiddenAccuracy); // tacc never lands in hiddenAccuracy
  });

  test("acc (generic) and tacc (torpedo) are separate stats", () => {
    const hook = makeApplyEstimates([result("acc", 4, 100)]);
    const s = hook(ENEMY[0], { shipId: 1700, best: { tacc: { value: 70, confidence: "datamined", source: "kancolle-replay-shipdata" } } });
    expect(s.hiddenAccuracy).toBe(4);
    expect(s.torpedoAccuracy).toBe(70);
    // API best acc (uploaded estimator result) is used when no local result qualifies
    const t = makeApplyEstimates([])(ENEMY[0], { shipId: 1700, best: { acc: { value: 11, confidence: "observed", source: "estimator:poi" }, tacc: { value: 70, confidence: "datamined", source: "k" } } });
    expect(t.hiddenAccuracy).toBe(11);
    expect(t.torpedoAccuracy).toBe(70);
  });
});

describe("uploadEstimates", () => {
  test("POSTs estimator:poi rows with n ≥ minN", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ stored: 2, source: "estimator:poi" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const stored = await uploadEstimates("http://x/", [result("ev", 41.234, 500), result("acc", 30, 5), result("luck", 9.5, 505)], { fetch });
    expect(stored).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://x/api/v1/estimates");
    expect(calls[0].body.source.key).toBe("estimator:poi");
    expect(calls[0].body.estimates).toEqual([
      expect.objectContaining({ shipId: 1700, stat: "ev", value: 41.23, sd: 1, n: 500 }),
      expect.objectContaining({ shipId: 1700, stat: "luck", value: 9.5, n: 505 }),
    ]);
  });
});

describe("estimate store", () => {
  test("simulation uses n ≥ 30 results only when the setting is on; densities are not persisted", () => {
    const withDensity = { ...result("ev", 40, 100), density: { min: 0, step: 1, posterior: [1], prior: [1] } };
    setEstimates({ results: [withDensity, result("acc", 20, 5)], observe: { skipped: {}, battles: 1, observations: 105 }, priorErrors: [] }, 123);
    expect(getEstimates()?.results[0].density).toBeDefined();
    updateSettings({ useEstimates: false });
    expect(estimatesForSimulation()).toBeUndefined();
    updateSettings({ useEstimates: true });
    expect(estimatesForSimulation()).toMatchObject({ at: 123, results: [{ stat: "ev", n: 100 }] });
    if (typeof localStorage !== "undefined") expect(localStorage.getItem("kcsim:estimates")).not.toContain("posterior");
    setEstimates(null);
    updateSettings({ useEstimates: false });
    expect(estimatesForSimulation()).toBeUndefined();
  });
});
