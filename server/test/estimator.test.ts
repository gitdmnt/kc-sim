// Server estimator job (src/estimator/job.ts) on synthetic data: battles from sim-core runBattle are encoded as
// game battle responses, uploaded through the API (validated and re-parsed on the server), folded
// incrementally under the production CPU budget (cost model), and must recover the known hidden stats like the
// plugin's recovery test (shared/estimate/recovery.test.ts) did.
import { beforeAll, describe, expect, test } from "bun:test";
import { runBattle } from "../../sim-core/pkg/sim_core";
import type { BattleInput, EquipmentInput, Formation, ShipInput } from "../../sim-core/pkg/sim_core";
import { extractAttackEvents } from "../../shared/capture/parser";
import { estimateFromObservations } from "../../shared/estimate/infer";
import { buildObservations } from "../../shared/estimate/observe";
import { captureFromRun, syntheticWorld, type SyntheticRecord } from "../../shared/estimate/synthetic";
import type { EstimateResult } from "../../shared/estimate/types";
import { compactDensity } from "../src/estimator/job";
import { bunGrid } from "../scripts/lib/sim-core";
import { harness, LAYOUT_15, seedEdges15, seedMaster, seedSynthetic, sortieOf, T0, uploadAndProcess, type Harness } from "./helpers";

const gun = (id: number, fp: number, acc: number): EquipmentInput => ({ id, types: [1, 1, 2, 2, 0], stats: { firepower: fp, accuracy: acc, range: 2 } });
const smallGun = (id: number): EquipmentInput => ({ id, types: [1, 1, 1, 1, 0], stats: { firepower: 2, accuracy: 1, range: 1 } });
const torp = (id: number): EquipmentInput => ({ id, types: [5, 5, 5, 5, 0], stats: { torpedo: 10, accuracy: 1, range: 1 } });
const friendShip = (id: number, shipType: number, level: number, ev: number, luck: number, slots: (EquipmentInput | null)[], o: Partial<ShipInput> = {}): ShipInput => ({
  id, shipType, level, maxHp: 60, morale: 49, stats: { firepower: 40, torpedo: 60, antiAir: 30, armor: 90, evasion: ev, asw: 40, los: 20, luck }, slots, ...o,
});
const FRIEND: ShipInput[] = [
  friendShip(101, 5, 60, 45, 12, [gun(201, 8, 2), gun(201, 8, 2), null], { morale: 53 }),
  friendShip(102, 3, 50, 60, 15, [smallGun(202), torp(203), null]),
  friendShip(103, 2, 45, 75, 20, [smallGun(202), smallGun(202), null], { fuel: 8, fuelMax: 16 }),
  friendShip(104, 2, 55, 70, 30, [torp(203), torp(203), null]),
  friendShip(105, 2, 40, 65, 10, [smallGun(202), torp(203), null]),
  friendShip(106, 2, 50, 80, 8, [smallGun(202), torp(203), smallGun(202)]),
];
const TRUE = { ev: 40, luck: 10, acc: 30 };
const TARGET: ShipInput = {
  id: 1700, shipType: 3, level: 1, maxHp: 400,
  stats: { firepower: 10, torpedo: 20, antiAir: 10, armor: 250, evasion: TRUE.ev, luck: TRUE.luck },
  hiddenAccuracy: TRUE.acc,
  slots: [{ id: 1550, types: [1, 1, 1, 1, 0], stats: { firepower: 3, accuracy: 2 } }, { id: 1551, types: [3, 5, 5, 5, 0], stats: { torpedo: 10 } }],
};
const ENEMY = [TARGET, TARGET, TARGET, TARGET, TARGET, TARGET];
const FORMATIONS: Formation[] = ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast"];

const simulate = (battles: number, seed: number): SyntheticRecord[] => {
  const records: SyntheticRecord[] = [];
  for (let i = 0; i < battles; i++) {
    const input: BattleInput = {
      friend: { ships: FRIEND, formation: FORMATIONS[(seed + i) % 5] },
      enemy: { ships: ENEMY, formation: FORMATIONS[(seed * 7 + i * 3) % 5] },
      options: { kind: "dayNight", log: true },
    };
    // captured over the last two days (validation rejects data older than 30 days)
    records.push(...captureFromRun(input, runBattle(input, seed * 100_000 + i), { id: `s${seed}-b${i}`, capturedAt: T0 - 2 * 86_400_000 + i * 60_000 }));
  }
  return records;
};

/** Upload items as the plugin sends them (≤ 100 per request and ≤ 256 KiB, one request per 60 s). */
const toUpload = (r: SyntheticRecord) => ({
  clientObsId: r.battle.id, observedAt: new Date(r.battle.capturedAt).toISOString(), map: "1-5", cell: 1, layout: LAYOUT_15, difficulty: 0,
  kind: "battle", fleet: r.battle.fleet, raw: { path: r.battle.path, visitId: r.battle.visitId, sortieId: null as string | null, raw: r.battle.raw, result: null },
});

interface EstimatesJson {
  source: string; updatedAt: string | null;
  estimates: (EstimateResult & { updatedAt: string; density?: { min: number; step: number; posterior: number[]; prior: number[] } })[];
}

let h: Harness;
let token: string;
let clientId: string;
let first: SyntheticRecord[];
/**
 * Uploads the battles with one sortie per cell visit (day + night), one upload per day (each stays below the
 * per-client daily cap per enemy ship); `accepted` etc. count the battles.
 */
const upload = async (records: SyntheticRecord[]) => {
  const out = { accepted: 0, rejected: 0, quarantined: 0 };
  for (let i = 0; i < records.length; i += 40) {
    h.clock.t += 86_400_000;
    const battles = records.slice(i, i + 40).map(toUpload);
    const visits = [...new Set(battles.map((b) => b.raw.visitId))];
    const sorties = visits.map((v) => sortieOf(battles.filter((b) => b.raw.visitId === v)));
    const r = await uploadAndProcess(h, token, [...battles, ...sorties]);
    expect(r.status).toBe(202);
    out.accepted += r.accepted - sorties.length;
    out.rejected += r.rejected.length;
    out.quarantined += r.quarantined;
  }
  return out;
};
interface RunJson { busy: boolean; observations: number; gridCalls: number; spentMs: number; remaining: { observations: number; signatures: number; dirtyShips: number } }
/** Runs the admin job until nothing is left, with a small budget so that the work spans several runs. */
const runAll = async (budgetMs: number) => {
  const runs: RunJson[] = [];
  for (let i = 0; i < 2000; i++) {
    const r = await h.call<RunJson>("POST", "/admin/estimate/run", { body: { budgetMs } });
    expect(r.json.busy).toBe(false);
    expect(r.json.spentMs).toBeLessThanOrEqual(budgetMs + 1e-9);
    runs.push(r.json);
    const left = r.json.remaining;
    if (left.observations + left.signatures + left.dirtyShips === 0) break;
  }
  return runs;
};

beforeAll(async () => {
  bunGrid();
  h = harness();
  await seedSynthetic(h.db, FRIEND, [TARGET]);
  await seedMaster(h.db, { maps: [{ id: 15 }] });
  await seedEdges15(h.db);
  // datamined luck prior at the truth (kcSHIPDATA); ev / acc have no prior (flat), as in the plugin's recovery test
  await h.db.batch([
    h.db.prepare("INSERT INTO sources (key, name, fetched_at) VALUES ('kancolle-replay-shipdata', 'kcSHIPDATA', '2026-10-01T00:00:00Z')"),
    h.db.prepare(`INSERT INTO estimates (ship_id, stat, value, confidence, source_id, updated_at)
      VALUES (1700, 'luck', ?1, 'datamined', (SELECT id FROM sources WHERE key = 'kancolle-replay-shipdata'), '2026-10-01T00:00:00Z')`).bind(TRUE.luck),
  ]);
  ({ token, clientId } = await h.register());
  first = simulate(60, 1);
});

describe("server estimator", () => {
  test("synthetic battle responses pass validation and are queued per enemy ship", async () => {
    expect(await upload(first)).toEqual({ accepted: first.length, rejected: 0, quarantined: 0 });
    expect(await h.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT ship_id) AS ships FROM observation_ships WHERE est_at IS NULL").first())
      .toEqual({ n: first.length, ships: 1 });
  });

  test("incremental runs under the CPU budget recover the known ev / acc and equal a one-shot estimate", async () => {
    const runs = await runAll(5);
    expect(runs.length).toBeGreaterThan(2); // the budget split the work
    expect(runs.reduce((s, r) => s + r.observations, 0)).toBe(first.length);

    const res = await h.call<EstimatesJson>("GET", "/api/v1/estimates?shipId=1700");
    expect(res.json.source).toBe("estimator:server");
    const row = (stat: string) => res.json.estimates.find((e) => e.stat === stat)!;
    const ev = row("ev");
    const acc = row("acc");
    console.log(`server: ev ${ev.mean.toFixed(1)} ± ${ev.sd.toFixed(1)} [${ev.ci90}] n=${ev.n} | acc ${acc.mean.toFixed(1)} ± ${acc.sd.toFixed(1)} [${acc.ci90}] n=${acc.n}`);
    expect(ev.n).toBeGreaterThan(300);
    expect(acc.n).toBeGreaterThan(150);
    for (const [r, truth] of [[ev, TRUE.ev], [acc, TRUE.acc]] as const) {
      expect(r.ci90[0]).toBeLessThanOrEqual(truth);
      expect(r.ci90[1]).toBeGreaterThanOrEqual(truth);
      expect(Math.abs(r.mean - truth)).toBeLessThan(2.5 * r.sd);
    }
    expect(row("luck").prior).toMatchObject({ source: "kancolle-replay-shipdata", confidence: "datamined", value: TRUE.luck });
    expect(ev.prior).toMatchObject({ source: "flat", confidence: "none", value: null });

    // the same rolls in one in-process pass (events re-parsed from the uploaded responses, as the server does)
    const reparsed = first.map((r) => ({ battle: { ...r.battle, id: r.battle.id }, events: extractAttackEvents(r.battle.raw, r.battle.path) }));
    const world = syntheticWorld(FRIEND, [TARGET]);
    const oneShot = estimateFromObservations(buildObservations(reparsed, world).observations,
      { 1700: { luck: { value: TRUE.luck, confidence: "datamined", source: "kancolle-replay-shipdata" } } }, { gridFn: bunGrid() });
    for (const stat of ["ev", "acc", "luck"] as const) {
      const a = oneShot.find((x) => x.stat === stat)!;
      const b = row(stat);
      expect(b.n).toBe(a.n);
      expect(Math.abs(b.mean - a.mean)).toBeLessThan(0.01);
      expect(Math.abs(b.sd - a.sd)).toBeLessThan(0.01);
      expect(b.ci90).toEqual(a.ci90);
      expect(b.density).toEqual(compactDensity(a.density!));
    }
  });

  test("GET /estimates: compact density, filters; ships/{id} gets estimator:server rows (n ≥ 30) and best", async () => {
    const one = await h.call<EstimatesJson>("GET", "/api/v1/estimates?shipId=1700&stat=ev");
    const d = one.json.estimates[0]!.density!;
    expect(d.posterior.length).toBeLessThanOrEqual(101);
    expect(d.step).toBe(2);
    expect(Math.abs(d.posterior.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-4);
    expect(Math.abs(d.prior.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-4);
    // the list without shipId omits densities unless asked for
    const all = await h.call<EstimatesJson>("GET", "/api/v1/estimates");
    expect(all.json.estimates.map((e) => [e.shipId, e.stat])).toEqual([[1700, "ev"], [1700, "acc"], [1700, "luck"]]);
    expect(all.json.estimates[0]!.density).toBeUndefined();
    expect((await h.call<EstimatesJson>("GET", "/api/v1/estimates?shipId=1700&density=1")).json.estimates[0]!.density).toBeDefined();
    expect((await h.call("GET", "/api/v1/estimates?density=1")).status).toBe(400); // densities only for ≤ 50 ships
    expect((await h.call<EstimatesJson>("GET", "/api/v1/estimates?minN=100000")).json.estimates).toEqual([]);
    for (const q of ["shipId=x", "stat=hp", "minN=-1", "density=2"]) expect((await h.call("GET", `/api/v1/estimates?${q}`)).status).toBe(400);

    const ship = await h.call<{ estimates: { stat: string; source: string; confidence: string; n: number; ci90: [number, number] | null }[]; best: Record<string, { source: string }> }>("GET", "/api/v1/ships/1700");
    const server = ship.json.estimates.filter((e) => e.source === "estimator:server");
    expect(server.map((e) => e.stat).sort()).toEqual(["acc", "ev", "luck"]);
    expect(server.every((e) => e.confidence === "observed" && e.n >= 30 && e.ci90 !== null)).toBe(true);
    expect(ship.json.estimates.find((e) => e.source === "kancolle-replay-shipdata")!.ci90).toBeNull();
    expect(ship.json.best.ev!.source).toBe("estimator:server");
  });

  test("new uploads are folded incrementally (old observations are not re-processed)", async () => {
    const before = (await h.call<EstimatesJson>("GET", "/api/v1/estimates?shipId=1700&stat=ev")).json.estimates[0]!;
    const more = simulate(10, 2);
    await upload(more);
    const runs = await runAll(5000);
    expect(runs.reduce((s, r) => s + r.observations, 0)).toBe(more.length);
    const after = (await h.call<EstimatesJson>("GET", "/api/v1/estimates?shipId=1700&stat=ev")).json.estimates[0]!;
    expect(after.n).toBeGreaterThan(before.n);
    expect(after.updatedAt >= before.updatedAt).toBe(true);
  });

  test("lease: a run while another holds the lock reports busy", async () => {
    await h.db.prepare("UPDATE kv_state SET value = ?1 WHERE key = 'jobs_lock_until'").bind(String(Date.now() + 60_000)).run();
    expect((await h.call<{ busy: boolean }>("POST", "/admin/estimate/run", { body: {} })).json.busy).toBe(true);
    await h.db.prepare("UPDATE kv_state SET value = '0' WHERE key = 'jobs_lock_until'").run();
  });

  test("deleting the client resets the ships it fed; a rebuild refolds the rest", async () => {
    const del = await h.call<{ deleted: number; client: boolean; estimatorReset: number[] }>("DELETE", `/admin/clients/${clientId}`);
    expect(del.json).toMatchObject({ client: true, estimatorReset: [1700] });
    expect((await h.call<EstimatesJson>("GET", "/api/v1/estimates")).json.estimates).toEqual([]);
    expect((await h.call("POST", "/api/v1/observations", { token, body: { observations: [] } })).status).toBe(401);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM estimates WHERE source_id = (SELECT id FROM sources WHERE key = 'estimator:server')").first()).toEqual({ n: 0 });
  });
});
