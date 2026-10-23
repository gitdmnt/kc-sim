// Routing rule inference from our own poi sortie observations (docs/ROUTING_INFERENCE.md). Offline:
// reads D1 (local by default, D1_REMOTE=1 for production; SELECT only), never sends a KCNav request,
// and writes candidate documents to .tmp/inferred/{map}.json for review. Nothing is ingested.
//
// Usage: bun scripts/infer-routing.ts [--maps 1-5,62-1] [--min-sorties 30] [--out .tmp/inferred]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { query } from "./lib/d1";
import { inferRouting, nextDistribution, observedSortie, observedSortieRow, parseStart2Ships, shipFamilies, type SortieSample } from "./lib/routing-infer";
import { ROUTING_HEAD_COLS, ROUTING_RULE_COLS, routingDocJson } from "../src/assemble";
import { mapName, parseMapKey } from "../src/maps";
import { routingDoc, type RoutingDoc } from "../src/routing/schema";
import type { Edge } from "../src/routing/validate";
import * as z from "zod";

const ROOT = new URL("../", import.meta.url).pathname;
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { maps: { type: "string" }, "min-sorties": { type: "string", default: "30" }, out: { type: "string", default: `${ROOT}.tmp/inferred` } },
});
const minSorties = Number(values["min-sorties"]);
const wanted = values.maps?.split(",").map((m) => parseMapKey(m.trim())?.id).filter((x): x is number => x !== undefined);

const rows = await query<{ map_id: number; difficulty: number | null; fleet: string | null; sortie: string | null }>(
  `SELECT map_id, difficulty, fleet, sortie FROM observations WHERE kind = 'sortie' AND quarantine IS NULL AND sortie IS NOT NULL` +
    (wanted ? ` AND map_id IN (${wanted.join(",")})` : "") + " ORDER BY map_id, id",
);
const mapIds = [...new Set(rows.map((r) => r.map_id))];
console.log(`${rows.length} usable sortie observations on ${mapIds.length} maps`);
if (!rows.length) process.exit(0);

const parsed = rows.map((r) => ({
  map: r.map_id,
  row: observedSortieRow.parse({ difficulty: r.difficulty, fleet: r.fleet && JSON.parse(r.fleet), sortie: r.sortie && JSON.parse(r.sortie) }),
}));
const shipIds = new Set<number>();
const equipIds = new Set<number>();
for (const { row } of parsed) {
  for (const s of [...(row.fleet?.ships ?? []), ...(row.fleet?.escort ?? [])]) {
    shipIds.add(s.masterId);
    for (const e of [...s.equips, s.exSlot ?? null]) if (e) equipIds.add(e.masterId);
  }
}
const ships = new Map((await query<{ id: number; stype: number; speed: number | null }>(
  `SELECT id, stype, speed FROM ships WHERE id IN (${[...shipIds].join(",") || "0"})`)).map((s) => [s.id, s]));
const equipType = z.array(z.number());
const equips = new Map((await query<{ id: number; type: string; los: number | null }>(
  `SELECT id, type, los FROM equipments WHERE id IN (${[...equipIds].join(",") || "0"})`))
  .map((e) => [e.id, { cat: equipType.parse(JSON.parse(e.type))[2] ?? 0, los: e.los ?? 0 }]));
const master = { ship: (id: number) => ships.get(id), equip: (id: number) => equips.get(id) };
const edgeRows = await query<{ map_id: number; edge_id: number; from_letter: string; to_letter: string }>(
  `SELECT map_id, edge_id, from_letter, to_letter FROM edges WHERE map_id IN (${mapIds.join(",")})`);
const heads = await query<Record<string, unknown>>(`SELECT ${ROUTING_HEAD_COLS} FROM routing_maps WHERE map_id IN (${mapIds.join(",")})`);
const rules = await query<Record<string, unknown>>(`SELECT ${ROUTING_RULE_COLS} FROM routing_rules WHERE map_id IN (${mapIds.join(",")})`);

// Ship families for countIds features: the npm api_start2 snapshot when installed (stale for new ships).
const start2 = `${ROOT}../web/node_modules/@kancolle/data/api/api_start2.json`;
const families = existsSync(start2) ? shipFamilies(parseStart2Ships(await Bun.file(start2).json())) : [];

mkdirSync(values.out, { recursive: true });
for (const mapId of mapIds) {
  const map = mapName(mapId);
  const mine = edgeRows.filter((e) => e.map_id === mapId);
  const edges: Edge[] = mine.map((e) => ({ from: e.from_letter, to: e.to_letter }));
  const byId = new Map(mine.map((e) => [e.edge_id, { from: e.from_letter, to: e.to_letter }]));
  const samples: SortieSample[] = [];
  const reasons = new Map<string, number>();
  for (const { row } of parsed.filter((p) => p.map === mapId)) {
    const s = observedSortie(row, byId, master);
    if ("reason" in s) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    else samples.push(s);
  }
  const skipped = [...reasons].map(([r, n]) => `${n}× ${r}`).join(", ");
  if (samples.length < minSorties) {
    console.log(`${map}: ${samples.length} usable sorties (< ${minSorties}), skipped${skipped ? ` (${skipped})` : ""}`);
    continue;
  }
  const res = inferRouting(map, edges, samples, { families, sourceNote: `inferred from ${samples.length} poi sortie observations (scripts/infer-routing.ts)` });
  if (res.errors.length) throw new Error(`${map}: inferred document invalid: ${res.errors.join("; ")}`);
  writeFileSync(`${values.out}/${map}.json`, `${JSON.stringify(res.doc, null, 1)}\n`);
  const learned = res.report.filter((r) => r.kind === "learned");
  console.log(`${map}: ${samples.length} sorties${res.dropped ? `, ${res.dropped} off the edge list` : ""}${skipped ? `, skipped ${skipped}` : ""} → ${values.out}/${map}.json`);
  for (const r of learned) {
    console.log(`  ${r.node.padEnd(6)} n=${String(r.samples).padStart(5)} leaves=${r.leaves} uncertain=${r.uncertainLeaves} train=${(100 * r.trainAccuracy).toFixed(1)}% ${JSON.stringify(r.outcomes)}`);
  }

  // Against the hand-authored rules: observed moves they cannot produce, and mean per-decision agreement.
  const head = heads.find((h) => h.map_id === mapId);
  if (!head) continue;
  const hand: RoutingDoc = routingDoc.parse(routingDocJson(head, rules.filter((r) => r.map_id === mapId)));
  let decisions = 0;
  let impossible = 0;
  let agree = 0;
  for (const s of samples) {
    const visited = new Set<string>();
    for (let j = 0; j + 1 < s.path.length; j++) {
      const node = s.path[j]!;
      visited.add(node);
      if (s.selects?.[node] || edges.filter((e) => e.from === node).length < 2) continue;
      const h = nextDistribution(hand, node, s, visited);
      const i = nextDistribution(res.doc, node, s, visited);
      decisions++;
      if (!h[s.path[j + 1]!]) impossible++;
      agree += 1 - [...new Set([...Object.keys(h), ...Object.keys(i)])].reduce((d, k) => d + Math.abs((h[k] ?? 0) - (i[k] ?? 0)), 0) / 2;
    }
  }
  if (decisions) {
    console.log(`  vs hand-authored rules: ${decisions} branching decisions, ${impossible} observed moves the hand rules cannot produce, ` +
      `mean agreement ${(100 * agree / decisions).toFixed(1)}%`);
  }
}
