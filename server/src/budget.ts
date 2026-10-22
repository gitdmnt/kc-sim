// CPU budget of one invocation (docs/DEPLOY.md "CPU budget"). Workers Free stops an invocation after 10 ms of
// CPU, and inside workerd neither Date.now() nor performance.now() advance while JavaScript runs, so a job cannot
// time itself. Background work therefore counts its work units and charges each one with a cost per unit
// measured on workerd (bench/calibrate.ts), rounded up. A job checks `fits` before a unit and stops when the
// rest of the invocation would not fit; the queue keeps the remainder for the next invocation.

/**
 * Milliseconds of workerd CPU per unit: local workerd on an Apple M-series machine (bench/calibrate.ts unit costs,
 * bench/run.ts whole invocations), rounded up to about 1.5× the measurement. Production machines may be slower;
 * the 5 ms target leaves the other half of the 10 ms limit as headroom.
 */
export const COST = {
  /** fixed part of a scheduled invocation (lease, queue probes, isolate overhead) */
  invocation: 0.3,
  /** one D1 call (request JSON + response parse + row objects), before its payload */
  d1Call: 0.03,
  /** per KB of D1 request/response payload (JSON.stringify of params, JSON.parse of rows; measured 0.0007–0.0009) */
  d1Kb: 0.002,

  // ---- upload request (routes/write.ts) ----
  /** auth (SHA-256, HMAC), limiter, post slot, staging batch */
  uploadRequest: 0.3,
  /** per KB of request body (read, decode, bound once as a D1 parameter) */
  uploadKb: 0.004,

  // ---- ingest (upload_items -> observations) ----
  /** per staged observation: JSON.parse, schema, re-derivation, validation, insert rows; and per KB of it */
  ingestItem: 0.03,
  ingestKb: 0.01,
  /** master data + map graph lookups of one client group */
  ingestGroup: 0.15,

  // ---- aggregation ----
  aggregateObservation: 0.015,
  /** re-materialising one map's poi-observed comp sets, per comp-count row */
  materializeRow: 0.004,
  materializeMap: 0.1,

  // ---- KCNav (kcnav/tick.ts reparse) ----
  /** one cached response re-parsed and stored, plus per KB of its body (tick of a 165 KB response: 1.6 ms measured) */
  kcnavJob: 0.2,
  kcnavKb: 0.015,

  // ---- estimator ----
  /** fit bonus table (once per run with rolls to count) */
  fitBonuses: 0.9,
  /** one count step: master data of its observations, the count batch */
  estimateStep: 0.15,
  /** per battle observation turned into rolls (raw re-parse, buildObservations, signatures), and per KB of raw */
  estimateObservation: 0.12,
  estimateKb: 0.012,
  /** one hitProbabilityGrid call (201 × 101) + folding it into a log-likelihood grid (0.08 measured) */
  gridCall: 0.12,
  /** encoding or decoding one log-likelihood grid (base64 Float32, 20 301 values; 0.14 / 0.03 measured) */
  gridIo: 0.12,
  /** marginals + summary of one ship (both grids decoded; 0.45 measured) */
  summarizeShip: 0.7,
} as const;

/** D1 calls (queries / batches) a Workers Free invocation may make. */
export const D1_CALLS_FREE = 50;

/** Target CPU per invocation: half the Workers Free limit. */
export const TARGET_MS = 5;

/**
 * Queue sizes reported by uploads and job runs are counted up to this many rows: COUNT(*) reads every row it
 * counts (D1 Free: 5 M rows read a day), and a backlog is just as actionable at "1000+".
 */
export const BACKLOG_COUNT_CAP = 1000;

export class Budget {
  spent = 0;
  d1Calls = 0;
  constructor(readonly limitMs: number = TARGET_MS, readonly d1Limit = D1_CALLS_FREE - 8) {}

  /** Whether `ms` more CPU and `calls` more D1 calls fit. */
  fits(ms: number, calls = 0): boolean {
    return this.spent + ms <= this.limitMs && this.d1Calls + calls <= this.d1Limit;
  }

  charge(ms: number, calls = 0): void {
    this.spent += ms;
    this.d1Calls += calls;
  }

  /** CPU left for work units. */
  get left(): number {
    return Math.max(0, this.limitMs - this.spent);
  }

  /** A budget for one stage: at most `ms` of what is left (and the D1 calls left). Charge it back with `absorb`. */
  slice(ms: number): Budget {
    return new Budget(Math.min(ms, this.left), this.d1Limit - this.d1Calls);
  }

  absorb(stage: Budget): void {
    this.charge(stage.spent, stage.d1Calls);
  }
}
