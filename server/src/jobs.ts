// Background work under the Workers Free CPU limit (docs/DEPLOY.md "CPU budget"). One cron invocation per
// minute runs the stages below under one cost-model budget (src/budget.ts) and one lease; each stage stops when
// its next unit would not fit, and its queue keeps the rest for the next minute:
//   ingest (staged uploads → observations, ≤ 40 %), aggregation (≤ 30 %), estimator (the rest).
// An upload request runs ingest + aggregation with what its own budget has left (routes/write.ts), so stored
// observations appear within the request when the queue is short.
import type { GridFn } from "../../shared/estimate/forward";
import { Budget, COST, TARGET_MS } from "./budget";
import type { Env } from "./env";
import { runEstimator, type EstimatorResult } from "./estimator/job";
import { ingestPending, type IngestResult } from "./ingest/upload";
import { aggregationBacklog, foldPending, materializeDirty, type AggregateResult } from "./observed/aggregate";

export interface JobDeps {
  /** sim-core hitProbabilityGrid */
  gridFn: () => GridFn;
  now: () => number;
}

/** Longer than any invocation; a crashed holder blocks the jobs at most this long. */
const LEASE_MS = 2 * 60_000;

/** Runs `fn` while holding kv_state.jobs_lock_until; null when another invocation holds it. */
export async function withJobsLease<T>(db: D1Database, now: number, budget: Budget, fn: () => Promise<T>): Promise<T | null> {
  const lease = String(now + LEASE_MS);
  budget.charge(2 * COST.d1Call, 2); // claim and release
  const claimed = await db.prepare("UPDATE kv_state SET value = ?1 WHERE key = 'jobs_lock_until' AND CAST(value AS INTEGER) <= ?2")
    .bind(lease, now).run();
  if (!claimed.meta.changes) return null;
  try {
    return await fn();
  } finally {
    await db.prepare("UPDATE kv_state SET value = '0' WHERE key = 'jobs_lock_until' AND value = ?1").bind(lease).run();
  }
}

export interface JobsResult {
  busy: boolean;
  /** nothing queued: no lease taken, nothing written */
  idle?: boolean;
  ingest?: IngestResult;
  aggregation?: AggregateResult;
  estimator?: EstimatorResult;
  /** cost-model CPU and D1 calls of this invocation */
  spentMs: number;
  d1Calls: number;
}

/**
 * Ingest and the aggregation fold under shares of what is left, between two passes over maps ready for
 * re-materialisation (rare, possibly most of a run: first with the whole budget, then with what is left so that
 * a burst that was just folded in shows up at once).
 */
async function storeStages(db: D1Database, budget: Budget, now: number, ingestShare: number) {
  const iso = () => new Date(now).toISOString();
  const maps = await materializeDirty(db, budget, iso);
  const total = budget.left;
  const ib = budget.slice(ingestShare * total);
  const ingest = await ingestPending(db, ib, now);
  budget.absorb(ib);
  const ab = budget.slice(0.3 * total);
  const folded = await foldPending(db, ab, iso);
  budget.absorb(ab);
  if (folded.aggregated) maps.push(...(await materializeDirty(db, budget, iso)));
  const aggregation: AggregateResult = { ...folded, maps, ...(await aggregationBacklog(db, budget)) };
  return { ingest, aggregation };
}

/** Whether any queue has work (one read; an idle cron then writes nothing, not even its lease). */
async function hasWork(db: D1Database, budget: Budget): Promise<boolean> {
  const r = await db.prepare(
    `SELECT EXISTS (SELECT 1 FROM upload_items) OR EXISTS (SELECT 1 FROM observations WHERE aggregated_at IS NULL AND quarantine IS NULL)
       OR EXISTS (SELECT 1 FROM poi_dirty_maps) OR EXISTS (SELECT 1 FROM observation_ships WHERE est_at IS NULL)
       OR EXISTS (SELECT 1 FROM estimator_rolls) OR EXISTS (SELECT 1 FROM estimator_accum WHERE dirty_since IS NOT NULL) AS work`,
  ).first<{ work: number }>();
  budget.charge(COST.d1Call, 1);
  return !!r?.work;
}

const done = (budget: Budget, r: Partial<JobsResult> & { busy: boolean }): JobsResult =>
  ({ ...r, spentMs: Number(budget.spent.toFixed(2)), d1Calls: budget.d1Calls });

/** The cron: every stage under one budget (default TARGET_MS) and the jobs lease. */
export async function runScheduled(env: Env, deps: JobDeps, budgetMs: number = TARGET_MS): Promise<JobsResult> {
  const budget = new Budget(budgetMs);
  budget.charge(COST.invocation);
  if (!(await hasWork(env.DB, budget))) return done(budget, { busy: false, idle: true });
  const now = deps.now();
  const r = await withJobsLease(env.DB, now, budget, async () => {
    const stored = await storeStages(env.DB, budget, now, 0.4);
    const eb = budget.slice(budget.left);
    const estimator = await runEstimator(env.DB, { gridFn: deps.gridFn, budget: eb, now });
    budget.absorb(eb);
    return { ...stored, estimator };
  });
  return done(budget, { busy: r === null, ...r });
}

/** Ingest + aggregation (no estimator) under `budget`: after an upload, and POST /admin/ingest/run. */
export async function runIngest(env: Env, now: number, budget: Budget): Promise<JobsResult> {
  const r = await withJobsLease(env.DB, now, budget, () => storeStages(env.DB, budget, now, 0.6));
  return done(budget, { busy: r === null, ...r });
}
