// CPU of the first invocation of a fresh isolate (docs/DEPLOY.md "CPU budget"): GET, upload, cron.
//
//   bun bench/cold.ts [--runs 3] [--only get|upload|cron|cron-estimate]
//
// Each run starts the real worker (src/index.ts, wrangler.toml top level) in its own `wrangler dev` on port 8791
// over a copy of the local D1 (the dev database is not touched), then measures the workerd process's CPU (rusage,
// all threads, so it includes miniflare's D1 object) across: startup until ready (the global scope runs here),
// the first invocation, and the same invocation again (warm). cold − warm is what a fresh isolate adds.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { realUploadBody } from "./fixtures";
import { sha256Hex } from "../src/auth/clients";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("../", import.meta.url).pathname;
const STATE = join(ROOT, ".wrangler/state/v3/d1");

// ---- CPU of another process: proc_pid_rusage (macOS, mach ticks) or /proc/<pid>/schedstat (Linux, ns) ----

const darwin = process.platform === "darwin";
const libc = darwin
  ? dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
  : null;
const tickNs = (() => {
  if (!libc) return 1;
  const tb = new Uint32Array(2);
  libc.symbols.mach_timebase_info(ptr(tb));
  return tb[0]! / tb[1]!;
})();

/** CPU of all `pids` together (wrangler dev runs two workerd processes: the user worker and miniflare's proxy). */
async function cpuMs(pids: number[]): Promise<number> {
  let sum = 0;
  for (const pid of pids) {
    if (libc) {
      const buf = new BigUint64Array(64); // rusage_info_v2: uuid[16], user, system, ...
      if (libc.symbols.proc_pid_rusage(pid, 2, ptr(buf)) !== 0) throw new Error(`proc_pid_rusage ${pid}`);
      sum += Number(buf[2]! + buf[3]!) * tickNs / 1e6;
    } else {
      sum += Number((await Bun.file(`/proc/${pid}/schedstat`).text()).split(" ")[0]) / 1e6;
    }
  }
  return sum;
}

async function workerdDescendants(root: number): Promise<number[]> {
  const ps = await Bun.$`ps -A -o pid=,ppid=,comm=`.text();
  const rows = ps.trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([pid, ppid, ...c]) => ({ pid: +pid!, ppid: +ppid!, comm: c.join(" ") }));
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const r of rows.filter((x) => x.ppid === p)) {
      if (r.comm.endsWith("workerd")) out.push(r.pid);
      queue.push(r.pid);
    }
  }
  return out;
}

// ---- scenario database: a copy of the local D1 plus upload clients and (optionally) estimator work ----

const TOKENS = ["a", "b"].map((c) => `coldbench${c.repeat(34)}`); // 43 base64url characters, like issued tokens

async function prepareState(estimatorWork: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kcsim-cold-"));
  cpSync(STATE, join(dir, "v3/d1"), { recursive: true });
  const objects = join(dir, "v3/d1/miniflare-D1DatabaseObject");
  const file = readdirSync(objects).find((f) => /^[0-9a-f]{64}\.sqlite$/.test(f))!;
  const db = new Database(join(objects, file));
  for (const [i, t] of TOKENS.entries()) {
    db.run("INSERT INTO clients (id, token_hash, ip_hash, created_at, last_post_at) VALUES (?1, ?2, 'cold-bench', ?3, 0)",
      [`c_coldbench${i}`, await sha256Hex(t), new Date().toISOString()]);
  }
  // count + fold work for the estimator stage (the only stage that calls sim-core)
  if (estimatorWork) db.run("UPDATE observation_ships SET est_at = NULL");
  db.close();
  return dir;
}

// ---- scenarios: the invocation, made twice (cold, then warm) ----

type Scenario = { name: string; estimatorWork?: boolean; call: (i: number) => Promise<string> };
const expect = async (res: Response, status: number) => {
  const text = await res.text();
  if (res.status !== status) throw new Error(`${res.url}: ${res.status} ${text.slice(0, 300)}`);
  return text.slice(0, 200);
};
const SCENARIOS: Scenario[] = [
  // distinct URLs: the second request must miss the Cache API too
  { name: "get", call: (i) => fetch(`${BASE}/api/v1/maps/1-5?cold=${i}`).then((r) => expect(r, 200)) },
  {
    name: "upload",
    call: (i) => fetch(`${BASE}/api/v1/observations`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKENS[i]}` }, body: realUploadBody(i),
    }).then((r) => expect(r, 202)),
  },
  { name: "cron", call: () => fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`).then((r) => expect(r, 200)) },
  { name: "cron-estimate", estimatorWork: true, call: () => fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`).then((r) => expect(r, 200)) },
];

async function measure(s: Scenario) {
  const dir = await prepareState(!!s.estimatorWork);
  const bin = join(ROOT, "node_modules/.bin/wrangler");
  const proc = Bun.spawn([bin, "dev", "--local", "--port", String(PORT), "--inspector-port", "9331", "--persist-to", dir, "--test-scheduled", "--log-level", "info"], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const logs: string[] = [];
  const reader = (async () => {
    for await (const chunk of proc.stdout) logs.push(new TextDecoder().decode(chunk));
  })();
  try {
    for (let i = 0; !logs.join("").includes("Ready on"); i++) {
      if (i > 600) throw new Error(`wrangler dev did not start:\n${logs.join("")}`);
      await Bun.sleep(100);
    }
    const pids = await workerdDescendants(proc.pid);
    if (!pids.length) throw new Error("no workerd child");
    await Bun.sleep(1500); // let startup settle
    const settle = async () => {
      // waitUntil work (upload ingest) and idle threads: wait until the processes stop using CPU
      let prev = await cpuMs(pids);
      for (let i = 0; i < 40; i++) {
        await Bun.sleep(150);
        const now = await cpuMs(pids);
        if (now - prev < 0.5) return now;
        prev = now;
      }
      return prev;
    };
    const startup = await settle();
    const c0 = startup;
    const note0 = await s.call(0);
    const c1 = await settle();
    const note1 = await s.call(1);
    const c2 = await settle();
    return { startup, cold: c1 - c0, warm: c2 - c1, note: [note0, note1] };
  } finally {
    proc.kill();
    await proc.exited;
    await reader.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

const runsAt = process.argv.indexOf("--runs");
const runs = runsAt < 0 ? 3 : Number(process.argv[runsAt + 1]);
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? undefined : process.argv[onlyAt + 1];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const rows: Record<string, string | number>[] = [];
for (const s of SCENARIOS.filter((x) => !only || x.name === only)) {
  const r = [];
  for (let k = 0; k < runs; k++) r.push(await measure(s));
  const cold = median(r.map((x) => x.cold));
  const warm = median(r.map((x) => x.warm));
  rows.push({
    scenario: s.name, "startup ms": median(r.map((x) => x.startup)).toFixed(0), "cold ms": cold.toFixed(2), "warm ms": warm.toFixed(2),
    "cold − warm": (cold - warm).toFixed(2), first: r[0]!.note[0]!.slice(0, 90),
  });
}
console.table(rows);
