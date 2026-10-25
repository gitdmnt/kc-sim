// GET cache versioning (src/cache.ts): entries are keyed by URL + data_version, so a bump makes every older
// entry unreachable; clients get max-age=300 and the ETag "dv<data_version>".
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cacheKey, dataVersion } from "../src/cache";
import { battleResponse, drainJobs, fleet, harness, LAYOUT_15, seedBasic, sortieOf, type Harness } from "./helpers";

/** Cache API double (caches.default): stores responses by URL. */
class FakeCache implements Cache {
  entries = new Map<string, { body: ArrayBuffer; status: number; headers: [string, string][] }>();
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const e = this.entries.get(typeof req === "string" ? req : req instanceof URL ? req.href : req.url);
    return e && new Response(e.body.slice(0), { status: e.status, headers: e.headers });
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const url = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
    this.entries.set(url, { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] });
  }
  async delete(): Promise<boolean> {
    return false;
  }
}

let h: Harness;
let cache: FakeCache;
beforeEach(async () => {
  cache = new FakeCache();
  h = harness({ cache });
  await seedBasic(h.db);
});

const get = (path: string, headers: Record<string, string> = {}) => h.call<{ maps: { id: number }[] }>("GET", path, { headers });

describe("versioned GET cache", () => {
  test("miss → hit (same ETag) → 304 on If-None-Match; Cache-Control max-age=300", async () => {
    const a = await get("/api/v1/maps");
    expect(a.headers.get("X-Cache")).toBe("MISS");
    expect(a.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(a.headers.get("ETag")).toBe(`"dv${await dataVersion(h.db)}"`);
    const b = await get("/api/v1/maps");
    expect(b.headers.get("X-Cache")).toBe("HIT");
    expect(b.headers.get("ETag")).toBe(a.headers.get("ETag"));
    expect(b.json).toEqual(a.json);
    expect(b.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const c = await get("/api/v1/maps", { "If-None-Match": a.headers.get("ETag")! });
    expect(c.status).toBe(304);
    expect(c.headers.get("ETag")).toBe(a.headers.get("ETag"));
    expect((await get("/api/v1/maps", { "If-None-Match": '"dv999", *' })).status).toBe(304);
    expect((await get("/api/v1/maps", { "If-None-Match": '"dv999"' })).status).toBe(200);
    // the edge copy is kept longer than the client copy: versioning, not expiry, keeps it fresh
    const stored = [...cache.entries.values()][0]!;
    expect(stored.headers.find(([k]) => k === "cache-control")?.[1]).toBe("public, max-age=86400");
  });

  test("a data_version bump makes stale entries unreachable", async () => {
    const v0 = await dataVersion(h.db);
    const before = await get("/api/v1/maps");
    // a write that does not bump would be hidden by the cache …
    await h.db.prepare("INSERT INTO maps (id, world, no, name, is_event, updated_at) VALUES (16, 1, 6, 'x', 0, 'now')").run();
    expect((await get("/api/v1/maps")).json).toEqual(before.json);
    // … so every writer bumps: the next GET uses a new key and sees the row
    await h.db.prepare("UPDATE kv_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'").run();
    const after = await get("/api/v1/maps");
    expect(after.headers.get("X-Cache")).toBe("MISS");
    expect(after.headers.get("ETag")).toBe(`"dv${v0 + 1}"`);
    expect(after.json.maps.map((m) => m.id)).toContain(16);
    // an ETag from before the bump no longer matches
    expect((await get("/api/v1/maps", { "If-None-Match": before.headers.get("ETag")! })).status).toBe(200);
    expect([...cache.entries.keys()]).toEqual([cacheKey("http://localhost/api/v1/maps", v0).url, cacheKey("http://localhost/api/v1/maps", v0 + 1).url]);
  });

  test("ingest, aggregation, routing and estimation bump the version", async () => {
    const v = async () => dataVersion(h.db);
    const v0 = await v();
    const { token } = await h.register();
    h.clock.t += 61_000;
    const ob = {
      clientObsId: "x1", observedAt: new Date(h.clock.t - 60_000).toISOString(), map: "1-5", cell: 1, layout: LAYOUT_15, difficulty: 0,
      kind: "battle", fleet: fleet(), raw: { path: "api_req_sortie/battle", visitId: "v", sortieId: null as string | null, raw: battleResponse([1501], 1, {
        // one shelling hit: an evasion roll for 1501, so the estimator has something to fold
        api_hougeki1: { api_at_eflag: [0], api_at_list: [0], api_at_type: [0], api_df_list: [[0]], api_si_list: [[-1]], api_cl_list: [[1]], api_damage: [[3]] },
      }), result: null },
    };
    expect((await h.call("POST", "/api/v1/observations", { token, body: { observations: [ob, sortieOf([ob])] } })).status).toBe(202);
    await drainJobs(h);
    const v1 = await v();
    expect(v1).toBeGreaterThan(v0); // the jobs ingested it and aggregation materialised map 1-5
    await h.call("POST", "/admin/estimate/run", { body: { budgetMs: 100 } });
    const v2 = await v();
    expect(v2).toBeGreaterThan(v1); // posteriors written
    const doc = JSON.parse(readFileSync(new URL("../seed/routing/1-5.json", import.meta.url), "utf8"));
    expect((await h.call("PUT", "/admin/routing/1-5", { body: doc })).status).toBe(200);
    expect(await v()).toBeGreaterThan(v2);
    // and a cached response from before is not served afterwards
    const r1 = await get("/api/v1/maps/1-5/routing");
    await h.call("PUT", "/admin/routing/1-5", { body: { ...doc, sources: [...doc.sources, { id: "test", note: "changed" }] } });
    const r2 = await get("/api/v1/maps/1-5/routing");
    expect(r2.headers.get("X-Cache")).toBe("MISS");
    expect(r2.json).not.toEqual(r1.json);
  });

  test("SQL-built text bodies are stored and replayed verbatim", async () => {
    const ships = () => h.call<{ ships: unknown[] }>("GET", "/api/v1/ships?abyssal=1");
    const a = await ships();
    const b = await ships();
    expect([a.headers.get("X-Cache"), b.headers.get("X-Cache")]).toEqual(["MISS", "HIT"]);
    expect(b.headers.get("Content-Type")).toStartWith("application/json");
    expect(b.json).toEqual(a.json);
    expect(a.json.ships.length).toBeGreaterThan(0);
  });

  test("errors and non-GET requests are not cached", async () => {
    expect((await get("/api/v1/maps/99-9")).status).toBe(404);
    expect((await get("/api/v1/maps/99-9")).headers.get("X-Cache")).toBeNull();
    await h.call("POST", "/api/v1/clients");
    expect(cache.entries.size).toBe(0);
  });
});
