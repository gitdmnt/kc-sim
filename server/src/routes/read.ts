// Read API (docs/API.md §2). Row -> JSON mapping lives in ../assemble.ts (shared with the bundle export).
import { Hono } from "hono";
import type { Env } from "../env";
import { mapName, parseMapKey } from "../maps";
import {
  COMP_COLS, COMP_SET_COLS, COMP_SHIP_COLS, EDGE_COLS, EQUIP_COLS, EQUIP_FIELDS, ESTIMATE_COLS, MAP_COLS, NODE_COLS, ROUTING_HEAD_COLS,
  ROUTING_INFERRED_COLS, ROUTING_RULE_COLS, SHIP_COLS, SHIP_FIELDS, bestEstimates, compSetSummaryJson, compSetsJson, edgeJson, equipJson,
  estimateJson, jsonArraySql, mapJson, nodeJson, parseJson, posteriorFields, routingJson, shipJson,
} from "../assemble";
import {
  MISMATCH_COLS, OBSERVED_CELL_COLS, OBSERVED_EDGE_GROUP, OBSERVED_EDGE_SQL, OBSERVED_LAYOUT_COLS, observedGraphJson,
} from "../observed/graph";
import { DEFAULT_MIN_OBSERVED, SOURCE_PREFS, type SourcePref, selectCompSets } from "../observed/select";

export const read = new Hono<{ Bindings: Env }>();

read.get("/health", (c) => c.json({ ok: true }));

read.get("/sources", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, name, url, licence, revision, fetched_at FROM sources ORDER BY key").all();
  return c.json({ sources: results.map((s) => ({ key: s.key, name: s.name, url: s.url, licence: s.licence, revision: s.revision, fetchedAt: s.fetched_at })) });
});

read.get("/maps", async (c) => {
  // Rule counts: hand-authored rules, else the inferred document (provenance says which).
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.world, m.no, m.name, m.is_event,
       (SELECT COUNT(*) FROM nodes n WHERE n.map_id = m.id) AS node_count,
       (SELECT COUNT(*) FROM edges e WHERE e.map_id = m.id) AS edge_count,
       COALESCE(r.rule_count, i.rule_count) AS rule_count, COALESCE(r.uncertain_count, i.uncertain_count) AS uncertain_count,
       CASE WHEN r.map_id IS NOT NULL THEN 'hand' WHEN i.map_id IS NOT NULL THEN 'inferred' END AS provenance,
       (SELECT COUNT(*) FROM enemy_comp_sets s WHERE s.map_id = m.id) AS comp_set_count
     FROM maps m LEFT JOIN routing_maps r ON r.map_id = m.id LEFT JOIN routing_inferred i ON i.map_id = m.id ORDER BY m.id`,
  ).all();
  return c.json({
    maps: results.map((m) => ({
      id: m.id, key: mapName(m.id as number), world: m.world, no: m.no, name: m.name, isEvent: !!m.is_event,
      nodeCount: m.node_count, edgeCount: m.edge_count, compSetCount: m.comp_set_count,
      routing: m.provenance === null ? null : { ruleCount: m.rule_count, uncertainCount: m.uncertain_count, provenance: m.provenance },
    })),
  });
});

async function routingOf(db: D1Database, mapId: number) {
  const [head, rules, inferred] = await Promise.all([
    db.prepare(`SELECT ${ROUTING_HEAD_COLS} FROM routing_maps WHERE map_id = ?1`).bind(mapId).first(),
    db.prepare(`SELECT ${ROUTING_RULE_COLS} FROM routing_rules WHERE map_id = ?1`).bind(mapId).all(),
    db.prepare(`SELECT ${ROUTING_INFERRED_COLS} FROM routing_inferred WHERE map_id = ?1`).bind(mapId).first(),
  ]);
  return routingJson(head, rules.results, inferred);
}

read.get("/maps/:map", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const db = c.env.DB;
  const map = await db.prepare(`SELECT ${MAP_COLS} FROM maps WHERE id = ?1`).bind(key.id).first();
  if (!map) return c.json({ error: "map not found" }, 404);
  const [nodes, edges, compSets, layouts, cells, edgeCounts, mismatches] = await Promise.all([
    db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE map_id = ?1 ORDER BY letter`).bind(key.id).all(),
    db.prepare(`SELECT ${EDGE_COLS} FROM edges WHERE map_id = ?1 ORDER BY edge_id`).bind(key.id).all(),
    db.prepare(`SELECT ${COMP_SET_COLS} FROM enemy_comp_sets s LEFT JOIN sources src ON src.id = s.source_id
      WHERE s.map_id = ?1 ORDER BY s.node_letter, s.difficulty, s.retrieved_at DESC`).bind(key.id).all(),
    db.prepare(`SELECT ${OBSERVED_LAYOUT_COLS} FROM poi_layouts WHERE map_id = ?1`).bind(key.id).all(),
    db.prepare(`SELECT ${OBSERVED_CELL_COLS} FROM poi_cells WHERE map_id = ?1`).bind(key.id).all(),
    db.prepare(`${OBSERVED_EDGE_SQL} WHERE map_id = ?1 ${OBSERVED_EDGE_GROUP}`).bind(key.id).all(),
    db.prepare(`SELECT ${MISMATCH_COLS} FROM poi_graph_mismatches WHERE map_id = ?1 ORDER BY kind, to_cell, from_cell`).bind(key.id).all(),
  ]);
  const routing = await routingOf(db, key.id);
  return c.json({
    map: mapJson(map),
    nodes: nodes.results.map(nodeJson),
    edges: edges.results.map(edgeJson),
    routing: routing?.doc ?? null,
    routingMeta: routing?.meta ?? null,
    enemyCompNodes: [...new Set(compSets.results.map((r) => r.node_letter as string))].sort(),
    compSets: compSets.results.map(compSetSummaryJson),
    observed: observedGraphJson({ layouts: layouts.results, cells: cells.results, edgeCounts: edgeCounts.results, mismatches: mismatches.results, edges: edges.results }),
  });
});

// The body stays the bare ROUTING_DSL document (the evaluator rejects unknown keys); provenance goes in headers.
read.get("/maps/:map/routing", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const routing = await routingOf(c.env.DB, key.id);
  if (!routing) return c.json({ error: "no routing rules for this map" }, 404);
  c.header("X-Routing-Provenance", routing.meta.provenance);
  if (routing.meta.generatedAt) c.header("X-Routing-Generated-At", routing.meta.generatedAt);
  if (routing.meta.sortieCount !== null) c.header("X-Routing-Sortie-Count", String(routing.meta.sortieCount));
  return c.json(routing.doc);
});

read.get("/maps/:map/nodes/:node/enemy-comps", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const node = c.req.param("node");
  const difficulty = c.req.query("difficulty");
  const minObserved = Number(c.req.query("minObserved") ?? DEFAULT_MIN_OBSERVED);
  const prefer = (c.req.query("source") ?? "auto") as SourcePref;
  const since = c.req.query("since") ?? null;
  if (!Number.isInteger(minObserved) || minObserved < 0) return c.json({ error: "minObserved must be a non-negative integer" }, 400);
  if (!SOURCE_PREFS.includes(prefer)) return c.json({ error: `source must be one of ${SOURCE_PREFS.join(", ")}` }, 400);
  if (since !== null && !/^\d{4}-\d{2}-\d{2}/.test(since)) return c.json({ error: "since must be an ISO date" }, 400);
  const db = c.env.DB;
  const sets = await db.prepare(
    `SELECT ${COMP_SET_COLS} FROM enemy_comp_sets s LEFT JOIN sources src ON src.id = s.source_id
     WHERE s.map_id = ?1 AND s.node_letter = ?2 AND (?3 IS NULL OR s.difficulty = ?3)
     ORDER BY s.difficulty, s.retrieved_at DESC`,
  ).bind(key.id, node, difficulty === undefined ? null : Number(difficulty)).all();
  const setIds = sets.results.map((s) => s.id as number);
  const inSets = `(${setIds.map(() => "?").join(", ") || "NULL"})`;
  const [comps, ships] = await Promise.all([
    db.prepare(`SELECT ${COMP_COLS} FROM enemy_comps WHERE set_id IN ${inSets}`).bind(...setIds).all(),
    db.prepare(`SELECT ${COMP_SHIP_COLS} FROM enemy_comp_ships WHERE comp_id IN (SELECT id FROM enemy_comps WHERE set_id IN ${inSets})`).bind(...setIds).all(),
  ]);
  const picked = selectCompSets(compSetsJson(sets.results, comps.results, ships.results), { minObserved, prefer, since });
  return c.json({ map: mapName(key.id), node, minObserved, source: prefer, selection: picked.selection, sets: picked.sets });
});

// List endpoints get their JSON array from D1 as one TEXT value (jsonArraySql): the worker only concatenates it
// into the envelope, so CPU does not grow with parsing and re-serialising every row.
const JSON_HEADERS = { "Content-Type": "application/json" };

read.get("/ships", async (c) => {
  const abyssal = c.req.query("abyssal");
  const row = await c.env.DB.prepare(jsonArraySql(SHIP_FIELDS, "FROM ships WHERE (?1 IS NULL OR is_abyssal = ?1) ORDER BY id"))
    .bind(abyssal === undefined ? null : abyssal === "1" || abyssal === "true" ? 1 : 0).first<{ body: string }>();
  return c.body(`{"ships":${row!.body}}`, 200, JSON_HEADERS);
});

read.get("/ships/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const ship = await db.prepare(`SELECT ${SHIP_COLS} FROM ships WHERE id = ?1`).bind(id).first();
  if (!ship) return c.json({ error: "ship not found" }, 404);
  const { results } = await db.prepare(
    `SELECT ${ESTIMATE_COLS} FROM estimates e JOIN sources s ON s.id = e.source_id WHERE e.ship_id = ?1 ORDER BY e.stat, s.key`,
  ).bind(id).all();
  const estimates = results.map(estimateJson);
  return c.json({ ship: shipJson(ship), estimates, best: bestEstimates(estimates) });
});

read.get("/equipments", async (c) => {
  const abyssal = c.req.query("abyssal");
  const row = await c.env.DB.prepare(jsonArraySql(EQUIP_FIELDS, "FROM equipments WHERE (?1 IS NULL OR is_abyssal = ?1) ORDER BY id"))
    .bind(abyssal === undefined ? null : abyssal === "1" || abyssal === "true" ? 1 : 0).first<{ body: string }>();
  return c.body(`{"equipments":${row!.body}}`, 200, JSON_HEADERS);
});

read.get("/equipments/:id", async (c) => {
  const e = await c.env.DB.prepare(`SELECT ${EQUIP_COLS} FROM equipments WHERE id = ?1`).bind(Number(c.req.param("id"))).first();
  return e ? c.json({ equipment: equipJson(e) }) : c.json({ error: "equipment not found" }, 404);
});

read.get("/maps/:map/bonuses", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const row = await c.env.DB.prepare(
    "SELECT b.date, b.note, b.bonuses, b.lbas_bonuses, b.debuffs, s.key AS source, s.revision FROM event_bonuses b LEFT JOIN sources s ON s.id = b.source_id WHERE b.map_id = ?1",
  ).bind(key.id).first();
  if (!row) return c.json({ error: "no event bonus data for this map" }, 404);
  return c.json({
    map: mapName(key.id), date: row.date, note: row.note, source: row.source === "manual-event-bonus" ? "manual" : "kancolle-replay", revision: row.revision,
    bonuses: parseJson(row.bonuses), lbasBonuses: parseJson(row.lbas_bonuses), debuffs: parseJson(row.debuffs),
  });
});

read.get("/fit-bonuses", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, equip_ids, equip_types, bonuses FROM fit_bonuses ORDER BY id").all();
  return c.json({
    fitBonuses: results.map((f) => ({ id: f.id, ids: parseJson(f.equip_ids), types: parseJson(f.equip_types), bonuses: parseJson(f.bonuses) })),
  });
});

// Server estimator posteriors (docs/API.md §2 "Estimates"): one row per ship × stat.
const ESTIMATED_STATS = ["ev", "acc", "luck"];
/** Densities are ~2 KB per row and D1 hands them to the worker as JSON it must parse: ≤ 50 ships (~300 KB) per request. */
const MAX_DENSITY_SHIPS = 50;
read.get("/estimates", async (c) => {
  const ids = c.req.query("shipId")?.split(",").map((s) => Number(s.trim())) ?? null;
  const stats = c.req.query("stat")?.split(",").map((s) => s.trim()) ?? null;
  const minN = Number(c.req.query("minN") ?? 0);
  const densityParam = c.req.query("density");
  if (ids && (ids.length > 200 || ids.some((n) => !Number.isInteger(n) || n <= 0))) return c.json({ error: "shipId must be up to 200 positive integers" }, 400);
  if (stats?.some((s) => !ESTIMATED_STATS.includes(s))) return c.json({ error: `stat must be one of ${ESTIMATED_STATS.join(", ")}` }, 400);
  if (!Number.isInteger(minN) || minN < 0) return c.json({ error: "minN must be a non-negative integer" }, 400);
  if (densityParam !== undefined && densityParam !== "0" && densityParam !== "1") return c.json({ error: "density must be 0 or 1" }, 400);
  const densityAllowed = ids !== null && ids.length <= MAX_DENSITY_SHIPS;
  if (densityParam === "1" && !densityAllowed) return c.json({ error: `density=1 requires shipId with at most ${MAX_DENSITY_SHIPS} ids` }, 400);
  const withDensity = densityParam === undefined ? densityAllowed : densityParam === "1";
  const row = await c.env.DB.prepare(jsonArraySql(
    posteriorFields(withDensity),
    `FROM estimator_posteriors
     WHERE (?1 IS NULL OR ship_id IN (SELECT value FROM json_each(?1))) AND (?2 IS NULL OR stat IN (SELECT value FROM json_each(?2))) AND n >= ?3
     ORDER BY ship_id, CASE stat WHEN 'ev' THEN 0 WHEN 'acc' THEN 1 ELSE 2 END`,
    "(SELECT MAX(updated_at) FROM estimator_posteriors) AS at, ",
  )).bind(ids && JSON.stringify(ids), stats && JSON.stringify(stats), minN).first<{ at: string | null; body: string }>();
  return c.body(`{"source":"estimator:server","updatedAt":${JSON.stringify(row!.at)},"estimates":${row!.body}}`, 200, JSON_HEADERS);
});
