// Starts bench/worker.ts in a local workerd (`wrangler dev` from a temp directory, port 8790, inspector 9330) and
// times requests from the client: inside workerd, timers only advance on I/O, so CPU per unit is measured as
// (T(n) − T(0)) / n over batches (median of 3).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BENCH_PORT = 8790;

export interface BenchWorker {
  /** ms per repetition of `path?…&reps=` (the path gets `reps` appended) */
  perRep(path: string, reps: number): Promise<number>;
  post(path: string, body: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startBenchWorker(): Promise<BenchWorker> {
  const dir = mkdtempSync(join(tmpdir(), "kcsim-bench-"));
  const worker = new URL("./worker.ts", import.meta.url).pathname;
  writeFileSync(join(dir, "wrangler.toml"), `name = "kcsim-bench"\nmain = "${worker}"\ncompatibility_date = "2026-10-01"\n`);
  const bin = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;
  const proc = Bun.spawn([bin, "dev", "--port", String(BENCH_PORT), "--inspector-port", "9330", "--local", "--persist-to", join(dir, "state")], {
    cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const base = `http://127.0.0.1:${BENCH_PORT}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/ping`)).ok) break;
    } catch {
      if (i > 600) throw new Error("wrangler dev did not start");
      await Bun.sleep(100);
    }
  }
  const time = async (path: string, reps: number) => {
    const t = performance.now();
    const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}reps=${reps}`, { method: "POST" });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path}: ${text}`);
    return performance.now() - t;
  };
  return {
    perRep: async (path, reps) => {
      await time(path, Math.min(reps, 3)); // warm-up
      const samples: number[] = [];
      for (let k = 0; k < 3; k++) samples.push((await time(path, reps) - await time(path, 0)) / reps);
      return samples.sort((a, b) => a - b)[1]!;
    },
    post: async (path, body) => {
      const res = await fetch(`${base}${path}`, { method: "POST", body });
      const text = await res.text();
      if (!res.ok) throw new Error(`${path}: ${text}`);
      return text;
    },
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}
