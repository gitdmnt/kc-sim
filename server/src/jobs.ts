// Background work (docs/DEPLOY.md §5 "Jobs", "CPU budget"). scripts/run-jobs.ts runs the stages below in GitHub
// Actions (daily, against production D1 over the D1 HTTP API) in passes under one cost-model budget per run
// (RUN_MS, RUN_D1_CALLS; src/budget.ts) and one lease. A pass gives each stage a share of PASS_MS; each stage
// stops when its next unit would not fit:
//   ingest (staged uploads → observations, ≤ 40 %), aggregation (≤ 30 %), estimator (the rest).
// Passes repeat until no queue has work, a pass gets nothing done, or the run's budget is spent; the queues keep
// the rest for the next run. Upload requests only stage (routes/write.ts); stored observations appear with the
// next jobs run, within about a day.
import type { GridFn } from "../../shared/estimate/forward";
import { Budget, COST, PASS_MS, RUN_MS } from "./budget";
import { runEstimator, type EstimatorResult } from "./estimator/job";
import { ingestPending, type IngestResult } from "./ingest/upload";
import { aggregationBacklog, foldPending, materializeDirty, type AggregateResult } from "./observed/aggregate";

export interface JobDeps {
  /** sim-core hitProbabilityGrid */
  gridFn: () => GridFn;
  now: () => number;
}

/**
 * Longer than any run: ≤ RUN_D1_CALLS D1 calls, each a D1 HTTP API request (≥ 250 ms apart) from GitHub Actions,
 * or a worker invocation (admin endpoints). A crashed holder blocks the jobs at most this long.
 */
const LEASE_MS = 30 * 60_000;

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
  /** passes over the stages (0 when idle or busy) */
  passes: number;
  /** cost-model CPU and D1 calls of this run */
  spentMs: number;
  d1Calls: number;
}

type Stages = Pick<JobsResult, "ingest" | "aggregation" | "estimator">;

/**
 * Ingest and the aggregation fold under shares of what is left, between two passes over maps ready for
 * re-materialisation (rare, possibly most of a pass: first with the whole budget, then with what is left so that
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

/** Whether any queue has work (one read; an idle jobs run then writes nothing, not even its lease). */
async function hasWork(db: D1Database, budget: Budget): Promise<boolean> {
  const r = await db.prepare(
    `SELECT EXISTS (SELECT 1 FROM upload_items) OR EXISTS (SELECT 1 FROM observations WHERE aggregated_at IS NULL AND quarantine IS NULL)
       OR EXISTS (SELECT 1 FROM poi_dirty_maps) OR EXISTS (SELECT 1 FROM observation_ships WHERE est_at IS NULL)
       OR EXISTS (SELECT 1 FROM estimator_rolls) OR EXISTS (SELECT 1 FROM estimator_accum WHERE dirty_since IS NOT NULL) AS work`,
  ).first<{ work: number }>();
  budget.charge(COST.d1Call, 1);
  return !!r?.work;
}

/** Adds one pass to the run's totals: counts add up, map / ship lists merge, backlog sizes are the last pass's. */
function addPass<T extends object>(total: T | undefined, pass: T): T {
  if (!total) return pass;
  const out: Record<string, unknown> = { ...(total as Record<string, unknown>) };
  for (const [k, v] of Object.entries(pass)) {
    const t = out[k];
    if (t === undefined || k === "remaining" || k === "dirtyMaps") out[k] = v;
    else if (typeof v === "number") out[k] = (t as number) + v;
    else if (Array.isArray(v)) out[k] = [...new Set([...(t as number[]), ...v])].sort((a, b) => a - b);
    else out[k] = addPass(t as object, v as object);
  }
  return out as T;
}

const done = (budget: Budget, passes: number, r: Partial<JobsResult> & { busy: boolean }): JobsResult =>
  ({ ...r, passes, spentMs: Number(budget.spent.toFixed(2)), d1Calls: budget.d1Calls });

/**
 * One jobs run (scripts/run-jobs.ts in GitHub Actions, POST /admin/jobs/run; without the estimator POST
 * /admin/ingest/run): passes over the stages under the jobs lease until the queues are empty, a pass gets
 * nothing done, or `budgetMs` (default RUN_MS) or RUN_D1_CALLS is spent.
 */
export async function runJobs(
  db: D1Database, deps: JobDeps, { budgetMs = RUN_MS, estimator = true }: { budgetMs?: number; estimator?: boolean } = {},
): Promise<JobsResult> {
  const budget = new Budget(budgetMs);
  budget.charge(COST.invocation);
  if (!(await hasWork(db, budget))) return done(budget, 0, { busy: false, idle: true });
  const now = deps.now();
  let passes = 0;
  const r = await withJobsLease(db, now, budget, async () => {
    let total: Stages | undefined;
    for (;;) {
      const pass = budget.slice(PASS_MS);
      const { ingest: i, aggregation: a } = await storeStages(db, pass, now, estimator ? 0.4 : 0.6);
      const e = estimator ? await runEstimator(db, { gridFn: deps.gridFn, budget: pass, now }) : undefined;
      budget.absorb(pass);
      passes++;
      total = addPass(total, { ingest: i, aggregation: a, ...(e && { estimator: e }) });
      // a pass that moved no queue: what is left cannot progress in this run
      const moved = i.ingested + i.duplicates + i.rejected + a.aggregated + a.failed + a.maps.length + (e ? e.observations + e.gridCalls + e.summarized : 0);
      if (!moved || budget.left === 0 || !(await hasWork(db, budget))) return total;
    }
  });
  return done(budget, passes, { busy: r === null, ...r });
}
