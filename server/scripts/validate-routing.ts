// Routing validation against data already stored in D1 (sends no KCNav request):
//  1. edge check: KCNav map routes (cached `map` jobs, live game data) vs the D1 edge list (KC3 edges.json;
//     ingest keeps KC3's edge on an id conflict, so mismatches only show up here);
//  2. branch check: rules vs per-edge run counts, see compareRouting. Counts come from KCNav nodesummary
//     (kcnav_edge_counts) or, with --source poi-observed, from our own captures (poi_edge_counts, current
//     layout, all difficulties; edge id = destination cell number).
// Fetch KCNav counts first with
//   bun run kcnav enqueue --maps 1-5,5-5 --kinds nodesummary [--start …] [--filters minSpeed=10]
// Usage: bun scripts/validate-routing.ts [--maps 1-5,5-5] [--source kcnav|poi-observed] [--query <exact query>] [--min 200] [--tol 0.05]
import { parseArgs } from "node:util";
import { query } from "./lib/d1";
import { ROUTING_HEAD_COLS, ROUTING_RULE_COLS, routingDocJson } from "../src/assemble";
import { parseMap } from "../src/kcnav/parse";
import { mapName, parseMapKey } from "../src/maps";
import { compareRouting } from "../src/routing/compare";
import { routingDoc } from "../src/routing/schema";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { maps: { type: "string" }, query: { type: "string" }, min: { type: "string" }, tol: { type: "string" }, source: { type: "string" } },
});
const observed = values.source === "poi-observed";
if (values.source && !observed && values.source !== "kcnav") throw new Error("--source must be kcnav or poi-observed");
const wanted = values.maps?.split(",").map((m) => parseMapKey(m.trim())?.id).filter((x): x is number => x !== undefined);
const inScope = (id: number) => !wanted || wanted.includes(id);

const edges = await query<{ map_id: number; edge_id: number; from_letter: string; to_letter: string }>("SELECT map_id, edge_id, from_letter, to_letter FROM edges");

// 1. Edge check.
const mapBodies = await query<{ map_id: number; body: string }>(
  "SELECT q.map_id, c.body FROM kcnav_queue q JOIN kcnav_cache c ON c.id = q.cache_id WHERE q.kind = 'map' AND q.status = 'done' ORDER BY q.map_id",
);
let edgeMismatches = 0;
const checked = mapBodies.filter((b) => inScope(b.map_id));
for (const { map_id, body } of checked) {
  const kcnav = parseMap(JSON.parse(body)).edges;
  const mine = new Map(edges.filter((e) => e.map_id === map_id).map((e) => [e.edge_id, `${e.from_letter}->${e.to_letter}`]));
  const issues = [
    ...kcnav.filter((e) => mine.get(e.edgeId) !== `${e.from}->${e.to}`)
      .map((e) => `edge ${e.edgeId}: kcnav ${e.from}->${e.to}, d1 ${mine.get(e.edgeId) ?? "missing"}`),
    ...[...mine.keys()].filter((id) => !kcnav.some((e) => e.edgeId === id)).map((id) => `edge ${id}: d1 ${mine.get(id)}, not in kcnav`),
  ];
  edgeMismatches += issues.length;
  if (issues.length) console.log(`EDGES ${mapName(map_id)}: ${issues.join("; ")}`);
}
console.log(`edge check: ${checked.length} KCNav map routes compared, ${edgeMismatches} mismatch(es)`);

// 2. Branch check.
const counts = observed
  ? await query<{ map_id: number; query: string; edge_id: number; runs: number; retrieved_at: string }>(
    // Current layout per map; runs per destination cell; edge 0 = sorties (as in nodesummary).
    `WITH cur AS (SELECT l.map_id, l.layout, l.sorties, l.last_seen FROM poi_layouts l
       WHERE l.current = 1)
     SELECT e.map_id, 'poi-observed' AS query, e.to_cell AS edge_id, SUM(e.count) AS runs, cur.last_seen AS retrieved_at
       FROM poi_edge_counts e JOIN cur ON cur.map_id = e.map_id AND cur.layout = e.layout GROUP BY e.map_id, e.to_cell
     UNION ALL SELECT map_id, 'poi-observed', 0, sorties, last_seen FROM cur ORDER BY 1`,
  )
  : await query<{ map_id: number; query: string; edge_id: number; runs: number; retrieved_at: string }>(
    "SELECT map_id, query, edge_id, runs, retrieved_at FROM kcnav_edge_counts ORDER BY map_id, retrieved_at DESC",
  );
const heads = await query<Record<string, unknown>>(`SELECT ${ROUTING_HEAD_COLS} FROM routing_maps`);
const rules = await query<Record<string, unknown>>(`SELECT ${ROUTING_RULE_COLS} FROM routing_rules`);
let problems = 0;
const mapIds = [...new Set(counts.map((c) => c.map_id))].filter(inScope);
if (!mapIds.length) console.log(`branch check: no ${observed ? "poi-observed route counts" : "nodesummary data"} in D1 for the requested maps${observed ? "" : " (enqueue kind nodesummary first)"}`);
for (const mapId of mapIds) {
  const head = heads.find((h) => h.map_id === mapId);
  if (!head) {
    console.log(`${mapName(mapId)}: no routing rules`);
    continue;
  }
  // Default: the newest unfiltered snapshot (query has only start/end); --query selects another.
  const mine = counts.filter((c) => c.map_id === mapId);
  const q = values.query ?? mine.find((c) => [...new URLSearchParams(c.query).keys()].every((k) => k === "start" || k === "end"))?.query ?? mine[0]!.query;
  const runs = mine.filter((c) => c.query === q);
  const doc = routingDoc.parse(routingDocJson(head, rules.filter((r) => r.map_id === mapId)));
  const byId = new Map(edges.filter((e) => e.map_id === mapId).map((e) => [e.edge_id, e]));
  const edgeRuns = runs.filter((r) => r.edge_id !== 0 && byId.has(r.edge_id))
    .map((r) => ({ from: byId.get(r.edge_id)!.from_letter, to: byId.get(r.edge_id)!.to_letter, runs: r.runs }));
  const report = compareRouting(doc, edgeRuns, { minSample: Number(values.min ?? 200), tolerance: Number(values.tol ?? 0.05) });
  console.log(`\n== ${mapName(mapId)} [${q}] sorties=${runs.find((r) => r.edge_id === 0)?.runs ?? "?"} retrieved=${runs[0]?.retrieved_at}`);
  for (const n of report) {
    const flags: string[] = [];
    if (n.uncovered.length) flags.push(`UNCOVERED ${n.uncovered.join(",")}`);
    if (n.unobserved.length) flags.push(`never-observed ${n.unobserved.join(",")}`);
    if (n.distribution) flags.push(`${n.distribution.ok ? "dist ok" : "DIST OFF"} (max |Δ|=${n.distribution.maxAbsDiff.toFixed(3)})`);
    if (n.uncovered.length || (n.distribution && !n.distribution.ok)) problems++;
    const obs = Object.entries(n.observed).map(([t, k]) => `${t}:${k}`).join(" ");
    console.log(`  ${n.node.padEnd(6)} n=${String(n.total).padEnd(8)} ${obs.padEnd(40)} ${flags.join("; ")}`);
  }
}
console.log(`\nbranch check: ${problems} problem node(s) (uncovered branch or fleet-independent distribution off by > tolerance)`);
