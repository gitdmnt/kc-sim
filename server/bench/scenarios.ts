// Records one invocation of every worker path (bench/run.ts). GETs and KCNav / routing run on a copy of the local
// wrangler D1 (real master data, KCNav comps, routing); uploads, aggregation and the estimator on a synthetic
// database seeded like test/estimator.test.ts. Recording mutates the databases in order (uploads, then the jobs
// that consume them), so the list is one consistent story.
import { readFileSync } from "node:fs";
import { createApp } from "../src/app";
import { clearFitBonusCache } from "../src/estimator/job";
import { runScheduled } from "../src/jobs";
import { seedEdges15, seedMaster, seedSynthetic, T0, testGrid } from "../test/helpers";
import type { Recording } from "./d1";
import { ENEMIES, FRIEND, simulate, uploadItem } from "./fixtures";
import { RecordingD1 } from "./record";
import { benchEnv, MISS_CACHE } from "./replay";

const HOUR = 3_600_000;

interface Request { method: string; path: string; body?: string; headers?: Record<string, string> }

class Recorder {
  clock = T0;
  readonly out: Recording[] = [];
  private readonly app = createApp({ gridFn: testGrid, now: () => this.clock, cache: MISS_CACHE });

  constructor(readonly filter: RegExp) {}

  /** Calls the app without recording (seeding). */
  async call(d1: RecordingD1, r: Request) {
    const res = await this.app.request(`http://localhost${r.path}`, { method: r.method, body: r.body, headers: { "CF-Connecting-IP": "203.0.113.7", ...r.headers } },
      benchEnv(d1 as unknown as D1Database));
    return { status: res.status, text: await res.text() };
  }

  async http(name: string, d1: RecordingD1, r: Request, fetches?: Recording["fetches"]) {
    if (!this.filter.test(name)) return null;
    const headers = { "CF-Connecting-IP": "203.0.113.7", ...(r.body ? { "Content-Type": "application/json" } : {}), ...r.headers };
    const realFetch = globalThis.fetch;
    const queue = [...(fetches ?? [])];
    if (fetches) globalThis.fetch = (async () => new Response(queue.shift()!.body)) as unknown as typeof fetch;
    d1.recording = [];
    clearFitBonusCache(); // each recorded invocation starts like a fresh isolate
    try {
      const res = await this.app.request(`http://localhost${r.path}`, { method: r.method, body: r.body, headers }, benchEnv(d1 as unknown as D1Database));
      const text = await res.text();
      this.out.push({ name, kind: "http", method: r.method, path: r.path, headers, body: r.body, fetches, clock: this.clock, log: d1.recording, note: `${res.status} ${text.slice(0, 600)}` });
      return text;
    } finally {
      d1.recording = null;
      globalThis.fetch = realFetch;
    }
  }

  async scheduled(name: string, d1: RecordingD1) {
    if (!this.filter.test(name)) return null;
    d1.recording = [];
    clearFitBonusCache();
    try {
      const r = await runScheduled(benchEnv(d1 as unknown as D1Database), { gridFn: testGrid, now: () => this.clock });
      const note = JSON.stringify(r);
      this.out.push({ name, kind: "scheduled", clock: this.clock, log: d1.recording, note });
      return r;
    } finally {
      d1.recording = null;
    }
  }
}

/** Synthetic posteriors for `ships` enemy ships (3 stats, 101-point densities), as the estimator stores them. */
function seedPosteriors(d1: RecordingD1, ships: number[]) {
  const density = JSON.stringify({ min: 0, step: 2, posterior: Array.from({ length: 101 }, (_, i) => Math.round(Math.exp(-((i - 40) ** 2) / 50) * 1e6) / 1e6), prior: Array.from({ length: 101 }, () => 0.009901) });
  const ins = d1.sqlite.query(`INSERT OR REPLACE INTO estimator_posteriors (ship_id, stat, mean, sd, ci_lo, ci_hi, n, prior, density, updated_at)
    VALUES (?1, ?2, 41.23, 6.5, 30, 52, 412, '{"source":"flat","confidence":"none","value":null,"sd":58.3}', ?3, '2026-10-20T00:00:00.000Z')`);
  for (const s of ships) for (const stat of ["ev", "acc", "luck"]) ins.run(s, stat, density);
}

export async function recordScenarios(opts: { localDb: string; filter?: RegExp }): Promise<Recording[]> {
  const rec = new Recorder(opts.filter ?? /./);
  testGrid();

  // ---- real data: GETs, KCNav, routing ----
  const real = RecordingD1.open(opts.localDb);
  const abyssal = real.sqlite.query<{ id: number }, []>("SELECT id FROM ships WHERE is_abyssal = 1 ORDER BY id LIMIT 600").all().map((r) => r.id);
  seedPosteriors(real, abyssal);
  const heavyMap = real.sqlite.query<{ id: number }, []>(
    `SELECT m.id FROM maps m ORDER BY (SELECT COUNT(*) FROM enemy_comp_sets s WHERE s.map_id = m.id) * 20 + (SELECT COUNT(*) FROM edges e WHERE e.map_id = m.id)
       + (SELECT COUNT(*) FROM routing_rules r WHERE r.map_id = m.id) DESC LIMIT 1`).get()!.id;
  const heavyNode = real.sqlite.query<{ map_id: number; node_letter: string }, []>(
    `SELECT s.map_id, s.node_letter FROM enemy_comp_sets s JOIN enemy_comps c ON c.set_id = s.id GROUP BY s.map_id, s.node_letter ORDER BY COUNT(*) DESC LIMIT 1`).get()!;
  const key = (id: number) => `${Math.floor(id / 10)}-${id % 10}`;
  const gets: [string, string][] = [
    ["GET /health", "/api/v1/health"],
    ["GET /sources", "/api/v1/sources"],
    ["GET /maps", "/api/v1/maps"],
    [`GET /maps/${key(heavyMap)} (heaviest detail)`, `/api/v1/maps/${key(heavyMap)}`],
    ["GET /maps/7-4/routing", "/api/v1/maps/7-4/routing"],
    [`GET enemy-comps ${key(heavyNode.map_id)} ${heavyNode.node_letter}`, `/api/v1/maps/${key(heavyNode.map_id)}/nodes/${heavyNode.node_letter}/enemy-comps`],
    ["GET /ships (all)", "/api/v1/ships"],
    ["GET /ships?abyssal=1", "/api/v1/ships?abyssal=1"],
    ["GET /ships/1501", "/api/v1/ships/1501"],
    ["GET /equipments (all)", "/api/v1/equipments"],
    ["GET /fit-bonuses", "/api/v1/fit-bonuses"],
    ["GET /estimates (600 ships)", "/api/v1/estimates"],
    ["GET /estimates?shipId=50 ids (densities)", `/api/v1/estimates?shipId=${abyssal.slice(0, 50).join(",")}&density=1`],
    ["GET /estimates?shipId=200 ids", `/api/v1/estimates?shipId=${abyssal.slice(0, 200).join(",")}`],
    ["GET /estimates?shipId=1 id (plugin)", `/api/v1/estimates?shipId=${abyssal[0]}&stat=ev&density=1`],
  ];
  for (const [name, path] of gets) await rec.http(name, real, { method: "GET", path });

  const routing = readFileSync(new URL("../seed/routing/7-4.json", import.meta.url), "utf8");
  await rec.http("PUT /admin/routing/7-4", real, { method: "PUT", path: "/admin/routing/7-4", body: routing });

  // the largest cached KCNav response of each kind, replayed as a fresh fetch
  for (const kind of ["enemycomps", "map"]) {
    const job = real.sqlite.query<{ id: number; body: string }, [string]>(
      `SELECT q.id, c.body FROM kcnav_queue q JOIN kcnav_cache c ON c.id = q.cache_id WHERE q.kind = ?1 ORDER BY length(c.body) DESC LIMIT 1`).get(kind);
    if (!job) continue;
    real.sqlite.run("UPDATE kcnav_queue SET status = 'done' WHERE status = 'pending'");
    real.sqlite.run("UPDATE kcnav_queue SET status = 'pending', next_run_at = 0 WHERE id = ?1", [job.id]);
    real.sqlite.run("UPDATE kv_state SET value = '0' WHERE key = 'kcnav_next_allowed_at'");
    await rec.http(`POST /admin/kcnav/tick (${kind}, ${Math.round(job.body.length / 1024)} KB)`, real, { method: "POST", path: "/admin/kcnav/tick" },
      [{ url: "", status: 200, body: job.body }]);
  }

  // ---- synthetic: uploads, aggregation, estimator ----
  const syn = RecordingD1.open();
  const db = syn as unknown as D1Database;
  await seedSynthetic(db, FRIEND, ENEMIES);
  await seedMaster(db, { maps: [{ id: 15 }] });
  await seedEdges15(db);
  const reg = await rec.call(syn, { method: "POST", path: "/api/v1/clients" });
  const { token } = JSON.parse(reg.text) as { token: string };
  await rec.http("POST /clients", syn, { method: "POST", path: "/api/v1/clients" });
  const records = simulate(240, 1, T0 - 48 * HOUR);
  let next = 0;
  const upload = async (n: number, name?: string) => {
    rec.clock += 61_000;
    const body = JSON.stringify({ observations: records.slice(next, next + n).map(uploadItem) });
    next += n;
    const r = { method: "POST", path: "/api/v1/observations", body, headers: { Authorization: `Bearer ${token}` } };
    if (name) return rec.http(`${name} (${n} obs, ${Math.round(body.length / 1024)} KB)`, syn, r);
    return rec.call(syn, r);
  };
  // 60 battles ≈ 240 KB: the largest upload under the 256 KiB cap
  for (const n of [1, 10, 50, 60]) await upload(n, "POST /observations");
  while (next < records.length) await upload(Math.min(60, records.length - next));
  // what the deferred stages still have to do (all of it in the old synchronous design)
  for (let i = 0; i < 3; i++) {
    rec.clock += 60_000;
    if (!(await rec.scheduled(`cron #${i + 1}`, syn))) break;
  }
  syn.sqlite.run("UPDATE observations SET aggregated_at = NULL WHERE id IN (SELECT id FROM observations ORDER BY id LIMIT 100)");
  await rec.http("POST /admin/aggregate/run (100 obs pending)", syn, { method: "POST", path: "/admin/aggregate/run?limit=100" });
  await rec.http("POST /admin/estimate/run", syn, { method: "POST", path: "/admin/estimate/run", body: "{}" });
  // everything staged stored and every observation counted: what is left is folding signatures
  const drain = async (path: string, body?: string, done = (j: Record<string, unknown>) => !Object.values(j.remaining ?? {}).some((v) => v)) => {
    for (let i = 0; i < 5000; i++) {
      const j = JSON.parse((await rec.call(syn, { method: "POST", path, body })).text) as Record<string, unknown>;
      if (done(j)) return;
    }
  };
  await drain("/admin/ingest/run?budgetMs=10000", undefined, (j) => !(j.ingest as { remaining: number }).remaining);
  // a dirty map with nothing pending: re-materialised in one step
  const compRows = syn.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM poi_comp_counts WHERE map_id = 15").get()!.n;
  syn.sqlite.run("INSERT INTO poi_dirty_maps (map_id, since) VALUES (15, '2000-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING");
  await rec.http(`POST /admin/aggregate/run (re-materialise 1-5, ${compRows} comp rows)`, syn, { method: "POST", path: "/admin/aggregate/run" });
  await drain("/admin/estimate/run", JSON.stringify({ budgetMs: 5 }), (j) => !(j.remaining as { observations: number }).observations);
  rec.clock += 60_000;
  await rec.scheduled("cron (fold backlog)", syn);
  await drain("/admin/jobs/run?budgetMs=10000", undefined, () => true);
  await drain("/admin/estimate/run", JSON.stringify({ budgetMs: 10_000 }));
  rec.clock += 60_000;
  await rec.scheduled("cron (idle)", syn);
  return rec.out;
}
