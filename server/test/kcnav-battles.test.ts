import { describe, expect, test } from "bun:test";
import { battleKind, battleRank, normalizeBattle } from "../src/kcnav/battles";
import { enqueue, jobPath } from "../src/kcnav/enqueue";
import { reparseCached, tick } from "../src/kcnav/tick";
import { Budget } from "../src/budget";
import type { Env } from "../src/env";
import { FakeLimiter } from "./helpers";
import { createTestD1 } from "./d1-sqlite";

const MIN = 65_000;
// Trimmed pages of `…/edges/{e}/battles?start=2026-09-23&end=2026-10-22&page=0` (2026-10-23): 7-4 P (single enemy
// fleet, land bases), 6-5 M (enemy combined fleet), and 2-5 O (KCNav keeps no battles for that map).
const page74P = await Bun.file(new URL("./fixtures/kcnav-battles-7-4-P.json", import.meta.url)).json();
const page65M = await Bun.file(new URL("./fixtures/kcnav-battles-6-5-M.json", import.meta.url)).json();
const page25O = await Bun.file(new URL("./fixtures/kcnav-battles-2-5-O-empty.json", import.meta.url)).json();

describe("battles: normalize", () => {
  test("day results match the night packet's starting HP (packets, not KCNav's results)", () => {
    const night = [...page74P.result.battles, ...page65M.result.battles].filter((b) => b.battle.yasen_rawapi);
    expect(night.length).toBeGreaterThanOrEqual(3);
    for (const b of night) expect(normalizeBattle(b).outcome.verified).toBe(true);
  });

  test("7-4 P: single fleets, land bases, HP and phases", () => {
    const n = normalizeBattle(page74P.result.battles[0]);
    expect(n).toMatchObject({ map: "7-4", kind: "dayNight", enemyCombined: false, fleetType: 0, support: false, friendFleet: false });
    expect(n.lbasWaves).toBeGreaterThan(0);
    expect(n.outcome.friend).toHaveLength(n.outcome.friendMain);
    expect(n.outcome.phases.lbas?.[0]).toBeGreaterThan(0);
    // Every HP point lost is accounted to a phase (overkill makes the phase sums ≥ the HP lost).
    const lost = (ships: [number, number, number][]) => ships.reduce((s, [, b, a]) => s + b - a, 0);
    const phaseSum = (k: 0 | 1) => Object.values(n.outcome.phases).reduce((s, v) => s + v![k], 0);
    expect(phaseSum(0)).toBeGreaterThanOrEqual(lost(n.outcome.enemy));
    expect(phaseSum(1)).toBe(lost(n.outcome.friend));
    for (const [max, before, after] of [...n.outcome.friend, ...n.outcome.enemy]) {
      expect(before).toBeLessThanOrEqual(max);
      expect(after).toBeGreaterThanOrEqual(0);
      expect(after).toBeLessThanOrEqual(before);
    }
    const dayOnly = page74P.result.battles.find((b: { battle: { yasen_rawapi: unknown } }) => !b.battle.yasen_rawapi);
    expect(normalizeBattle(dayOnly)).toMatchObject({ kind: "day", yasenApiName: null, outcome: { dayEnd: null, verified: null } });
  });

  test("6-5 M: the enemy escort follows the main fleet", () => {
    const n = normalizeBattle(page65M.result.battles[0]);
    expect(n).toMatchObject({ enemyCombined: true, kind: "dayNight", formation: 1, enemyFormation: 13 });
    expect(n.outcome.enemyMain).toBe(6);
    expect(n.outcome.enemy).toHaveLength(12);
  });

  test("kinds and ranks", () => {
    expect(battleKind("api_req_sortie/battle", false)).toBe("day");
    expect(battleKind("api_req_combined_battle/ec_battle", true)).toBe("dayNight");
    expect(battleKind("api_req_combined_battle/battle_water", false)).toBe("day");
    expect(battleKind("api_req_battle_midnight/sp_midnight", false)).toBe("nightOnly");
    expect(battleKind("api_req_sortie/ld_airbattle", false)).toBe("airRaid");
    expect(battleKind("api_req_sortie/airbattle", false)).toBe("airBattle");
    expect(battleKind("api_req_sortie/ld_shooting", false)).toBeNull();
    expect(battleKind("api_req_sortie/night_to_day", false)).toBeNull();

    const full = (hp: number): [number, number, number] => [hp, hp, hp];
    const sunk = (hp: number): [number, number, number] => [hp, hp, 0];
    expect(battleRank([full(40)], [sunk(30), sunk(20)])).toBe("SS");
    expect(battleRank([[40, 40, 30]], [sunk(30), sunk(20)])).toBe("S");
    expect(battleRank([full(40), full(40)], [full(30), sunk(20), sunk(20), sunk(20)])).toBe("A");
    expect(battleRank([full(40)], [sunk(30), full(20), full(20), full(20), full(20), full(20)])).toBe("B");
    expect(battleRank([[40, 40, 8]], [[30, 30, 29]])).toBe("D");
    expect(battleRank([[100, 100, 99]], [[100, 100, 50]])).toBe("B");
    expect(battleRank([[100, 100, 70]], [[100, 100, 70]])).toBe("C");
    expect(battleRank([[100, 100, 90]], [[100, 100, 99]])).toBe("D");
    expect(battleRank([[100, 100, 100], [100, 100, 0]], [full(100)])).toBe("E");
    expect(battleRank([[100, 100, 95]], [full(100)], true)).toBe("A");
  });

  test("an entry without packets is rejected", () => {
    expect(() => normalizeBattle({ battle: { id: 1 } })).toThrow();
  });
});

describe("battles: queue and store", () => {
  function setup() {
    const env: Env = { DB: createTestD1(), KCNAV_BASE: "https://kcnav.test", KCNAV_MIN_INTERVAL_MS: String(MIN), WRITE_LIMITER: new FakeLimiter() };
    const calls: string[] = [];
    let body: unknown = page74P;
    const at = (now: number) => ({ now: () => now, fetch: async (url: string) => (calls.push(url), Response.json(body)) });
    return { env, calls, at, respond: (b: unknown) => (body = b) };
  }

  test("job path: every edge into the node, page and perPage last", () => {
    expect(jobPath("battles", 74, { edges: [23, 16, 22, 21], start: "2026-09-23", end: "2026-10-22", page: 2, perPage: 50 }))
      .toBe("/api/routing/maps/7-4/edges/16,21,22,23/battles?start=2026-09-23&end=2026-10-22&page=2&perPage=50");
  });

  test("enqueue pages per node; storing page 0 drops pending pages past pageCount and stubs the cache", async () => {
    const t = setup();
    await t.env.DB.prepare(`INSERT INTO edges (map_id, edge_id, from_letter, to_letter) VALUES
      (74, 16, 'J', 'P'), (74, 21, 'K', 'P'), (74, 22, 'L', 'P'), (74, 23, 'M', 'P'), (74, 3, 'Start', 'C')`).run();
    await t.env.DB.prepare("INSERT INTO nodes (map_id, letter, node_type) VALUES (74, 'P', 'boss'), (74, 'C', 'battle')").run();
    const q = await enqueue(t.env, { maps: [74], kinds: ["battles"], start: "2026-09-23", end: "2026-10-22", pages: 3 }, 0);
    expect(q.enqueued).toHaveLength(6);
    expect(q.enqueued.filter((p) => p.includes("/edges/16,21,22,23/"))).toHaveLength(3);

    const onlyP = { ...page74P, result: { ...page74P.result, pageCount: 2 } };
    t.respond(onlyP);
    // C's jobs come first by id; restrict this tick to P by marking C done.
    await t.env.DB.prepare("UPDATE kcnav_queue SET status = 'done' WHERE node_letter = 'C'").run();
    const r = await tick(t.env, t.at(1_000_000), { only: ["battles"] });
    expect(r).toMatchObject({ action: "requested", jobStatus: "done" });
    if (r.action === "requested") expect(r.summary).toContain("1 pending page(s) past the end dropped");
    const rows = await t.env.DB.prepare("SELECT id, node_letter, kind, rank, verified FROM kcnav_battles ORDER BY id").all();
    expect(rows.results).toHaveLength(page74P.result.battles.length);
    expect(rows.results.every((x) => (x as { node_letter: string }).node_letter === "P")).toBe(true);
    const pending = await t.env.DB.prepare("SELECT path FROM kcnav_queue WHERE status = 'pending'").all<{ path: string }>();
    expect(pending.results.map((p) => p.path)).toEqual([expect.stringContaining("page=1&perPage=50")]);
    const cached = await t.env.DB.prepare("SELECT body FROM kcnav_cache").first<{ body: string }>();
    expect(JSON.parse(cached!.body).result).toMatchObject({ storedIn: "kcnav_battles", pageCount: 2 });

    // Re-parsing the stub re-normalizes from the stored raw entries without a request.
    await t.env.DB.prepare("UPDATE kcnav_battles SET rank = 'X', outcome = '{}'").run();
    const re = await reparseCached(t.env, new Budget(60_000, 100), 0);
    expect(re.reparsed).toEqual([expect.stringContaining(`${page74P.result.battles.length} stored`)]);
    const fixed = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM kcnav_battles WHERE rank != 'X' AND outcome != '{}'").first<{ n: number }>();
    expect(fixed!.n).toBe(page74P.result.battles.length);
    expect(t.calls).toHaveLength(1);
  });

  test("an empty window stores nothing; the kind filter skips other jobs", async () => {
    const t = setup();
    t.respond(page25O);
    await t.env.DB.prepare(`INSERT INTO kcnav_queue (kind, path, map_id, node_letter, priority, created_at, updated_at) VALUES
      ('enemycomps', '/api/routing/maps/2-5/nodes/O/enemycomps?start=2026-01-01', 25, 'O', 1, 0, 0),
      ('battles', '/api/routing/maps/2-5/edges/15,19,20/battles?start=2026-09-23&page=0&perPage=50', 25, 'O', 300, 0, 0)`).run();
    expect(await tick(t.env, t.at(1_000_000), { skip: ["enemycomps"] })).toMatchObject({ jobStatus: "done", summary: expect.stringContaining("0 stored") });
    expect(t.calls[0]).toContain("/battles?");
    expect(await tick(t.env, t.at(1_000_000 + MIN), { only: ["battles"] })).toEqual({ action: "idle", waitMs: null });
  });

  test("a body over the cache limit fails the job without retrying", async () => {
    const t = setup();
    t.respond({ result: { battles: [], pad: "x".repeat(1_900_000) } });
    await t.env.DB.prepare("INSERT INTO kcnav_queue (kind, path, map_id, node_letter, created_at, updated_at) VALUES ('battles', '/x?page=0', 74, 'P', 0, 0)").run();
    expect(await tick(t.env, t.at(1_000_000))).toMatchObject({ jobStatus: "failed", summary: expect.stringContaining("body too large") });
  });
});
