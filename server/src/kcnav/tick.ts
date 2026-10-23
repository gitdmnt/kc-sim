// One step of the single-fetcher KCNav loop (scripts/run-jobs.ts kcnav in GitHub Actions, POST /admin/kcnav/tick):
// at most one request per call, gated globally by kv_state.kcnav_next_allowed_at (persisted, so restarts and
// parallel callers respect the interval).
import { COST, type Budget } from "../budget";
import { bumpDataVersion } from "../cache";
import type { Env } from "../env";
import { COMBAT_NODE_TYPES, parseEnemyComps, parseMap, parseNodeSummary } from "./parse";
import { storeBattles } from "./battles";
import { decideTick, planAfterResponse, type TickDecision } from "./throttle";
import { OBSERVED_SOURCE, materializeMap } from "../observed/aggregate";

const GATE_KEY = "kcnav_next_allowed_at";
const STALE_RUNNING_MS = 10 * 60 * 1000;
export const KCNAV_USER_AGENT = "kc-sim-server (single worker, max 1 request per 65 s)";
/**
 * Largest response body kept in kcnav_cache (D1 caps a string or row at 2 000 000 bytes). A larger body fails
 * the job permanently (prefix cached for inspection): retrying would fetch the same answer again.
 */
export const MAX_CACHE_BODY_BYTES = 1_800_000;

export interface QueueRow {
  id: number; kind: string; path: string; map_id: number; node_letter: string | null; difficulty: number;
  attempts: number; next_run_at: number;
}

export type TickResult =
  | Exclude<TickDecision, { action: "request" }>
  | { action: "requested"; jobId: number; url: string; status: number; jobStatus: string; summary: string; waitMs: number };

export interface TickDeps { now: () => number; fetch: (url: string, init: RequestInit) => Promise<Response> }
/** What a tick needs from the environment (the worker's Env, or the jobs runner's). */
export type KcnavEnv = Pick<Env, "DB" | "KCNAV_BASE" | "KCNAV_MIN_INTERVAL_MS">;
/** Restricts which job kinds a tick may run (e.g. the daily jobs step leaves `battles` to the crawl workflow). */
export interface KindFilter { only?: string[]; skip?: string[] }

// Wrap the globals: workerd throws "Illegal invocation" when `fetch` is called as a method of `deps`.
const DEFAULT_DEPS: TickDeps = { now: () => Date.now(), fetch: (input, init) => fetch(input, init) };

export async function tick(env: KcnavEnv, deps: TickDeps = DEFAULT_DEPS, filter: KindFilter = {}): Promise<TickResult> {
  const db = env.DB;
  const minInterval = Number(env.KCNAV_MIN_INTERVAL_MS);
  const now = deps.now();
  const [, gateRow, jobRow] = await db.batch([
    db.prepare("UPDATE kcnav_queue SET status = 'pending', updated_at = ?1 WHERE status = 'running' AND updated_at < ?2")
      .bind(now, now - STALE_RUNNING_MS),
    db.prepare("SELECT value FROM kv_state WHERE key = ?1").bind(GATE_KEY),
    db.prepare(
      `SELECT id, kind, path, map_id, node_letter, difficulty, attempts, next_run_at FROM kcnav_queue
       WHERE status = 'pending'
         AND (?2 IS NULL OR kind IN (SELECT value FROM json_each(?2)))
         AND (?3 IS NULL OR kind NOT IN (SELECT value FROM json_each(?3)))
       ORDER BY CASE WHEN next_run_at <= ?1 THEN 0 ELSE 1 END, CASE WHEN next_run_at <= ?1 THEN priority ELSE next_run_at END, id
       LIMIT 1`,
    ).bind(now, filter.only?.length ? JSON.stringify(filter.only) : null, filter.skip?.length ? JSON.stringify(filter.skip) : null),
  ]);
  const gate = Number((gateRow!.results[0] as { value: string } | undefined)?.value ?? 0);
  const job = (jobRow!.results[0] as QueueRow | undefined) ?? null;
  const decision = decideTick({ now, nextAllowedAt: gate, nextJob: job ? { id: job.id, nextRunAt: job.next_run_at } : null });
  if (decision.action !== "request") return decision;
  if (!job) return { action: "idle", waitMs: null };

  // Claim the gate atomically before sending; a concurrent tick that lost the race waits.
  const claim = await db.prepare("UPDATE kv_state SET value = ?1 WHERE key = ?2 AND CAST(value AS INTEGER) <= ?3")
    .bind(String(now + minInterval), GATE_KEY, now).run();
  if (claim.meta.changes !== 1) return { action: "wait", waitMs: minInterval, reason: "gate" };
  await db.prepare("UPDATE kcnav_queue SET status = 'running', updated_at = ?1 WHERE id = ?2").bind(now, job.id).run();

  const url = `${env.KCNAV_BASE}${job.path}`;
  let status = 0;
  let body = "";
  try {
    const res = await deps.fetch(url, { headers: { "User-Agent": KCNAV_USER_AGENT, Accept: "application/json" } });
    status = res.status;
    body = await res.text();
  } catch (e) {
    body = String(e);
  }
  const fetchedAt = new Date(now).toISOString();
  const bytes = new TextEncoder().encode(body).length;
  const oversize = bytes > MAX_CACHE_BODY_BYTES;
  const cache = await db.prepare("INSERT INTO kcnav_cache (url, status, body, fetched_at) VALUES (?1, ?2, ?3, ?4) RETURNING id")
    .bind(url, status, oversize ? body.slice(0, 100_000) : body, fetchedAt).first<{ id: number }>();

  let plan = planAfterResponse({ status, attempts: job.attempts, requestedAt: now, minIntervalMs: minInterval });
  let summary = `HTTP ${status}`;
  let error: string | null = plan.jobStatus === "done" ? null : body.slice(0, 500);
  if (plan.jobStatus === "done" && oversize) {
    plan = { ...plan, jobStatus: "failed" };
    error = `body too large: ${bytes} bytes > ${MAX_CACHE_BODY_BYTES} (first 100 000 characters cached)`;
    summary = error;
  } else if (plan.jobStatus === "done") {
    try {
      summary = await store(db, job, JSON.parse(body), cache!.id, fetchedAt);
    } catch (e) {
      // Malformed payload: permanent failure (retrying would hit KCNav for the same answer).
      plan = { ...plan, jobStatus: "failed" };
      error = `parse/store: ${String(e)}`;
      summary = error;
    }
  }
  await db.batch([
    db.prepare("UPDATE kcnav_queue SET status = ?1, attempts = ?2, next_run_at = ?3, last_error = ?4, cache_id = ?5, updated_at = ?6 WHERE id = ?7")
      .bind(plan.jobStatus, plan.attempts, plan.nextRunAt, error, cache!.id, deps.now(), job.id),
    db.prepare("UPDATE kv_state SET value = ?1 WHERE key = ?2 AND CAST(value AS INTEGER) < ?1")
      .bind(String(plan.gateUntil), GATE_KEY),
  ]);
  return { action: "requested", jobId: job.id, url, status, jobStatus: plan.jobStatus, summary, waitMs: Math.max(0, plan.gateUntil - deps.now()) };
}

/**
 * Re-runs `store` for done jobs after `after` (job id) from their cached bodies (no KCNav request), while
 * `budget` lasts: per job COST.kcnavJob + COST.kcnavKb per KB of body, and its D1 calls. Use after a parser fix and
 * repeat with `next` until it is null; returns one summary line per job.
 */
export async function reparseCached(env: Env, budget: Budget, after = 0): Promise<{ reparsed: string[]; next: number | null }> {
  const db = env.DB;
  const { results: queue } = await db.prepare(
    `SELECT q.id, length(CAST(c.body AS BLOB)) AS bytes, q.kind FROM kcnav_queue q JOIN kcnav_cache c ON c.id = q.cache_id
     WHERE q.status = 'done' AND q.id > ?1 ORDER BY q.id LIMIT 200`,
  ).bind(after).all<{ id: number; bytes: number; kind: string }>();
  budget.charge(COST.d1Call, 1);
  const pick: number[] = [];
  let cost = COST.d1Call;
  let calls = 1;
  for (const j of queue) {
    const c = COST.kcnavJob + (COST.kcnavKb + 2 * COST.d1Kb) * j.bytes / 1024;
    const n = j.kind === "map" ? 9 : 3; // store's D1 calls (map: + materializeMap)
    if (!budget.fits(cost + c, calls + n)) break;
    pick.push(j.id);
    cost += c;
    calls += n;
  }
  const out: string[] = [];
  if (pick.length) {
    const { results } = await db.prepare(
      `SELECT q.id, q.kind, q.path, q.map_id, q.node_letter, q.difficulty, q.attempts, q.next_run_at, c.id AS cache_id, c.body, c.fetched_at
       FROM kcnav_queue q JOIN kcnav_cache c ON c.id = q.cache_id WHERE q.id IN (SELECT value FROM json_each(?1)) ORDER BY q.id`,
    ).bind(JSON.stringify(pick)).all<QueueRow & { cache_id: number; body: string; fetched_at: string }>();
    budget.charge(cost, calls);
    for (const r of results) out.push(`${r.path}: ${await store(db, r, JSON.parse(r.body), r.cache_id, r.fetched_at)}`);
  }
  const more = pick.length < queue.length || queue.length === 200;
  return { reparsed: out, next: more ? (pick.at(-1) ?? after) : null };
}

/** Persists a successful response (also used to re-parse cached bodies). Returns a one-line summary. */
export async function store(db: D1Database, job: QueueRow, json: unknown, cacheId: number, fetchedAt: string): Promise<string> {
  if (job.kind === "map") {
    // The KCNav route is the live game map (KC3 edges.json had wrong or merged edges for 5-6, 6-4,
    // 6-5 and 7-4), so it replaces the map's edges and drops nodes it does not have.
    // ingest-map-graph leaves maps with KCNav edges alone.
    const m = parseMap(json);
    const stmts = [
      db.prepare("DELETE FROM edges WHERE map_id = ?1").bind(job.map_id),
      db.prepare("DELETE FROM nodes WHERE map_id = ?1 AND letter NOT IN (SELECT value FROM json_each(?2))")
        .bind(job.map_id, JSON.stringify(m.nodes.map((n) => n.letter))),
      ...m.nodes.map((n) => db.prepare(
        `INSERT INTO nodes (map_id, letter, x, y, color_no, event_id, node_type, is_boss, source_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT id FROM sources WHERE key = 'kcnav'))
         ON CONFLICT (map_id, letter) DO UPDATE SET x = COALESCE(nodes.x, excluded.x), y = COALESCE(nodes.y, excluded.y),
           color_no = COALESCE(excluded.color_no, nodes.color_no), event_id = COALESCE(excluded.event_id, nodes.event_id),
           node_type = COALESCE(nodes.node_type, excluded.node_type), is_boss = MAX(nodes.is_boss, excluded.is_boss)`,
      ).bind(job.map_id, n.letter, n.x, n.y, n.colorNo, n.eventId, n.nodeType, n.isBoss ? 1 : 0)),
      ...m.edges.map((e) => db.prepare(
        `INSERT INTO edges (map_id, edge_id, from_letter, to_letter, source_id)
         VALUES (?1, ?2, ?3, ?4, (SELECT id FROM sources WHERE key = 'kcnav'))`,
      ).bind(job.map_id, e.edgeId, e.from, e.to)),
    ];
    await db.batch([sourceStmt(db, fetchedAt), ...stmts]);
    // New edges change cell -> letter resolution of the poi-observed sets and the mismatch report.
    await materializeMap(db, job.map_id, fetchedAt);
    const combat = m.nodes.filter((n) => n.nodeType && COMBAT_NODE_TYPES.includes(n.nodeType)).length;
    return `map: ${m.nodes.length} nodes (${combat} combat), ${m.edges.length} edges`;
  }
  if (job.kind === "enemycomps") {
    const params = new URL(job.path, "https://x").searchParams;
    const periodStart = params.get("start") ?? "";
    const periodEnd = params.get("end") ?? "";
    const all = parseEnemyComps(json, job.node_letter, job.difficulty);
    // KCNav occasionally carries stray submissions for nodes the game types as non-combat (e.g. 1-4 A/E
    // and 5-2 B, n=1 each). Drop sets for nodes whose type is known and not a combat type.
    const typed = await db.prepare("SELECT letter, node_type FROM nodes WHERE map_id = ?1 AND node_type IS NOT NULL")
      .bind(job.map_id).all<{ letter: string; node_type: string }>();
    const nonCombat = new Set(typed.results.filter((n) => !COMBAT_NODE_TYPES.includes(n.node_type)).map((n) => n.letter));
    const sets = all.filter((s) => !nonCombat.has(s.node));
    // One batch (one transaction, one D1 call) for the whole response. Rows go as compact JSON arrays
    // expanded by json_each; a fresh set's comps get ascending ids in array order, so ships find
    // their comp by ordinal.
    const stmts = [sourceStmt(db, fetchedAt)];
    for (const s of all) {
      const key = [job.map_id, s.node, s.difficulty, periodStart, periodEnd] as const;
      // Non-observed set for the key: the old one before the DELETEs, the new one after the INSERT.
      const set = `(SELECT id FROM enemy_comp_sets WHERE map_id = ?1 AND node_letter = ?2 AND difficulty = ?3 AND period_start = ?4 AND period_end = ?5
        AND source_id IS NOT (SELECT id FROM sources WHERE key = '${OBSERVED_SOURCE}'))`;
      stmts.push(
        db.prepare(`DELETE FROM enemy_comp_ships WHERE comp_id IN (SELECT id FROM enemy_comps WHERE set_id = ${set})`).bind(...key),
        db.prepare(`DELETE FROM enemy_comps WHERE set_id = ${set}`).bind(...key),
        db.prepare(`DELETE FROM enemy_comp_sets WHERE id = ${set}`).bind(...key),
      );
      if (nonCombat.has(s.node)) continue;
      stmts.push(db.prepare(
        `INSERT INTO enemy_comp_sets (map_id, node_letter, difficulty, period_start, period_end, total_count, retrieved_at, cache_id, source_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT id FROM sources WHERE key = 'kcnav'))`,
      ).bind(...key, s.totalCount, fetchedAt, cacheId));
      const ships: unknown[] = [];
      const comps = s.comps.map((c, i) => {
        for (const sh of c.ships) ships.push([i, sh.fleet, sh.position, sh.shipId, sh.level, sh.hp, sh.fp, sh.tp, sh.aa, sh.ar, sh.equips]);
        return [c.kcnavMasterId, c.formation, c.count, c.weight, c.airpower || null, c.lbasAirpower || null];
      });
      for (const json of jsonChunks(comps)) stmts.push(db.prepare(
        `INSERT INTO enemy_comps (set_id, kcnav_master_id, formation, count, weight, airpower, lbas_airpower)
         SELECT ${set}, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
           json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]')
         FROM json_each(?6) j ORDER BY j.key`,
      ).bind(...key, json));
      for (const json of jsonChunks(ships)) stmts.push(db.prepare(
        `INSERT INTO enemy_comp_ships (comp_id, fleet, position, ship_id, level, hp, fp, tp, aa, ar, equips)
         SELECT c.id,
           json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'),
           json_extract(j.value, '$[5]'), json_extract(j.value, '$[6]'), json_extract(j.value, '$[7]'), json_extract(j.value, '$[8]'),
           json_extract(j.value, '$[9]'), json_extract(j.value, '$[10]')
         FROM json_each(?6) j
         JOIN (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM enemy_comps WHERE set_id = ${set}) c ON c.n = json_extract(j.value, '$[0]')
         ORDER BY j.key`,
      ).bind(...key, json));
    }
    // Last in the same transaction: a GET cached under the old version may already hold new rows, never the reverse.
    stmts.push(bumpDataVersion(db));
    await db.batch(stmts);
    const skipped = all.filter((s) => nonCombat.has(s.node)).map((s) => `${s.node}(n=${s.totalCount})`);
    return `enemycomps: ${sets.length} set(s) [${sets.map((s) => `${s.node}/d${s.difficulty}: ${s.comps.length} comps, n=${s.totalCount}`).join("; ")}]`
      + (skipped.length ? `; skipped non-combat ${skipped.join(", ")}` : "");
  }
  if (job.kind === "battles") return storeBattles(db, job, json, cacheId, fetchedAt);
  if (job.kind === "nodesummary") {
    const counts = parseNodeSummary(json);
    const query = new URL(job.path, "https://x").search.replace(/^\?/, "");
    await db.batch([
      db.prepare("DELETE FROM kcnav_edge_counts WHERE map_id = ?1 AND query = ?2").bind(job.map_id, query),
      ...counts.map((c) => db.prepare(
        "INSERT INTO kcnav_edge_counts (map_id, query, edge_id, runs, retrieved_at, cache_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(job.map_id, query, c.edgeId, c.runs, fetchedAt, cacheId)),
    ]);
    return `nodesummary: ${counts.length} edges, ${counts.find((c) => c.edgeId === 0)?.runs ?? 0} sorties`;
  }
  throw new Error(`unknown job kind ${job.kind}`);
}

// JSON arrays of `rows`, each below D1's bound-value size limit (2 MB; kept well under).
const MAX_JSON_PARAM = 900_000;
function jsonChunks(rows: unknown[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (buf && buf.length + s.length + 2 > MAX_JSON_PARAM) {
      out.push(`[${buf}]`);
      buf = "";
    }
    buf = buf ? `${buf},${s}` : s;
  }
  if (buf) out.push(`[${buf}]`);
  return out;
}

function sourceStmt(db: D1Database, fetchedAt: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sources (key, name, url, licence, revision, fetched_at)
     VALUES ('kcnav', 'KCNav / TsunDB (tsunkit.net)', 'https://tsunkit.net/nav/', 'none published; ask @pir0zhki before bulk use', NULL, ?1)
     ON CONFLICT (key) DO UPDATE SET fetched_at = excluded.fetched_at`,
  ).bind(fetchedAt);
}
