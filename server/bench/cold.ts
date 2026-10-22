// CPU of a fresh isolate's first invocation (docs/DEPLOY.md "CPU budget"): GET, upload, cron.
//
//   bun bench/cold.ts [--runs 3] [--db <wrangler D1 sqlite>] [--worker <bench/worker.ts of another checkout>]
//
// Records the invocations like bench/run.ts (bench/scenarios.ts), then for every scenario and run starts a fresh
// workerd (bench/workerd.ts) and times, from the client, with no I/O inside the worker (timers stand still while
// JavaScript runs, so wall time is CPU time; a /ping is subtracted):
//   global scope   POST /import: src/index.ts and everything it imports, evaluated lazily (bench/worker.ts)
//   first          the first replay of the recording in that isolate (lazy JS compilation, sim-core if used)
//   warm           the same replay again (median of 5)
// Production bills only `first`: the global scope runs at isolate startup, outside the invocation's cpuTime (a
// 60–100 ms busy loop there did not show up in `wrangler tail`, docs/DEPLOY.md §10). So one-off work belongs in the
// global scope, and `first` is what a fresh isolate's invocation costs. `--worker` runs another checkout's bench
// worker over the same recordings (before/after).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { recordScenarios } from "./scenarios";
import { startBenchWorker } from "./workerd";

const argAt = (name: string) => process.argv.indexOf(name);
const runs = argAt("--runs") < 0 ? 3 : Number(process.argv[argAt("--runs") + 1]);
const worker = argAt("--worker") < 0 ? undefined : process.argv[argAt("--worker") + 1];
const WRANGLER_STATE = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url).pathname;
const localDb = argAt("--db") < 0
  ? join(WRANGLER_STATE, readdirSync(WRANGLER_STATE).find((f) => /^[0-9a-f]{64}\.sqlite$/.test(f))!)
  : process.argv[argAt("--db") + 1]!;

const SCENARIOS = /^(GET \/health|GET \/maps\/\d-\d \(heaviest detail\)|GET \/ships\/1501|POST \/observations \(1 obs|cron \(idle\)|cron \(fold backlog\))/;
const recs = await recordScenarios({ localDb, filter: SCENARIOS });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const rows: Record<string, string>[] = [];
for (const rec of recs) {
  const samples: { scope: number; first: number; warm: number }[] = [];
  for (let k = 0; k < runs; k++) {
    const w = await startBenchWorker(worker);
    try {
      await w.post("/load", JSON.stringify(recs));
      const pings: number[] = [];
      for (let i = 0; i < 3; i++) pings.push(await w.once("/ping"));
      const ping = median(pings);
      const scope = await w.once("/import") - ping;
      const path = `/run?name=${encodeURIComponent(rec.name)}&reps=1`;
      const first = await w.once(path) - ping;
      const warm: number[] = [];
      for (let i = 0; i < 5; i++) warm.push(await w.once(path) - ping);
      samples.push({ scope, first, warm: median(warm) });
    } finally {
      await w.stop();
    }
  }
  const m = (k: "scope" | "first" | "warm") => median(samples.map((s) => s[k])).toFixed(2);
  const coldTotal = median(samples.map((s) => s.scope + s.first));
  rows.push({ invocation: rec.name, "global scope ms": m("scope"), "first ms": m("first"), "cold total ms": coldTotal.toFixed(2), "warm ms": m("warm") });
}
console.table(rows);
