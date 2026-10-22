// Pure KCNav throttling / retry policy. Time is always passed in (epoch ms) so tests control it.

export const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Retry delay after the n-th failed attempt (n >= 1): interval × 2^(n-1), capped at 6 h. */
export function backoffMs(attempts: number, minIntervalMs: number): number {
  return Math.min(minIntervalMs * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/** 2xx ok; 429 / 5xx / network failure (status 0) retry; other statuses are permanent failures. */
export function classifyStatus(status: number): "ok" | "retry" | "fail" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 0 || status === 429 || status >= 500) return "retry";
  return "fail";
}

export interface ResponsePlan {
  jobStatus: "done" | "pending" | "failed";
  attempts: number;
  nextRunAt: number;
  /** New global gate: no KCNav request before this time. */
  gateUntil: number;
}

/**
 * Decides job and gate state after a KCNav response. The gate never opens sooner than
 * `minIntervalMs` after the request; a 429 pushes it out by the job's backoff as well.
 */
export function planAfterResponse(p: {
  status: number;
  attempts: number;
  requestedAt: number;
  minIntervalMs: number;
  maxAttempts?: number;
}): ResponsePlan {
  const attempts = p.attempts + 1;
  const base = p.requestedAt + p.minIntervalMs;
  const kind = classifyStatus(p.status);
  if (kind === "ok") return { jobStatus: "done", attempts, nextRunAt: p.requestedAt, gateUntil: base };
  if (kind === "fail") return { jobStatus: "failed", attempts, nextRunAt: p.requestedAt, gateUntil: base };
  const delay = backoffMs(attempts, p.minIntervalMs);
  const gateUntil = p.status === 429 ? Math.max(base, p.requestedAt + delay) : base;
  if (attempts >= (p.maxAttempts ?? MAX_ATTEMPTS)) return { jobStatus: "failed", attempts, nextRunAt: p.requestedAt, gateUntil };
  return { jobStatus: "pending", attempts, nextRunAt: p.requestedAt + delay, gateUntil };
}

export type TickDecision =
  | { action: "wait"; waitMs: number; reason: "gate" }
  | { action: "idle"; waitMs: number | null }
  | { action: "request"; jobId: number };

/**
 * Chooses what a tick does. `nextAllowedAt` is the persisted global gate. `nextJob` is the pending
 * job to run next: the highest-priority job already due, else the pending job due soonest, else
 * null (no pending jobs).
 */
export function decideTick(p: {
  now: number;
  nextAllowedAt: number;
  nextJob: { id: number; nextRunAt: number } | null;
}): TickDecision {
  if (!p.nextJob) return { action: "idle", waitMs: null };
  if (p.nextJob.nextRunAt > p.now) {
    return { action: "idle", waitMs: Math.max(p.nextJob.nextRunAt, p.nextAllowedAt) - p.now };
  }
  if (p.nextAllowedAt > p.now) return { action: "wait", waitMs: p.nextAllowedAt - p.now, reason: "gate" };
  return { action: "request", jobId: p.nextJob.id };
}
