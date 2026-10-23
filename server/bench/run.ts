// CPU per invocation of every worker path (docs/DEPLOY.md "CPU budget").
//
//   bun bench/run.ts [--workerd] [--filter <regex>] [--db <wrangler D1 sqlite>] [--out <json>]
//
// 1. Records one invocation per path (bench/scenarios.ts) against bun:sqlite.
// 2. bun: replays each recording many times against the real handlers with D1 replaced by its recorded traffic
//    (bench/d1.ts: request serialization and response parsing stay in the worker, SQL does not) and reports
//    process.cpuUsage() per invocation.
// 3. --workerd: the same replays inside a local workerd (bench/workerd.ts), timed in batches from the client.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunGrid } from "../scripts/lib/sim-core";
import type { Recording } from "./d1";
import { replayer } from "./replay";
import { recordScenarios } from "./scenarios";
import { startBenchWorker } from "./workerd";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const WRANGLER_STATE = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url).pathname;
const localDb = arg("--db") ?? join(WRANGLER_STATE, readdirSync(WRANGLER_STATE).find((f) => /^[0-9a-f]{64}\.sqlite$/.test(f))!);
const filter = new RegExp(arg("--filter") ?? ".");

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

async function benchBun(recs: Recording[]) {
  const replay = replayer(bunGrid);
  const out = new Map<string, number>();
  for (const r of recs) {
    for (let i = 0; i < 3; i++) await replay(r); // warm-up (JIT, lazy wasm compilation)
    let reps = 0;
    const t0 = cpuMs();
    while (cpuMs() - t0 < 300 || reps < 5) {
      await replay(r);
      reps++;
    }
    out.set(r.name, (cpuMs() - t0) / reps);
  }
  return out;
}

async function benchWorkerd(recs: Recording[], bunMs: Map<string, number>) {
  const w = await startBenchWorker();
  try {
    await w.post("/load", JSON.stringify(recs));
    const out = new Map<string, number>();
    for (const r of recs) {
      const reps = Math.max(3, Math.min(400, Math.round(250 / Math.max(0.05, bunMs.get(r.name) ?? 1))));
      out.set(r.name, await w.perRep(`/run?name=${encodeURIComponent(r.name)}`, reps));
    }
    return out;
  } finally {
    await w.stop();
  }
}

const recs = await recordScenarios({ localDb, filter });
const outFile = arg("--out") ?? new URL("../.tmp/bench/latest.json", import.meta.url).pathname;
mkdirSync(join(outFile, ".."), { recursive: true });
const bun = await benchBun(recs);
const workerd = process.argv.includes("--workerd") ? await benchWorkerd(recs, bun) : null;
const rows = recs.map((r) => ({
  name: r.name, d1Calls: r.log.length, bunMs: Number(bun.get(r.name)!.toFixed(3)),
  workerdMs: workerd ? Number(workerd.get(r.name)!.toFixed(3)) : null, note: r.note,
}));
writeFileSync(outFile, JSON.stringify(rows, null, 2));
console.log("| path | D1 calls | bun ms | workerd ms | result |\n|---|---:|---:|---:|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.d1Calls} | ${r.bunMs.toFixed(2)} | ${r.workerdMs?.toFixed(2) ?? "–"} | ${r.note.replace(/\|/g, "/").slice(0, 90)} |`);
