// workerd side of the benchmarks (bench/workerd.ts): POST /load (recordings JSON), POST /run?name=&reps= (replays
// `reps` times with no I/O in between, so the client's wall time is CPU time), POST /micro?op=&reps= (one
// bench/micro.ts unit `reps` times), GET /ping, POST /import (bench/cold.ts).
//
// The worker's modules are imported on first use, not statically: esbuild turns `import()` of a bundled module into
// a lazy initializer, so POST /import in a fresh isolate runs the global scope of src/index.ts and everything it
// imports, which is what a fresh production isolate runs before its first invocation.
import simCoreModule from "../../sim-core/pkg/sim_core_bg.wasm?module";
import type { Recording } from "./d1";
import type { MicroOps } from "./micro";

let recordings = new Map<string, Recording>();
let micro: MicroOps | null = null;
let replay: ((rec: Recording) => Promise<number>) | null = null;

/** The real entry first (its global scope), then the bench modules over it. Returns the sim-core grid getter. */
async function load() {
  await import("../src/index");
  const [{ replayer }, { simCoreGrid }] = await Promise.all([import("./replay"), import("../src/estimator/wasm")]);
  replay ??= replayer(simCoreGrid);
  return simCoreGrid;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const reps = Number(url.searchParams.get("reps") ?? 1);
    try {
      if (url.pathname === "/ping") return new Response("ok");
      if (url.pathname === "/load") {
        recordings = new Map((JSON.parse(await req.text()) as Recording[]).map((r) => [r.name, r]));
        return new Response(String(recordings.size));
      }
      if (url.pathname === "/import") {
        await load();
        return new Response("ok");
      }
      if (url.pathname === "/run") {
        const rec = recordings.get(url.searchParams.get("name") ?? "");
        if (!rec) return new Response("unknown recording", { status: 404 });
        await load();
        for (let i = 0; i < reps; i++) await replay!(rec);
        return new Response("ok");
      }
      if (url.pathname === "/micro") {
        const grid = await load();
        micro ??= (await import("./micro")).microOps(grid(), simCoreModule);
        const op = micro[url.searchParams.get("op") ?? ""];
        if (!op) return new Response(JSON.stringify(Object.keys(micro)), { status: 404 });
        for (let i = 0; i < reps; i++) op();
        return new Response("ok");
      }
      // first use of sim-core in a fresh isolate: initSync alone, or + lazy compilation of everything a grid call touches
      if (url.pathname === "/cold-init") return new Response(String((await load())().length));
      if (url.pathname === "/cold-grid") {
        const grid = (await load())()(JSON.parse(await req.text()));
        return new Response(String(grid.length));
      }
    } catch (e) {
      return new Response(String((e as Error).stack ?? e), { status: 500 });
    }
    return new Response("not found", { status: 404 });
  },
};
