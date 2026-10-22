// KCNav queue CLI. Talks to the running worker's admin API (wrangler dev), which owns the D1 queue
// and the persisted ≥65 s gate. Usage:
//   bun scripts/kcnav.ts enqueue --maps 1-5[,2-5|normal] --kinds map,enemycomps,nodesummary
//        [--batch | --edges 6,10 | --nodes J,I] [--difficulty 4] [--start 2026-08-01] [--end …]
//        [--filters minSpeed=10,include=DD] [--priority 50] [--refresh]
//   bun scripts/kcnav.ts run [--max 3] [--follow]   single-worker loop; stops after --max requests, or when
//                                                   the queue is empty unless --follow (then polls every 5 min)
//   bun scripts/kcnav.ts status                     queue counts, ETA, failures, per-map comp coverage
//   bun scripts/kcnav.ts queue [--status pending]
import { parseArgs } from "node:util";
import { call } from "./lib/admin";

const NORMAL_MAPS = [
  "1-1", "1-2", "1-3", "1-4", "1-5", "1-6", "2-1", "2-2", "2-3", "2-4", "2-5", "3-1", "3-2", "3-3", "3-4", "3-5",
  "4-1", "4-2", "4-3", "4-4", "4-5", "5-1", "5-2", "5-3", "5-4", "5-5", "5-6", "6-1", "6-2", "6-3", "6-4", "6-5",
  "7-1", "7-2", "7-3", "7-4", "7-5",
];

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    maps: { type: "string" }, kinds: { type: "string" }, nodes: { type: "string" }, edges: { type: "string" },
    batch: { type: "boolean" }, difficulty: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    filters: { type: "string" }, priority: { type: "string" }, refresh: { type: "boolean" }, max: { type: "string" },
    follow: { type: "boolean" }, status: { type: "string" },
  },
});
const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
const stamp = () => new Date().toISOString();

switch (positionals[0]) {
  case "enqueue": {
    const maps = values.maps === "normal" ? NORMAL_MAPS : list(values.maps) ?? [];
    const filters = list(values.filters)?.map((kv) => kv.split("=") as [string, string]);
    const body = {
      kinds: list(values.kinds) ?? ["map", "enemycomps"], nodes: list(values.nodes), edges: list(values.edges)?.map(Number),
      batch: values.batch, difficulty: values.difficulty ? Number(values.difficulty) : undefined, start: values.start,
      end: values.end, filters: filters ? Object.fromEntries(filters) : undefined,
      priority: values.priority ? Number(values.priority) : undefined, refresh: values.refresh,
    };
    // The admin endpoint accepts at most 50 maps per call.
    for (let i = 0; i < maps.length; i += 50) {
      console.log(JSON.stringify(await call("POST", "/admin/kcnav/enqueue", { ...body, maps: maps.slice(i, i + 50) }), null, 2));
    }
    break;
  }
  case "run": {
    const max = Number(values.max ?? Infinity);
    let requests = 0;
    while (requests < max) {
      let r: { action: string; waitMs: number | null };
      try {
        r = (await call("POST", "/admin/kcnav/tick")) as typeof r;
      } catch (e) {
        // Worker restarting / not up yet: retry later; the gate lives in D1, so nothing is lost.
        console.log(stamp(), "tick failed:", String(e));
        await Bun.sleep(30_000);
        continue;
      }
      console.log(stamp(), JSON.stringify(r));
      if (r.action === "requested") requests++;
      if (requests >= max) break;
      if (r.action === "idle" && r.waitMs === null) {
        if (!values.follow) break;
        await Bun.sleep(300_000);
        continue;
      }
      await Bun.sleep((r.waitMs ?? 0) + 500);
    }
    console.log(`${stamp()} done: ${requests} KCNav request(s)`);
    break;
  }
  case "status": {
    const s = (await call("GET", "/admin/kcnav/status")) as {
      now: number; nextAllowedAt: number; pending: number; etaMinutes: number;
      queue: { kind: string; status: string; n: number }[]; lastFinished: unknown; failed: { path: string; last_error: string }[];
      normalMaps: { map: string; compNodes: number; combatNodes: number; routing: boolean }[];
    };
    console.log(`pending ${s.pending} (ETA ~${s.etaMinutes} min); gate opens in ${Math.max(0, Math.round((s.nextAllowedAt - s.now) / 1000))} s`);
    console.table(s.queue);
    console.log("last finished:", JSON.stringify(s.lastFinished));
    if (s.failed.length) console.table(s.failed.map((f) => ({ path: f.path, error: f.last_error?.slice(0, 80) })));
    const withComps = s.normalMaps.filter((m) => m.compNodes > 0);
    console.log(`normal maps with comps: ${withComps.length}/${s.normalMaps.length}; nodes with comps: ${s.normalMaps.reduce((a, m) => a + m.compNodes, 0)}; maps with routing: ${s.normalMaps.filter((m) => m.routing).length}`);
    console.table(s.normalMaps);
    break;
  }
  case "queue": {
    const q = values.status ? `?status=${encodeURIComponent(values.status)}` : "";
    console.log(JSON.stringify(await call("GET", `/admin/kcnav/queue${q}`), null, 2));
    break;
  }
  default:
    console.error("usage: bun scripts/kcnav.ts enqueue|run|status|queue …");
    process.exit(2);
}
