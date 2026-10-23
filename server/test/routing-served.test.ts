// Inferred routing in the read API (hand-authored rules win), the hand-rule check, and the D1 HTTP adapter the
// GitHub Actions jobs use.
import { describe, expect, test } from "bun:test";
import { httpD1 } from "../scripts/lib/d1-database";
import { checkHandRules, type RouteShip, type SortieSample } from "../scripts/lib/routing-infer";
import type { RoutingDoc } from "../src/routing/schema";
import { harness, seedMaster } from "./helpers";

const INFERRED: RoutingDoc = {
  map: "62-1", sources: [{ id: "inferred", note: "test" }],
  nodes: { Start: { rules: [{ to: "A" }] }, A: { rules: [{ random: [{ to: "B", p: 0.5 }, { to: "C", p: 0.5 }], uncertain: true }] }, B: { end: true }, C: { end: true } },
};

async function setup() {
  const h = harness();
  await seedMaster(h.db, { maps: [{ id: 15 }, { id: 621, event: true }] });
  await h.db.prepare(`INSERT INTO routing_inferred (map_id, layout, sorties, rule_count, uncertain_count, doc, report, generated_at)
    VALUES (621, '0,1,2,3', 250, 3, 1, ?1, '[]', '2026-10-24T03:40:00.000Z')`).bind(JSON.stringify(INFERRED)).run();
  return h;
}

describe("read API serves inferred routing for maps without hand-authored rules", () => {
  test("map detail, routing endpoint (bare document + provenance headers) and map list", async () => {
    const h = await setup();
    const detail = await h.call<{ routing: RoutingDoc; routingMeta: unknown }>("GET", "/api/v1/maps/62-1");
    expect(detail.json.routing).toEqual(INFERRED);
    expect(detail.json.routingMeta).toEqual({ provenance: "inferred", generatedAt: "2026-10-24T03:40:00.000Z", sortieCount: 250 });
    const r = await h.call<RoutingDoc>("GET", "/api/v1/maps/62-1/routing");
    expect(r.json).toEqual(INFERRED);
    expect(r.headers.get("X-Routing-Provenance")).toBe("inferred");
    expect(r.headers.get("X-Routing-Sortie-Count")).toBe("250");
    expect(r.headers.get("X-Routing-Generated-At")).toBe("2026-10-24T03:40:00.000Z");
    const list = await h.call<{ maps: { key: string; routing: unknown }[] }>("GET", "/api/v1/maps");
    expect(list.json.maps.find((m) => m.key === "62-1")?.routing).toEqual({ ruleCount: 3, uncertainCount: 1, provenance: "inferred" });
    expect(list.json.maps.find((m) => m.key === "1-5")?.routing).toBeNull();
    expect((await h.call("GET", "/api/v1/maps/1-5")).json.routingMeta).toBeNull();
    expect((await h.call("GET", "/api/v1/maps/1-5/routing")).status).toBe(404);
  });

  test("hand-authored rules win over an inferred document", async () => {
    const h = await setup();
    await h.db.batch([
      h.db.prepare(`INSERT INTO routing_maps (map_id, sources, rule_count, uncertain_count, updated_at) VALUES (621, '[{"id":"hand","note":"t"}]', 2, 0, 'x')`),
      h.db.prepare(`INSERT INTO routing_rules (map_id, from_letter, ord, node) VALUES (621, 'Start', 0, '{"rules":[{"to":"A"}]}'), (621, 'A', 1, '{"rules":[{"to":"B"}]}')`),
    ]);
    const detail = await h.call<{ routing: RoutingDoc; routingMeta: unknown }>("GET", "/api/v1/maps/62-1");
    expect(detail.json.routing.sources).toEqual([{ id: "hand", note: "t" }]);
    expect(detail.json.routingMeta).toEqual({ provenance: "hand", generatedAt: null, sortieCount: null });
    expect((await h.call("GET", "/api/v1/maps/62-1/routing")).headers.get("X-Routing-Provenance")).toBe("hand");
    const list = await h.call<{ maps: { key: string; routing: unknown }[] }>("GET", "/api/v1/maps");
    expect(list.json.maps.find((m) => m.key === "62-1")?.routing).toEqual({ ruleCount: 2, uncertainCount: 0, provenance: "hand" });
  });
});

describe("checkHandRules", () => {
  const dd: RouteShip = { stype: 2, id: 1, speed: 10, nakedLos: 40, equips: [] };
  const cl: RouteShip = { stype: 3, id: 2, speed: 10, nakedLos: 40, equips: [] };
  const hand: RoutingDoc = {
    map: "1-1", sources: [{ id: "t", note: "t" }],
    nodes: {
      Start: { rules: [{ to: "A" }] },
      A: { rules: [{ when: { m: "count", types: ["CL"], gte: 1 }, to: "B" }, { random: [{ to: "B", p: 0.5 }, { to: "C", p: 0.5 }] }] },
      B: { end: true }, C: { end: true },
    },
  };
  const edges = [{ from: "Start", to: "A" }, { from: "A", to: "B" }, { from: "A", to: "C" }];
  const sortie = (main: RouteShip[], to: string): SortieSample => ({ main, hq: 120, path: ["Start", "A", to] });

  test("reports moves the rules cannot produce and shares that differ for fleets the rules treat alike", () => {
    const samples = [
      ...Array.from({ length: 5 }, () => sortie([cl, dd], "C")), // CL → always B by the rules
      ...Array.from({ length: 90 }, () => sortie([dd, dd], "C")), // 50/50 by the rules, all C observed
      ...Array.from({ length: 10 }, () => sortie([dd, dd], "B")),
    ];
    const r = checkHandRules(hand, edges, samples);
    expect(r.decisions).toBe(105);
    expect(r.impossible).toEqual([{ node: "A", to: "C", count: 5, example: "CL DD" }]);
    expect(r.divergent).toHaveLength(1);
    expect(r.divergent[0]).toMatchObject({ node: "A", expected: { B: 0.5, C: 0.5 }, observed: { B: 10, C: 90 }, n: 100, tv: 0.4 });
  });

  test("observations that match the rules are not flagged", () => {
    const samples = Array.from({ length: 100 }, (_, i) => sortie([dd, dd], i % 2 ? "B" : "C"));
    expect(checkHandRules(hand, edges, samples)).toMatchObject({ decisions: 100, impossible: [], divergent: [] });
  });
});

describe("httpD1", () => {
  const ok = (result: unknown[]) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });

  test("single statements and batches map onto the D1 HTTP API; booleans bind as 1 / 0", async () => {
    const bodies: unknown[] = [];
    const responses = [
      ok([{ results: [{ n: 3 }], success: true, meta: { changes: 0, last_row_id: 0 } }]),
      ok([{ results: [], success: true, meta: { changes: 1, last_row_id: 7 } }, { results: [{ x: 1 }], success: true, meta: {} }]),
    ];
    const db = httpD1({
      accountId: "acc", databaseId: "db1", token: "tok", minIntervalMs: 0, sleep: async () => {},
      fetch: async (url, init) => {
        expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db1/query");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
        bodies.push(JSON.parse(String(init.body)));
        return responses.shift()!;
      },
    });
    expect(await db.prepare("SELECT ?1 AS n").bind(true).first()).toEqual({ n: 3 });
    const [ins, sel] = await db.batch([db.prepare("INSERT INTO t VALUES (?1)").bind("a"), db.prepare("SELECT 1 AS x")]);
    expect(ins!.meta.changes).toBe(1);
    expect(sel!.results).toEqual([{ x: 1 }]);
    expect(bodies).toEqual([
      { sql: "SELECT ?1 AS n", params: [1] },
      { batch: [{ sql: "INSERT INTO t VALUES (?1)", params: ["a"] }, { sql: "SELECT 1 AS x", params: [] }] },
    ]);
  });

  test("retries rate limits and gateway errors, surfaces API errors", async () => {
    const statuses = [429, 503];
    let calls = 0;
    const db = httpD1({
      accountId: "a", databaseId: "d", token: "t", minIntervalMs: 0, sleep: async () => {},
      fetch: async () => {
        calls++;
        const s = statuses.shift();
        return s ? new Response("busy", { status: s }) : ok([{ results: [{ v: 1 }], success: true, meta: {} }]);
      },
    });
    expect(await db.prepare("SELECT 1 AS v").first()).toEqual({ v: 1 });
    expect(calls).toBe(3);
    const bad = httpD1({
      accountId: "a", databaseId: "d", token: "t", minIntervalMs: 0, sleep: async () => {},
      fetch: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: "no such table: nope" }], result: null }), { status: 400 }),
    });
    await expect(bad.prepare("SELECT * FROM nope").all()).rejects.toThrow("no such table: nope");
  });
});
