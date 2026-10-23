// Static per-map bundles for offline use by the plugin (fallback when the API is not running):
//   dist/maps/{W-M}.json   map + nodes + edges + routing + observed graph + enemy comp sets per (node, difficulty)
//                          chosen by the API's source policy (poi-observed when n ≥ --min-observed, else KCNav)
//                          + every abyssal ship in those comps (with estimates and `best`) + their equipment
//   dist/maps/index.json   list of bundles with coverage counts
// Shapes are those of the read API (shared mappers in src/assemble.ts). Reads the local D1 directly.
// Usage: bun scripts/export-bundle.ts [--maps 1-5,5-5] [--min-observed 30]
//        (default: normal maps + any map with routing or comps)
import { mkdirSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { query } from "./lib/d1";
import {
  COMP_COLS, COMP_SET_COLS, COMP_SHIP_COLS, EDGE_COLS, EQUIP_COLS, ESTIMATE_COLS, MAP_COLS, NODE_COLS, ROUTING_HEAD_COLS,
  ROUTING_RULE_COLS, SHIP_COLS, bestEstimates, compSetsJson, edgeJson, equipJson, estimateJson, mapJson, nodeJson,
  parseJson, routingDocJson, shipJson,
} from "../src/assemble";
import { mapName, parseMapKey } from "../src/maps";
import { OBSERVED_SOURCE } from "../src/observed/aggregate";
import {
  MISMATCH_COLS, OBSERVED_CELL_COLS, OBSERVED_EDGE_GROUP, OBSERVED_EDGE_SQL, OBSERVED_LAYOUT_COLS, lbasDistanceByLetter, observedGraphJson,
} from "../src/observed/graph";
import { DEFAULT_MIN_OBSERVED, selectCompSets } from "../src/observed/select";

type Row = Record<string, unknown>;
const OUT = new URL("../dist/maps/", import.meta.url).pathname;

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { maps: { type: "string" }, "min-observed": { type: "string" } } });
const wanted = values.maps?.split(",").map((m) => parseMapKey(m.trim())?.id).filter((x): x is number => x !== undefined);
const minObserved = Number(values["min-observed"] ?? DEFAULT_MIN_OBSERVED);

const maps = await query<Row>(
  `SELECT ${MAP_COLS} FROM maps m WHERE m.world BETWEEN 1 AND 7
     OR m.id IN (SELECT map_id FROM routing_maps) OR m.id IN (SELECT map_id FROM enemy_comp_sets) ORDER BY m.id`,
);
const selected = maps.filter((m) => !wanted || wanted.includes(m.id as number));
// Sequential on purpose: concurrent `wrangler d1 execute --local` processes fail against the shared
// local database ("Failed to get session commit token").
const nodes = await query<Row>(`SELECT ${NODE_COLS} FROM nodes`);
const edges = await query<Row>(`SELECT ${EDGE_COLS} FROM edges`);
const heads = await query<Row>(`SELECT ${ROUTING_HEAD_COLS} FROM routing_maps`);
const rules = await query<Row>(`SELECT ${ROUTING_RULE_COLS} FROM routing_rules`);
const allSets = await query<Row>(`SELECT ${COMP_SET_COLS} FROM enemy_comp_sets s LEFT JOIN sources src ON src.id = s.source_id ORDER BY s.retrieved_at DESC, s.id DESC`);
const sources = await query<Row>("SELECT key, name, url, licence, revision, fetched_at FROM sources ORDER BY key");
// The deploy exports before it applies pending migrations: until 0013 is in, poi_cells has no lbas_distance.
const cells = await query<Row>(`SELECT ${OBSERVED_CELL_COLS} FROM poi_cells`).catch((e: unknown) => {
  if (!String(e).includes("no such column: lbas_distance")) throw e;
  return query<Row>(`SELECT ${OBSERVED_CELL_COLS.replace("lbas_distance", "NULL AS lbas_distance")} FROM poi_cells`);
});
const observedRows = {
  layouts: await query<Row>(`SELECT ${OBSERVED_LAYOUT_COLS} FROM poi_layouts`),
  cells,
  edgeCounts: await query<Row>(`${OBSERVED_EDGE_SQL} ${OBSERVED_EDGE_GROUP}`),
  mismatches: await query<Row>(`SELECT ${MISMATCH_COLS} FROM poi_graph_mismatches ORDER BY kind, to_cell, from_cell`),
};
// Candidates for the source policy: the newest set per (map, node, difficulty, source); for poi-observed
// only the current-layout set (open period).
const latest = new Map<string, Row>();
for (const s of allSets) {
  if (s.source === OBSERVED_SOURCE && s.period_end) continue;
  const k = `${s.map_id}|${s.node_letter}|${s.difficulty}|${s.source}`;
  if (!latest.has(k)) latest.set(k, s);
}
const sets = [...latest.values()];
const setIds = sets.map((s) => s.id as number);
const inList = (ids: unknown[]) => (ids.length ? ids.join(", ") : "NULL");
const comps = await query<Row>(`SELECT ${COMP_COLS} FROM enemy_comps WHERE set_id IN (${inList(setIds)})`);
const compShips = await query<Row>(`SELECT ${COMP_SHIP_COLS} FROM enemy_comp_ships WHERE comp_id IN (${inList(comps.map((c) => c.id))})`);
const shipIds = [...new Set(compShips.map((s) => s.ship_id as number))];
const ships = await query<Row>(`SELECT ${SHIP_COLS} FROM ships WHERE id IN (${inList(shipIds)})`);
const estimates = await query<Row>(
  `SELECT ${ESTIMATE_COLS} FROM estimates e JOIN sources s ON s.id = e.source_id WHERE e.ship_id IN (${inList(shipIds)}) ORDER BY e.stat, s.key`,
);
const equipIds = new Set<number>();
for (const s of compShips) for (const id of parseJson(s.equips) as number[]) if (id > 0) equipIds.add(id);
for (const s of ships) for (const id of (parseJson(s.equips) as number[] | null) ?? []) if (id > 0) equipIds.add(id);
const equipments = await query<Row>(`SELECT ${EQUIP_COLS} FROM equipments WHERE id IN (${inList([...equipIds])})`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const generatedAt = new Date().toISOString();
const sourceList = sources.map((s) => ({ key: s.key, name: s.name, url: s.url, licence: s.licence, revision: s.revision, fetchedAt: s.fetched_at }));
const index: unknown[] = [];
for (const m of selected) {
  const id = m.id as number;
  const key = mapName(id);
  const mySets = sets.filter((s) => s.map_id === id);
  const myComps = comps.filter((c) => mySets.some((s) => s.id === c.set_id));
  const myShips = compShips.filter((sh) => myComps.some((c) => c.id === sh.comp_id));
  const enemyComps: Record<string, unknown> = {};
  const enemyCompSelection: Record<string, unknown> = {};
  const chosenShips: { shipId: unknown; equips: unknown }[] = [];
  for (const node of [...new Set(mySets.map((s) => s.node_letter as string))].sort()) {
    const picked = selectCompSets(
      compSetsJson(mySets.filter((s) => s.node_letter === node).sort((a, b) => (a.difficulty as number) - (b.difficulty as number)), myComps, myShips),
      { minObserved, prefer: "auto" },
    );
    enemyComps[node] = picked.sets;
    enemyCompSelection[node] = picked.selection;
    for (const s of picked.sets) for (const c of s.comps) chosenShips.push(...c.main, ...c.escort);
  }
  const myShipIds = new Set(chosenShips.map((s) => s.shipId));
  const shipMap: Record<string, unknown> = {};
  const myEquipIds = new Set<number>();
  for (const s of ships.filter((x) => myShipIds.has(x.id))) {
    const est = estimates.filter((e) => e.ship_id === s.id).map(estimateJson);
    shipMap[String(s.id)] = { ...shipJson(s), estimates: est, best: bestEstimates(est) };
    for (const e of (parseJson(s.equips) as number[] | null) ?? []) if (e > 0) myEquipIds.add(e);
  }
  for (const sh of chosenShips) for (const e of sh.equips as number[]) if (e > 0) myEquipIds.add(e);
  const head = heads.find((h) => h.map_id === id);
  const observed = observedGraphJson({
    layouts: observedRows.layouts.filter((r) => r.map_id === id), cells: observedRows.cells.filter((r) => r.map_id === id),
    edgeCounts: observedRows.edgeCounts.filter((r) => r.map_id === id), mismatches: observedRows.mismatches.filter((r) => r.map_id === id),
    edges: edges.filter((e) => e.map_id === id),
  });
  const lbas = lbasDistanceByLetter(observed);
  const bundle = {
    format: "kc-sim-map-bundle", version: 1, generatedAt,
    map: mapJson(m),
    nodes: nodes.filter((n) => n.map_id === id).sort((a, b) => String(a.letter).localeCompare(String(b.letter))).map((n) => nodeJson(n, lbas)),
    edges: edges.filter((e) => e.map_id === id).sort((a, b) => (a.edge_id as number) - (b.edge_id as number)).map(edgeJson),
    routing: head ? routingDocJson(head, rules.filter((r) => r.map_id === id)) : null,
    observed,
    enemyComps,
    enemyCompSelection,
    ships: shipMap,
    equipments: Object.fromEntries(equipments.filter((e) => myEquipIds.has(e.id as number)).map((e) => [String(e.id), equipJson(e)])),
    sources: sourceList,
  };
  await Bun.write(`${OUT}${key}.json`, JSON.stringify(bundle));
  index.push({ key, file: `${key}.json`, routing: !!head, compNodes: Object.keys(enemyComps).length, ships: myShipIds.size });
}
await Bun.write(`${OUT}index.json`, JSON.stringify({ format: "kc-sim-map-bundle-index", version: 1, generatedAt, maps: index }, null, 1));
console.log(`wrote ${index.length} bundles to ${OUT} (${index.filter((i) => (i as { compNodes: number }).compNodes > 0).length} with enemy comps, ${index.filter((i) => (i as { routing: boolean }).routing).length} with routing)`);
