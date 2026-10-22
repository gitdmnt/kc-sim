import { describe, expect, test } from "bun:test";
import { backoffMs, classifyStatus, decideTick, planAfterResponse } from "../src/kcnav/throttle";
import { parseEnemyComps, parseMap } from "../src/kcnav/parse";
import { jobPath } from "../src/kcnav/enqueue";
import { store, tick, type QueueRow } from "../src/kcnav/tick";
import type { Env } from "../src/env";
import { FakeLimiter } from "./helpers";
import { createTestD1 } from "./d1-sqlite";

const MIN = 65_000;
const enemyComps = await Bun.file(new URL("./fixtures/kcnav-enemycomps-61-1-V.json", import.meta.url)).json();
const mapSample = await Bun.file(new URL("./fixtures/kcnav-map-61-1.json", import.meta.url)).json();

describe("throttle policy", () => {
  test("backoff doubles from the interval and caps at 6h", () => {
    expect(backoffMs(1, MIN)).toBe(65_000);
    expect(backoffMs(2, MIN)).toBe(130_000);
    expect(backoffMs(3, MIN)).toBe(260_000);
    expect(backoffMs(30, MIN)).toBe(6 * 3600_000);
  });

  test("status classes", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(503)).toBe("retry");
    expect(classifyStatus(0)).toBe("retry");
    expect(classifyStatus(404)).toBe("fail");
  });

  test("success: done, gate = request + interval", () => {
    expect(planAfterResponse({ status: 200, attempts: 0, requestedAt: 1_000, minIntervalMs: MIN }))
      .toEqual({ jobStatus: "done", attempts: 1, nextRunAt: 1_000, gateUntil: 66_000 });
  });

  test("429: retry with backoff and the global gate pushed out too", () => {
    const p = planAfterResponse({ status: 429, attempts: 2, requestedAt: 0, minIntervalMs: MIN });
    expect(p).toEqual({ jobStatus: "pending", attempts: 3, nextRunAt: 260_000, gateUntil: 260_000 });
  });

  test("5xx: job backs off, gate only the normal interval", () => {
    const p = planAfterResponse({ status: 502, attempts: 0, requestedAt: 0, minIntervalMs: MIN });
    expect(p).toEqual({ jobStatus: "pending", attempts: 1, nextRunAt: 65_000, gateUntil: 65_000 });
  });

  test("retries exhausted -> failed", () => {
    expect(planAfterResponse({ status: 500, attempts: 4, requestedAt: 0, minIntervalMs: MIN }).jobStatus).toBe("failed");
    expect(planAfterResponse({ status: 404, attempts: 0, requestedAt: 0, minIntervalMs: MIN }).jobStatus).toBe("failed");
  });

  test("decideTick", () => {
    expect(decideTick({ now: 100, nextAllowedAt: 0, nextJob: null })).toEqual({ action: "idle", waitMs: null });
    expect(decideTick({ now: 100, nextAllowedAt: 0, nextJob: { id: 1, nextRunAt: 0 } })).toEqual({ action: "request", jobId: 1 });
    expect(decideTick({ now: 100, nextAllowedAt: 500, nextJob: { id: 1, nextRunAt: 0 } })).toEqual({ action: "wait", waitMs: 400, reason: "gate" });
    expect(decideTick({ now: 100, nextAllowedAt: 0, nextJob: { id: 1, nextRunAt: 900 } })).toEqual({ action: "idle", waitMs: 800 });
  });
});

describe("KCNav parsers", () => {
  test("enemy comps grouped by difficulty with weights summing to 1", () => {
    const sets = parseEnemyComps(enemyComps, null, 0);
    expect(sets.map((s) => s.difficulty).sort()).toEqual([1, 2, 3, 4]);
    const total = sets.reduce((s, x) => s + x.totalCount, 0);
    expect(total).toBe(569);
    for (const s of sets) {
      expect(s.node).toBe("V");
      expect(s.comps.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(1, 10);
      for (const c of s.comps) expect(c.ships.filter((x) => x.fleet === 1)).toHaveLength(6);
    }
    const flag = sets.flatMap((s) => s.comps)[0]!.ships[0]!;
    expect(flag).toMatchObject({ fleet: 0, position: 0, shipId: 2328, hp: 880, fp: 286, tp: 130, aa: 90, ar: 268 });
  });

  test("map: start normalised, edge 0 dropped, boss from event id 5", () => {
    const m = parseMap(mapSample);
    expect(m.edges.find((e) => e.edgeId === 1)).toEqual({ edgeId: 1, from: "Start", to: "A" });
    expect(m.edges.some((e) => e.edgeId === 0)).toBe(false);
    const v = m.nodes.find((n) => n.letter === "V")!;
    expect(v).toMatchObject({ eventId: 5, isBoss: true, nodeType: "boss" });
    expect(m.nodes.find((n) => n.letter === "Start")!.nodeType).toBe("start");
  });

  test("stats KCNav omits (zero values) parse as 0; missing difficulty uses the job's", () => {
    const [set] = parseEnemyComps({ result: { entries: [{ node: "J", count: 3, mainFleet: [{ id: 1530, lvl: 50, hp: 19, torp: 42, armor: 7, equips: [1513] }] }] } }, null, 0);
    expect(set!.difficulty).toBe(0);
    expect(set!.comps[0]!.ships[0]).toMatchObject({ fp: 0, aa: 0, tp: 42, ar: 7, hp: 19 });
  });

  test("malformed payload throws", () => {
    expect(() => parseEnemyComps({ result: { entries: [{ count: "x" }] } }, "A", 0)).toThrow();
    expect(() => parseMap({ error: "rate limited" })).toThrow();
  });

  test("job paths", () => {
    expect(jobPath("map", 15)).toBe("/api/routing/maps/1-5");
    expect(jobPath("enemycomps", 621, { node: "A2", start: "2026-08-01", difficulty: 4 }))
      .toBe("/api/routing/maps/62-1/nodes/A2/enemycomps?start=2026-08-01&difficulty=4");
  });
});

describe("tick against D1 (time injected)", () => {
  function setup() {
    const env: Env = { DB: createTestD1(), KCNAV_BASE: "https://kcnav.test", KCNAV_MIN_INTERVAL_MS: String(MIN), WRITE_LIMITER: new FakeLimiter() };
    const calls: string[] = [];
    let respond: (url: string) => Response = () => Response.json(enemyComps);
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return respond(url);
    }) as unknown as typeof fetch;
    const at = (now: number) => ({ now: () => now, fetch: fakeFetch });
    const add = (path: string, kind = "enemycomps", node: string | null = "V") =>
      env.DB.prepare("INSERT INTO kcnav_queue (kind, path, map_id, node_letter, created_at, updated_at) VALUES (?1, ?2, 611, ?3, 0, 0)").bind(kind, path, node).run();
    return { env, calls, at, add, setRespond: (f: typeof respond) => (respond = f) };
  }

  test("never two requests within the interval, across restarts", async () => {
    const t = setup();
    await t.add("/api/routing/maps/61-1/nodes/V/enemycomps?start=2026-01-01");
    await t.add("/api/routing/maps/61-1/nodes/U/enemycomps?start=2026-01-01");
    const T0 = 1_800_000_000_000;
    const r1 = await tick(t.env, t.at(T0));
    expect(r1.action).toBe("requested");
    // A second tick 1 s later (e.g. a restarted loop) must wait for the persisted gate.
    expect(await tick(t.env, t.at(T0 + 1_000))).toEqual({ action: "wait", waitMs: MIN - 1_000, reason: "gate" });
    expect(await tick(t.env, t.at(T0 + MIN - 1))).toMatchObject({ action: "wait", waitMs: 1 });
    expect((await tick(t.env, t.at(T0 + MIN))).action).toBe("requested");
    expect(t.calls).toHaveLength(2);
    expect(await tick(t.env, t.at(T0 + 3 * MIN))).toEqual({ action: "idle", waitMs: null });
  });

  test("success stores comp sets with weights; 429 backs off job and gate", async () => {
    const t = setup();
    await t.add("/api/routing/maps/61-1/nodes/V/enemycomps?start=2026-01-01");
    await tick(t.env, t.at(1_000_000));
    const sets = await t.env.DB.prepare("SELECT difficulty, total_count, period_start FROM enemy_comp_sets ORDER BY difficulty").all();
    expect(sets.results).toHaveLength(4);
    expect(sets.results[0]).toMatchObject({ difficulty: 1, period_start: "2026-01-01" });
    const w = await t.env.DB.prepare("SELECT s.difficulty, SUM(c.weight) AS w FROM enemy_comps c JOIN enemy_comp_sets s ON s.id = c.set_id GROUP BY s.difficulty").all<{ w: number }>();
    for (const r of w.results) expect(r.w).toBeCloseTo(1, 10);
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM enemy_comp_ships").first<{ n: number }>())!.n).toBe(8 * 12);

    // Re-fetching the same window replaces the sets instead of duplicating them.
    await t.env.DB.prepare("UPDATE kcnav_queue SET status = 'pending'").run();
    await tick(t.env, t.at(1_000_000 + MIN));
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM enemy_comp_sets").first<{ n: number }>())!.n).toBe(4);

    await t.add("/api/routing/maps/61-1/nodes/U/enemycomps?start=2026-01-01");
    t.setRespond(() => new Response("slow down", { status: 429 }));
    const T = 1_000_000 + 2 * MIN;
    const r = await tick(t.env, t.at(T));
    expect(r).toMatchObject({ action: "requested", status: 429, jobStatus: "pending" });
    const job = await t.env.DB.prepare("SELECT attempts, next_run_at, status FROM kcnav_queue WHERE path LIKE '%/U/%'").first();
    expect(job).toEqual({ attempts: 1, next_run_at: T + MIN, status: "pending" });
    expect(await tick(t.env, t.at(T + 10_000))).toMatchObject({ action: "idle", waitMs: MIN - 10_000 });
  });

  test("malformed 200 payload fails the job without retrying", async () => {
    const t = setup();
    await t.add("/api/routing/maps/61-1/nodes/V/enemycomps?start=2026-01-01");
    t.setRespond(() => Response.json({ error: "nope" }));
    expect(await tick(t.env, t.at(5_000_000))).toMatchObject({ action: "requested", status: 200, jobStatus: "failed" });
  });

  test("map job fills node types and keeps existing edges", async () => {
    const t = setup();
    await t.add("/api/routing/maps/61-1", "map", null);
    t.setRespond(() => Response.json(mapSample));
    expect(await tick(t.env, t.at(9_000_000))).toMatchObject({ jobStatus: "done" });
    const v = await t.env.DB.prepare("SELECT node_type, is_boss, event_id FROM nodes WHERE map_id = 611 AND letter = 'V'").first();
    expect(v).toEqual({ node_type: "boss", is_boss: 1, event_id: 5 });
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM edges WHERE map_id = 611").first<{ n: number }>())!.n).toBe(29);
  });
});

describe("store: non-combat nodes", () => {
  test("comp sets for nodes typed non-combat are dropped", async () => {
    const env: Env = { DB: createTestD1(), KCNAV_BASE: "https://kcnav.test", KCNAV_MIN_INTERVAL_MS: String(MIN), WRITE_LIMITER: new FakeLimiter() };
    await env.DB.prepare("INSERT INTO nodes (map_id, letter, node_type) VALUES (14, 'A', 'empty'), (14, 'J', 'battle')").run();
    await env.DB.prepare("INSERT INTO kcnav_queue (kind, path, map_id, created_at, updated_at) VALUES ('enemycomps', '/api/routing/maps/1-4/edges/1,2/enemycomps?start=2026-01-01', 14, 0, 0)").run();
    const body = { result: { entries: [
      { node: "A", count: 1, mainFleet: [{ id: 1501, hp: 20 }] },
      { node: "J", count: 9, mainFleet: [{ id: 1502, hp: 22 }] },
    ] } };
    const r = await tick(env, { now: () => 1_000, fetch: async () => Response.json(body) });
    expect(r).toMatchObject({ jobStatus: "done" });
    if (r.action === "requested") expect(r.summary).toContain("skipped non-combat A(n=1)");
    const sets = await env.DB.prepare("SELECT node_letter FROM enemy_comp_sets").all<{ node_letter: string }>();
    expect(sets.results.map((s) => s.node_letter)).toEqual(["J"]);
  });
});

describe("store: enemycomps D1 calls", () => {
  // Counts D1 round trips: prepare().first/all/run and batch() each count as one.
  function counting(db: D1Database) {
    const n = { calls: 0 };
    const wrap = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, {
      get(t, p) {
        if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (p === "first" || p === "all" || p === "run") n.calls++;
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const d1 = {
      prepare: (sql: string) => wrap(db.prepare(sql)),
      batch: (stmts: D1PreparedStatement[]) => (n.calls++, db.batch(stmts)),
    } as unknown as D1Database;
    return { d1, n };
  }

  test("a whole response in ≤ 5 calls; rows match the parsed comps", async () => {
    const { d1, n } = counting(createTestD1());
    const job: QueueRow = { id: 1, kind: "enemycomps", path: "/api/routing/maps/61-1/nodes/V/enemycomps?start=2026-01-01", map_id: 611, node_letter: "V", difficulty: 0, attempts: 0, next_run_at: 0 };
    const expected = parseEnemyComps(enemyComps, "V", 0);
    for (let round = 0; round < 2; round++) { // the second store replaces the first
      n.calls = 0;
      await store(d1, job, enemyComps, 7, "2026-01-02T00:00:00.000Z");
      expect(n.calls).toBeLessThanOrEqual(5);
      const sets = (await d1.prepare("SELECT id, node_letter, difficulty, period_start, period_end, total_count, cache_id FROM enemy_comp_sets ORDER BY id").all<{ id: number }>()).results;
      expect(sets.map(({ id: _, ...s }) => s)).toEqual(expected.map((s) => ({
        node_letter: "V", difficulty: s.difficulty, period_start: "2026-01-01", period_end: "", total_count: s.totalCount, cache_id: 7,
      })));
      for (const [i, set] of sets.entries()) {
        const comps = (await d1.prepare("SELECT id, kcnav_master_id, formation, count, weight, airpower, lbas_airpower FROM enemy_comps WHERE set_id = ?1 ORDER BY id")
          .bind(set.id).all<{ id: number }>()).results;
        expect(comps.map(({ id: _, ...c }) => c)).toEqual(expected[i]!.comps.map((c) => ({
          kcnav_master_id: c.kcnavMasterId, formation: c.formation, count: c.count, weight: c.weight,
          airpower: c.airpower ? JSON.stringify(c.airpower) : null, lbas_airpower: c.lbasAirpower ? JSON.stringify(c.lbasAirpower) : null,
        })));
        for (const [j, comp] of comps.entries()) {
          const ships = (await d1.prepare("SELECT fleet, position, ship_id, level, hp, fp, tp, aa, ar, equips FROM enemy_comp_ships WHERE comp_id = ?1 ORDER BY rowid")
            .bind(comp.id).all()).results;
          expect(ships).toEqual(expected[i]!.comps[j]!.ships.map((sh) => ({
            fleet: sh.fleet, position: sh.position, ship_id: sh.shipId, level: sh.level, hp: sh.hp, fp: sh.fp, tp: sh.tp, aa: sh.aa, ar: sh.ar,
            equips: JSON.stringify(sh.equips),
          })));
        }
      }
      expect((await d1.prepare("SELECT COUNT(*) AS n FROM enemy_comp_ships").first<{ n: number }>())!.n).toBe(8 * 12);
    }
  });
});
