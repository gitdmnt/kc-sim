// Replays one recorded invocation against the real handlers with a ReplayD1 (bench/d1.ts). Shared by the bun
// runner (bench/run.ts) and the workerd bench worker (bench/worker.ts); `gridFn` is how each loads sim-core.
import type { GridFn } from "../../shared/estimate/forward";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { runScheduled } from "../src/jobs";
import { clearFitBonusCache } from "../src/estimator/job";
import { ReplayD1, type Recording } from "./d1";

/** Cache API double that always misses: every GET is measured as a cache miss. */
export const MISS_CACHE = { match: async () => undefined, put: async () => undefined } as unknown as Cache;

const LIMITER: RateLimit = { limit: async () => ({ success: true }) };

export const benchEnv = (db: D1Database): Env => ({
  DB: db, KCNAV_BASE: "https://kcnav.invalid", KCNAV_MIN_INTERVAL_MS: "65000", ENVIRONMENT: "development", IP_HASH_SALT: "bench-salt",
  WRITE_LIMITER: LIMITER,
});

export function replayer(gridFn: () => GridFn) {
  let clock = 0;
  const app = createApp({ gridFn, now: () => clock, cache: MISS_CACHE });
  const realFetch = globalThis.fetch;
  return async (rec: Recording): Promise<number> => {
    clock = rec.clock;
    clearFitBonusCache(); // every invocation as in a fresh isolate, like its recording
    const db = new ReplayD1(rec.log);
    // ReplayD1 implements the members the handlers use (prepare/bind/all/first/run/batch).
    const env = benchEnv(db as unknown as D1Database);
    const fetches = [...(rec.fetches ?? [])];
    if (rec.fetches) {
      globalThis.fetch = (async () => {
        const f = fetches.shift();
        if (!f) throw new Error("unrecorded fetch");
        return new Response(f.body, { status: f.status });
      }) as unknown as typeof fetch;
    }
    try {
      let status = 200;
      if (rec.kind === "http") {
        const res = await app.request(`http://localhost${rec.path}`, { method: rec.method, headers: rec.headers, body: rec.body }, env);
        await res.arrayBuffer();
        status = res.status;
      } else {
        await runScheduled(env, { gridFn, now: () => clock });
      }
      if (!db.done) throw new Error(`${rec.name}: replay ended before the recording`);
      return status;
    } finally {
      globalThis.fetch = realFetch;
    }
  };
}
