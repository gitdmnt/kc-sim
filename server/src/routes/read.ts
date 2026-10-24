// Read API (docs/API.md §2). Row -> JSON mapping lives in ../assemble.ts (shared with the bundle export).
import { Hono } from "hono";
import type { Env } from "../env";
import { mapName, parseMapKey } from "../maps";
import { QUEST_SOURCE_KEYS } from "../quests";
import {
  COMP_COLS, COMP_SET_COLS, COMP_SHIP_COLS, EDGE_COLS, EQUIP_COLS, EQUIP_FIELDS, ESTIMATE_COLS, MAP_COLS, NODE_COLS, ROUTING_HEAD_COLS,
  ROUTING_INFERRED_COLS, ROUTING_RULE_COLS, SHIP_COLS, SHIP_FIELDS, bestEstimates, compSetSummaryJson, compSetsJson, edgeJson, equipJson,
  estimateJson, jsonArraySql, mapJson, nodeJson, parseJson, posteriorFields, routingJson, shipJson,
} from "../assemble";
import {
  MISMATCH_COLS, OBSERVED_CELL_COLS, OBSERVED_EDGE_GROUP, OBSERVED_EDGE_SQL, OBSERVED_LAYOUT_COLS, lbasDistanceByLetter, observedGraphJson,
} from "../observed/graph";
import { DEFAULT_MIN_OBSERVED, SOURCE_PREFS, type SourcePref, selectCompSets } from "../observed/select";

export const read = new Hono<{ Bindings: Env }>();

read.get("/health", (c) => c.json({ ok: true }));

read.get("/sources", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, name, url, licence, revision, fetched_at FROM sources ORDER BY key").all();
  return c.json({ sources: results.map((s) => ({ key: s.key, name: s.name, url: s.url, licence: s.licence, revision: s.revision, fetchedAt: s.fetched_at })) });
});

/** GET /maps `maps`. Rule counts: hand-authored rules, else the inferred document (provenance says which). */
export async function mapList(db: D1Database) {
  const { results } = await db.prepare(
    `SELECT m.id, m.world, m.no, m.name, m.is_event,
       (SELECT COUNT(*) FROM nodes n WHERE n.map_id = m.id) AS node_count,
       (SELECT COUNT(*) FROM edges e WHERE e.map_id = m.id) AS edge_count,
       COALESCE(r.rule_count, i.rule_count) AS rule_count, COALESCE(r.uncertain_count, i.uncertain_count) AS uncertain_count,
       CASE WHEN r.map_id IS NOT NULL THEN 'hand' WHEN i.map_id IS NOT NULL THEN 'inferred' END AS provenance,
       (SELECT COUNT(*) FROM enemy_comp_sets s WHERE s.map_id = m.id) AS comp_set_count
     FROM maps m LEFT JOIN routing_maps r ON r.map_id = m.id LEFT JOIN routing_inferred i ON i.map_id = m.id ORDER BY m.id`,
  ).all();
  return results.map((m) => ({
    id: m.id, key: mapName(m.id as number), world: m.world, no: m.no, name: m.name, isEvent: !!m.is_event,
    nodeCount: m.node_count, edgeCount: m.edge_count, compSetCount: m.comp_set_count,
    routing: m.provenance === null ? null : { ruleCount: m.rule_count, uncertainCount: m.uncertain_count, provenance: m.provenance },
  }));
}

read.get("/maps", async (c) => c.json({ maps: await mapList(c.env.DB) }));

async function routingOf(db: D1Database, mapId: number) {
  const [head, rules, inferred] = await Promise.all([
    db.prepare(`SELECT ${ROUTING_HEAD_COLS} FROM routing_maps WHERE map_id = ?1`).bind(mapId).first(),
    db.prepare(`SELECT ${ROUTING_RULE_COLS} FROM routing_rules WHERE map_id = ?1`).bind(mapId).all(),
    db.prepare(`SELECT ${ROUTING_INFERRED_COLS} FROM routing_inferred WHERE map_id = ?1`).bind(mapId).first(),
  ]);
  return routingJson(head, rules.results, inferred);
}

/** The body of GET /maps/{map}; null when the map does not exist. */
export async function mapDetail(db: D1Database, mapId: number) {
  const map = await db.prepare(`SELECT ${MAP_COLS} FROM maps WHERE id = ?1`).bind(mapId).first();
  if (!map) return null;
  const [nodes, edges, compSets, layouts, cells, edgeCounts, mismatches] = await Promise.all([
    db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE map_id = ?1 ORDER BY letter`).bind(mapId).all(),
    db.prepare(`SELECT ${EDGE_COLS} FROM edges WHERE map_id = ?1 ORDER BY edge_id`).bind(mapId).all(),
    db.prepare(`SELECT ${COMP_SET_COLS} FROM enemy_comp_sets s LEFT JOIN sources src ON src.id = s.source_id
      WHERE s.map_id = ?1 ORDER BY s.node_letter, s.difficulty, s.retrieved_at DESC`).bind(mapId).all(),
    db.prepare(`SELECT ${OBSERVED_LAYOUT_COLS} FROM poi_layouts WHERE map_id = ?1`).bind(mapId).all(),
    db.prepare(`SELECT ${OBSERVED_CELL_COLS} FROM poi_cells WHERE map_id = ?1`).bind(mapId).all(),
    db.prepare(`${OBSERVED_EDGE_SQL} WHERE map_id = ?1 ${OBSERVED_EDGE_GROUP}`).bind(mapId).all(),
    db.prepare(`SELECT ${MISMATCH_COLS} FROM poi_graph_mismatches WHERE map_id = ?1 ORDER BY kind, to_cell, from_cell`).bind(mapId).all(),
  ]);
  const routing = await routingOf(db, mapId);
  const observed = observedGraphJson({ layouts: layouts.results, cells: cells.results, edgeCounts: edgeCounts.results, mismatches: mismatches.results, edges: edges.results });
  const lbas = lbasDistanceByLetter(observed);
  return {
    map: mapJson(map),
    nodes: nodes.results.map((n) => nodeJson(n, lbas)),
    edges: edges.results.map(edgeJson),
    routing: routing?.doc ?? null,
    routingMeta: routing?.meta ?? null,
    enemyCompNodes: [...new Set(compSets.results.map((r) => r.node_letter as string))].sort(),
    compSets: compSets.results.map(compSetSummaryJson),
    observed,
  };
}

read.get("/maps/:map", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const detail = await mapDetail(c.env.DB, key.id);
  return detail ? c.json(detail) : c.json({ error: "map not found" }, 404);
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

export type CompOpts = { minObserved: number; prefer: SourcePref; since: string | null; difficulty: number | null };

/** The enemy-comps query parameters (shared by the per-node route and the map view); a string is the 400 message. */
export function compOpts(q: (name: string) => string | undefined): CompOpts | string {
  const difficulty = q("difficulty");
  const minObserved = Number(q("minObserved") ?? DEFAULT_MIN_OBSERVED);
  const prefer = (q("source") ?? "auto") as SourcePref;
  const since = q("since") ?? null;
  if (!Number.isInteger(minObserved) || minObserved < 0) return "minObserved must be a non-negative integer";
  if (!SOURCE_PREFS.includes(prefer)) return `source must be one of ${SOURCE_PREFS.join(", ")}`;
  if (since !== null && !/^\d{4}-\d{2}-\d{2}/.test(since)) return "since must be an ISO date";
  return { minObserved, prefer, since, difficulty: difficulty === undefined ? null : Number(difficulty) };
}

/** The comp sets of one node (`node`) or of every node of the map (null), picked per node by the source policy. */
export async function compsByNode(db: D1Database, mapId: number, node: string | null, o: CompOpts) {
  const sets = await db.prepare(
    `SELECT ${COMP_SET_COLS} FROM enemy_comp_sets s LEFT JOIN sources src ON src.id = s.source_id
     WHERE s.map_id = ?1 AND (?2 IS NULL OR s.node_letter = ?2) AND (?3 IS NULL OR s.difficulty = ?3)
     ORDER BY s.node_letter, s.difficulty, s.retrieved_at DESC`,
  ).bind(mapId, node, o.difficulty).all();
  const setIds = sets.results.map((s) => s.id as number);
  const inSets = `(${setIds.map(() => "?").join(", ") || "NULL"})`;
  const [comps, ships] = await Promise.all([
    db.prepare(`SELECT ${COMP_COLS} FROM enemy_comps WHERE set_id IN ${inSets}`).bind(...setIds).all(),
    db.prepare(`SELECT ${COMP_SHIP_COLS} FROM enemy_comp_ships WHERE comp_id IN (SELECT id FROM enemy_comps WHERE set_id IN ${inSets})`).bind(...setIds).all(),
  ]);
  const nodes = [...new Set(sets.results.map((s) => s.node_letter as string))];
  return Object.fromEntries(nodes.map((n) => [n, selectCompSets(compSetsJson(sets.results.filter((s) => s.node_letter === n), comps.results, ships.results), o)]));
}

read.get("/maps/:map/nodes/:node/enemy-comps", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const o = compOpts((name) => c.req.query(name));
  if (typeof o === "string") return c.json({ error: o }, 400);
  const node = c.req.param("node");
  const picked = (await compsByNode(c.env.DB, key.id, node, o))[node] ?? { selection: [], sets: [] };
  return c.json({ map: mapName(key.id), node, minObserved: o.minObserved, source: o.prefer, selection: picked.selection, sets: picked.sets });
});

// List endpoints get their JSON array from D1 as one TEXT value (jsonArraySql): the worker only concatenates it
// into the envelope, so CPU does not grow with parsing and re-serialising every row.
export const JSON_HEADERS = { "Content-Type": "application/json" };

/** `?abyssal=` of the list routes: 1/true, 0/anything else, or absent (null = no filter). */
const abyssalParam = (v: string | undefined) => (v === undefined ? null : v === "1" || v === "true" ? 1 : 0);

/** The JSON array text of GET /ships `ships` (all ships, or only abyssal = 1 / 0). */
export async function shipListJson(db: D1Database, abyssal: number | null) {
  const row = await db.prepare(jsonArraySql(SHIP_FIELDS, "FROM ships WHERE (?1 IS NULL OR is_abyssal = ?1) ORDER BY id")).bind(abyssal).first<{ body: string }>();
  return row!.body;
}

read.get("/ships", async (c) => c.body(`{"ships":${await shipListJson(c.env.DB, abyssalParam(c.req.query("abyssal")))}}`, 200, JSON_HEADERS));

/** GET /ships/{id} bodies (ship, its estimates and the best per stat) of `ids`, in id order; unknown ids are left out. */
export async function shipDetails(db: D1Database, ids: number[]) {
  const json = JSON.stringify(ids);
  const [ships, estimates] = await Promise.all([
    db.prepare(`SELECT ${SHIP_COLS} FROM ships WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id`).bind(json).all(),
    db.prepare(
      `SELECT ${ESTIMATE_COLS} FROM estimates e JOIN sources s ON s.id = e.source_id
       WHERE e.ship_id IN (SELECT value FROM json_each(?1)) ORDER BY e.stat, s.key`,
    ).bind(json).all(),
  ]);
  return ships.results.map((ship) => {
    const rows = estimates.results.filter((e) => e.ship_id === ship.id).map(estimateJson);
    return { ship: shipJson(ship), estimates: rows, best: bestEstimates(rows) };
  });
}

read.get("/ships/:id", async (c) => {
  const [detail] = await shipDetails(c.env.DB, [Number(c.req.param("id"))]);
  return detail ? c.json(detail) : c.json({ error: "ship not found" }, 404);
});

/** The JSON array text of GET /equipments `equipments`. */
export async function equipmentListJson(db: D1Database, abyssal: number | null) {
  const row = await db.prepare(jsonArraySql(EQUIP_FIELDS, "FROM equipments WHERE (?1 IS NULL OR is_abyssal = ?1) ORDER BY id")).bind(abyssal).first<{ body: string }>();
  return row!.body;
}

read.get("/equipments", async (c) => c.body(`{"equipments":${await equipmentListJson(c.env.DB, abyssalParam(c.req.query("abyssal")))}}`, 200, JSON_HEADERS));

read.get("/equipments/:id", async (c) => {
  const e = await c.env.DB.prepare(`SELECT ${EQUIP_COLS} FROM equipments WHERE id = ?1`).bind(Number(c.req.param("id"))).first();
  return e ? c.json({ equipment: equipJson(e) }) : c.json({ error: "equipment not found" }, 404);
});

// Quest master data (API.md "Quests"): the whole list in one response; the web caches it for a day.
const QUEST_FIELDS = [["id", "id"], ["code", "code"], ["name", "name"], ["detail", "detail"], ["memo", "memo"], ["pre", "pre", "json"], ["requirements", "requirements", "json"]] as const;
read.get("/quests", async (c) => {
  const [row, sources] = await Promise.all([
    c.env.DB.prepare(jsonArraySql(QUEST_FIELDS, "FROM quests ORDER BY id")).first<{ body: string }>(),
    c.env.DB.prepare("SELECT key, revision, fetched_at FROM sources WHERE key IN (SELECT value FROM json_each(?1)) ORDER BY key")
      .bind(JSON.stringify(QUEST_SOURCE_KEYS)).all(),
  ]);
  const src = sources.results.map((s) => ({ key: s.key, revision: s.revision, fetchedAt: s.fetched_at }));
  return c.body(`{"sources":${JSON.stringify(src)},"quests":${row!.body}}`, 200, JSON_HEADERS);
});

/** The body of GET /maps/{map}/bonuses; null when the map has no event bonus data. */
export async function eventBonuses(db: D1Database, mapId: number) {
  const row = await db.prepare(
    "SELECT b.date, b.note, b.bonuses, b.lbas_bonuses, b.debuffs, s.key AS source, s.revision FROM event_bonuses b LEFT JOIN sources s ON s.id = b.source_id WHERE b.map_id = ?1",
  ).bind(mapId).first();
  if (!row) return null;
  return {
    map: mapName(mapId), date: row.date, note: row.note, source: row.source === "manual-event-bonus" ? "manual" : "kancolle-replay", revision: row.revision,
    bonuses: parseJson(row.bonuses), lbasBonuses: parseJson(row.lbas_bonuses), debuffs: parseJson(row.debuffs),
  };
}

read.get("/maps/:map/bonuses", async (c) => {
  const key = parseMapKey(c.req.param("map"));
  if (!key) return c.json({ error: "bad map key" }, 400);
  const body = await eventBonuses(c.env.DB, key.id);
  return body ? c.json(body) : c.json({ error: "no event bonus data for this map" }, 404);
});

/** GET /fit-bonuses `fitBonuses`. */
export async function fitBonusList(db: D1Database) {
  const { results } = await db.prepare("SELECT id, equip_ids, equip_types, bonuses FROM fit_bonuses ORDER BY id").all();
  return results.map((f) => ({ id: f.id, ids: parseJson(f.equip_ids), types: parseJson(f.equip_types), bonuses: parseJson(f.bonuses) }));
}

read.get("/fit-bonuses", async (c) => c.json({ fitBonuses: await fitBonusList(c.env.DB) }));

// Server estimator posteriors (docs/API.md §2 "Estimates"): one row per ship × stat.
const ESTIMATED_STATS = ["ev", "acc", "luck"];
/** Densities are ~2 KB per row and D1 hands them to the worker as JSON it must parse: ≤ 50 ships (~300 KB) per request. */
const MAX_DENSITY_SHIPS = 50;

/** The body text of GET /estimates over the already validated filters (null = no filter). */
export async function estimatesJson(db: D1Database, f: { ids: number[] | null; stats?: string[] | null; minN?: number; density: boolean }) {
  const row = await db.prepare(jsonArraySql(
    posteriorFields(f.density),
    `FROM estimator_posteriors
     WHERE (?1 IS NULL OR ship_id IN (SELECT value FROM json_each(?1))) AND (?2 IS NULL OR stat IN (SELECT value FROM json_each(?2))) AND n >= ?3
     ORDER BY ship_id, CASE stat WHEN 'ev' THEN 0 WHEN 'acc' THEN 1 ELSE 2 END`,
    "(SELECT MAX(updated_at) FROM estimator_posteriors) AS at, ",
  )).bind(f.ids && JSON.stringify(f.ids), f.stats ? JSON.stringify(f.stats) : null, f.minN ?? 0).first<{ at: string | null; body: string }>();
  return `{"source":"estimator:server","updatedAt":${JSON.stringify(row!.at)},"estimates":${row!.body}}`;
}

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
  const density = densityParam === undefined ? densityAllowed : densityParam === "1";
  return c.body(await estimatesJson(c.env.DB, { ids, stats, minN, density }), 200, JSON_HEADERS);
});
