// Admin API (private notes API §4): KCNav queue control, routing uploads, poi-observed aggregation, the server
// estimator, the background jobs, clients and validation records. Behind Cloudflare Access (auth/access.ts).
// The jobs run in GitHub Actions (scripts/run-jobs.ts); the job endpoints here run the same code in the worker on
// demand, budgeted (src/budget.ts): /jobs/run, /ingest/run and /estimate/run until their queues are empty or the
// budget is spent; /aggregate/run and /kcnav/reparse one step (repeat until the response reports nothing
// remaining). Rebuilds and deletions only reset and leave the work to the next jobs run.
import { Hono } from "hono";
import { requireAccess, type VerifyDeps } from "../auth/access";
import { banClient } from "../auth/clients";
import { Budget, PASS_MS, RUN_MS } from "../budget";
import { bumpDataVersion } from "../cache";
import type { Env } from "../env";
import { estimatorBacklog, forgetClientObservations, resetShipsStatements, runEstimator } from "../estimator/job";
import { runJobs, withJobsLease, type JobDeps } from "../jobs";
import { mapName, parseMapKey } from "../maps";
import { enqueue } from "../kcnav/enqueue";
import { reparseCached, tick } from "../kcnav/tick";
import { aggregatePending, deleteClientObservations, resetStatements } from "../observed/aggregate";
import { countRules, validateRoutingDoc } from "../routing/validate";
import { banRequest, enqueueRequest, estimateRunRequest } from "../schemas";
import { flagOn } from "./write";

export interface AdminDeps extends JobDeps {
  /** Access JWKS fetch and clock (tests inject them) */
  access?: VerifyDeps;
}

/** `?budgetMs=` (cost-model CPU; `fallback` when absent), or null when malformed. */
const budgetParam = (v: string | undefined, fallback: number): number | null => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 60_000 ? n : null;
};

export function adminRoutes(deps: AdminDeps) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requireAccess(deps.access));

  // One jobs run on demand (src/jobs.ts): ingest, aggregation and the estimator in passes until the queues are
  // empty or the run's budget (default RUN_MS) is spent.
  app.post("/jobs/run", async (c) => {
    const budgetMs = budgetParam(c.req.query("budgetMs"), RUN_MS);
    if (budgetMs === null) return c.json({ error: "budgetMs must be a number in (0, 60000]" }, 400);
    return c.json(await runJobs(c.env.DB, deps, { budgetMs, ingest: !flagOn(c.env.INGEST_PAUSED) }));
  });

  // The same run without the estimator: staged uploads and aggregation only.
  app.post("/ingest/run", async (c) => {
    const budgetMs = budgetParam(c.req.query("budgetMs"), RUN_MS);
    if (budgetMs === null) return c.json({ error: "budgetMs must be a number in (0, 60000]" }, 400);
    return c.json(await runJobs(c.env.DB, deps, { budgetMs, estimator: false, ingest: !flagOn(c.env.INGEST_PAUSED) }));
  });

  // Server estimator (private notes ESTIMATOR "Server job"). Body (all optional): {rebuild, shipIds, budgetMs}.
  app.post("/estimate/run", async (c) => {
    const parsed = estimateRunRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
    const { rebuild, shipIds, budgetMs } = parsed.data;
    const db = c.env.DB;
    if (rebuild) await db.batch(resetShipsStatements(db, shipIds ?? null));
    const budget = new Budget(budgetMs ?? RUN_MS);
    const now = deps.now();
    const r = await withJobsLease(db, now, budget, () => runEstimator(db, { gridFn: deps.gridFn, budget, now }));
    return c.json({ busy: r === null, ...r, remaining: await estimatorBacklog(db), spentMs: Number(budget.spent.toFixed(2)) });
  });

  app.get("/estimate/status", async (c) => {
    const db = c.env.DB;
    const [queue, ships, lock] = await Promise.all([
      db.prepare(`SELECT COUNT(DISTINCT observation_id) AS pending, COUNT(*) AS pairs, SUM(est_at IS NULL) AS pendingPairs,
        (SELECT COUNT(*) FROM estimator_rolls) AS signatures FROM observation_ships`).first(),
      db.prepare("SELECT COUNT(*) AS ships, SUM(dirty_since IS NOT NULL) AS dirty, SUM(n_ev) AS evasionRolls, SUM(n_acc) AS accuracyRolls, MAX(updated_at) AS updatedAt FROM estimator_accum").first(),
      db.prepare("SELECT value FROM kv_state WHERE key = 'jobs_lock_until'").first<{ value: string }>(),
    ]);
    return c.json({ queue, ships, lockedUntil: Number(lock?.value ?? 0) });
  });

  app.post("/clients/:id/ban", async (c) => {
    const parsed = banRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
    const ok = await banClient(c.env.DB, c.req.param("id"), parsed.data.reason ?? null, new Date(deps.now()).toISOString());
    return ok ? c.json({ clientId: c.req.param("id"), banned: true }) : c.json({ error: "client not found" }, 404);
  });

  // Deletes a client entirely: staged items, observations (resetting the aggregates of their maps and the ships
  // they fed; the next jobs run refolds what remains), validation records and the client row (its token stops working).
  app.delete("/clients/:id", async (c) => {
    const db = c.env.DB;
    const clientId = c.req.param("id");
    const ships = await forgetClientObservations(db, clientId);
    const r = await deleteClientObservations(db, clientId);
    const res = await db.batch([
      db.prepare("DELETE FROM observation_rejections WHERE client_id = ?1").bind(clientId),
      db.prepare("DELETE FROM clients WHERE id = ?1").bind(clientId),
    ]);
    return c.json({ clientId, deleted: r.deleted, rejections: res[0]?.meta.changes ?? 0, client: (res[1]?.meta.changes ?? 0) > 0, maps: r.maps.map(mapName), estimatorReset: ships });
  });

  // poi-observed aggregation (private notes API §4): one budgeted step.
  app.post("/aggregate/run", async (c) => {
    const budgetMs = budgetParam(c.req.query("budgetMs"), PASS_MS);
    if (budgetMs === null) return c.json({ error: "budgetMs must be a number in (0, 60000]" }, 400);
    const now = deps.now();
    return c.json(await aggregatePending(c.env.DB, new Budget(budgetMs), () => new Date(now).toISOString()));
  });

  app.get("/rejections", async (c) => {
    const clientId = c.req.query("clientId") ?? null;
    const action = c.req.query("action") ?? null;
    const db = c.env.DB;
    const [byRule, recent] = await Promise.all([
      db.prepare(`SELECT action, rule, COUNT(*) AS n FROM observation_rejections WHERE (?1 IS NULL OR client_id = ?1) GROUP BY action, rule ORDER BY action, n DESC`)
        .bind(clientId).all(),
      db.prepare(`SELECT id, client_id, client_obs_id, kind, map_id, rule, action, detail, observation_id, created_at FROM observation_rejections
        WHERE (?1 IS NULL OR client_id = ?1) AND (?2 IS NULL OR action = ?2) ORDER BY id DESC LIMIT 100`).bind(clientId, action).all(),
    ]);
    return c.json({ byRule: byRule.results, recent: recent.results });
  });

  app.route("/", admin);
  return app;
}

const admin = new Hono<{ Bindings: Env }>();

admin.post("/kcnav/enqueue", async (c) => {
  const parsed = enqueueRequest.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
  return c.json(await enqueue(c.env, parsed.data));
});

// One budgeted step; repeat with ?after=<next> until next is null.
admin.post("/kcnav/reparse", async (c) => {
  const budgetMs = budgetParam(c.req.query("budgetMs"), PASS_MS);
  const after = Number(c.req.query("after") ?? 0);
  if (budgetMs === null || !Number.isInteger(after) || after < 0) return c.json({ error: "after must be a job id, budgetMs a number in (0, 60000]" }, 400);
  return c.json(await reparseCached(c.env, new Budget(budgetMs), after));
});
admin.post("/kcnav/tick", async (c) => c.json(await tick(c.env)));

admin.get("/kcnav/status", async (c) => {
  const db = c.env.DB;
  const [byStatus, gate, failed, coverage, last] = await Promise.all([
    db.prepare("SELECT kind, status, COUNT(*) AS n FROM kcnav_queue GROUP BY kind, status ORDER BY kind, status").all(),
    db.prepare("SELECT value FROM kv_state WHERE key = 'kcnav_next_allowed_at'").first<{ value: string }>(),
    db.prepare("SELECT id, path, attempts, last_error FROM kcnav_queue WHERE status = 'failed' ORDER BY id").all(),
    db.prepare(
      `SELECT m.id AS map_id,
         (SELECT COUNT(DISTINCT s.node_letter) FROM enemy_comp_sets s WHERE s.map_id = m.id) AS comp_nodes,
         (SELECT COUNT(*) FROM nodes n WHERE n.map_id = m.id AND n.node_type IN ('battle','boss','night_battle','air_battle','air_raid','night_to_day')) AS combat_nodes,
         (SELECT COUNT(*) FROM routing_maps r WHERE r.map_id = m.id) AS has_routing
       FROM maps m WHERE m.world BETWEEN 1 AND 7 ORDER BY m.id`,
    ).all<{ map_id: number; comp_nodes: number; combat_nodes: number; has_routing: number }>(),
    db.prepare("SELECT id, path, status, updated_at FROM kcnav_queue WHERE status IN ('done','failed') ORDER BY updated_at DESC LIMIT 1").first(),
  ]);
  const now = Date.now();
  const pending = (byStatus.results as { status: string; n: number }[]).filter((r) => r.status === "pending").reduce((s, r) => s + r.n, 0);
  return c.json({
    now, nextAllowedAt: Number(gate?.value ?? 0), pending,
    etaMinutes: Math.ceil((pending * Number(c.env.KCNAV_MIN_INTERVAL_MS)) / 60_000),
    queue: byStatus.results, lastFinished: last, failed: failed.results,
    normalMaps: coverage.results.map((r) => ({ map: mapName(r.map_id), compNodes: r.comp_nodes, combatNodes: r.combat_nodes, routing: !!r.has_routing })),
  });
});

admin.get("/kcnav/queue", async (c) => {
  const status = c.req.query("status");
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, path, map_id, node_letter, difficulty, priority, status, attempts, next_run_at, last_error, cache_id, updated_at
     FROM kcnav_queue WHERE (?1 IS NULL OR status = ?1) ORDER BY id`,
  ).bind(status ?? null).all();
  const gate = await c.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'kcnav_next_allowed_at'").first<{ value: string }>();
  return c.json({ nextAllowedAt: Number(gate?.value ?? 0), now: Date.now(), jobs: results });
});

// Clears the aggregates (all maps or `maps`) and marks their observations pending; the next jobs run refolds them.
admin.post("/aggregate/rebuild", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { maps?: unknown };
  let mapIds: number[] | undefined;
  if (body.maps !== undefined) {
    const keys = Array.isArray(body.maps) ? body.maps.map((m) => parseMapKey(String(m))) : [null];
    if (keys.some((k) => !k)) return c.json({ error: "maps must be a list of map keys (\"1-5\" or 15)" }, 400);
    mapIds = keys.map((k) => k!.id);
  }
  const db = c.env.DB;
  await db.batch(resetStatements(db, mapIds));
  const left = await db.prepare("SELECT COUNT(*) AS n FROM observations WHERE aggregated_at IS NULL AND quarantine IS NULL").first<{ n: number }>();
  return c.json({ maps: mapIds ?? null, pending: left?.n ?? 0 });
});

admin.get("/aggregate/status", async (c) => {
  const db = c.env.DB;
  const [obs, errors, layouts, mismatches] = await Promise.all([
    db.prepare(`SELECT kind, COUNT(*) AS n, SUM(aggregated_at IS NULL) AS pending, SUM(agg_error IS NOT NULL) AS failed
      FROM observations GROUP BY kind ORDER BY kind`).all(),
    db.prepare("SELECT id, client_id, client_obs_id, kind, agg_error FROM observations WHERE agg_error IS NOT NULL ORDER BY id LIMIT 50").all(),
    db.prepare("SELECT map_id, layout, version, sorties, encounters, first_seen, last_seen FROM poi_layouts ORDER BY map_id, version").all<{ map_id: number }>(),
    db.prepare("SELECT map_id, kind, COUNT(*) AS n FROM poi_graph_mismatches GROUP BY map_id, kind ORDER BY map_id, kind").all<{ map_id: number }>(),
  ]);
  return c.json({
    observations: obs.results, errors: errors.results,
    layouts: layouts.results.map((l) => ({ ...l, map: mapName(l.map_id) })),
    mismatches: mismatches.results.map((m) => ({ ...m, map: mapName(m.map_id) })),
  });
});

admin.delete("/observations", async (c) => {
  const clientId = c.req.query("clientId");
  if (!clientId) return c.json({ error: "clientId query parameter is required" }, 400);
  const ships = await forgetClientObservations(c.env.DB, clientId);
  const r = await deleteClientObservations(c.env.DB, clientId);
  return c.json({ clientId, deleted: r.deleted, maps: r.maps.map(mapName), estimatorReset: ships });
});

admin.put("/routing/:map", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const db = c.env.DB;
  const { results } = await db.prepare("SELECT from_letter, to_letter FROM edges WHERE map_id = ?1").bind(key.id).all<{ from_letter: string; to_letter: string }>();
  if (!results.length) return c.json({ error: "map has no edges; ingest the map graph first" }, 409);
  const { doc, errors } = validateRoutingDoc(await c.req.json().catch(() => undefined), results.map((e) => ({ from: e.from_letter, to: e.to_letter })));
  if (!doc || errors.length) return c.json({ error: "validation failed", issues: errors }, 400);
  if (parseMapKey(doc.map)?.id !== key.id) return c.json({ error: "document map does not match URL" }, 400);
  const { total, uncertain } = countRules(doc);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO sources (key, name, url, licence, revision, fetched_at) VALUES ('admin-routing', 'routing uploaded via admin API', NULL, 'project', NULL, ?1)
      ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at`).bind(now),
    db.prepare("DELETE FROM routing_rules WHERE map_id = ?1").bind(key.id),
    db.prepare(`INSERT INTO routing_maps (map_id, layout, sources, defaults, start, rule_count, uncertain_count, source_id, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT id FROM sources WHERE key = 'admin-routing'), ?8)
      ON CONFLICT (map_id) DO UPDATE SET layout = excluded.layout, sources = excluded.sources, defaults = excluded.defaults, start = excluded.start,
        rule_count = excluded.rule_count, uncertain_count = excluded.uncertain_count, source_id = excluded.source_id, updated_at = excluded.updated_at`)
      .bind(key.id, doc.layout ?? null, JSON.stringify(doc.sources), doc.defaults ? JSON.stringify(doc.defaults) : null,
        doc.start ? JSON.stringify(doc.start) : null, total, uncertain, now),
    ...Object.entries(doc.nodes).map(([letter, node], ord) =>
      db.prepare("INSERT INTO routing_rules (map_id, from_letter, ord, node) VALUES (?1, ?2, ?3, ?4)").bind(key.id, letter, ord, JSON.stringify(node))),
    bumpDataVersion(db),
  ]);
  return c.json({ stored: doc.map, ruleCount: total, uncertainCount: uncertain });
});
