// Per-unit CPU costs (bench/micro.ts) in bun and in a local workerd: the measurements behind src/budget.ts COST.
// Also the first grid call in a fresh workerd isolate (sim-core initSync + lazy compilation): first request minus
// the same request again, over 3 fresh `wrangler dev` processes.
//
//   bun bench/calibrate.ts [--no-workerd]
import { readFileSync } from "node:fs";
import { axisValues, DEFAULT_GRID } from "../../shared/estimate/posterior";
import { testGrid } from "../test/helpers";
import { microOps, sampleBattle } from "./micro";
import { BENCH_PORT, startBenchWorker } from "./workerd";

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const wasm = new WebAssembly.Module(readFileSync(new URL("../../sim-core/pkg/sim_core_bg.wasm", import.meta.url)));
const ops = microOps(testGrid(), wasm);
const bun = new Map<string, number>();
for (const [name, op] of Object.entries(ops)) {
  for (let i = 0; i < 5; i++) op();
  let reps = 0;
  const t0 = cpuMs();
  while (cpuMs() - t0 < 300 || reps < 10) {
    op();
    reps++;
  }
  bun.set(name, (cpuMs() - t0) / reps);
}

const workerd = new Map<string, number>();
const cold: number[] = [];
if (!process.argv.includes("--no-workerd")) {
  const w = await startBenchWorker();
  try {
    for (const name of Object.keys(ops)) {
      const reps = Math.max(5, Math.min(2000, Math.round(250 / Math.max(0.002, bun.get(name)!))));
      workerd.set(name, await w.perRep(`/micro?op=${encodeURIComponent(name)}`, reps));
    }
  } finally {
    await w.stop();
  }
  const body = JSON.stringify({ query: sampleBattle().evasion, target: "defender", evasion: axisValues(DEFAULT_GRID.ev), luck: axisValues(DEFAULT_GRID.luck) });
  const once = async () => {
    const t = performance.now();
    const res = await fetch(`http://127.0.0.1:${BENCH_PORT}/cold-grid`, { method: "POST", body });
    await res.text();
    return performance.now() - t;
  };
  for (let k = 0; k < 3; k++) {
    const fresh = await startBenchWorker();
    try {
      const first = await once();
      const warm: number[] = [];
      for (let i = 0; i < 5; i++) warm.push(await once());
      cold.push(first - warm.sort((a, b) => a - b)[2]!);
    } finally {
      await fresh.stop();
    }
  }
}
console.log("| unit | bun ms | workerd ms |\n|---|---:|---:|");
for (const name of Object.keys(ops)) console.log(`| ${name} | ${bun.get(name)!.toFixed(4)} | ${workerd.get(name)?.toFixed(4) ?? "–"} |`);
if (cold.length) console.log(`| first grid call in a fresh isolate, extra over a warm one (3 runs) | – | ${cold.map((x) => x.toFixed(2)).join(" / ")} |`);
