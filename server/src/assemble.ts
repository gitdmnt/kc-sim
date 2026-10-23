// Row -> API JSON mapping shared by the read API (src/routes/read.ts) and the static bundle export
// (scripts/export-bundle.ts), so both emit identical shapes (docs/API.md §2).
import { mapName } from "./maps";

type Row = Record<string, unknown>;

export const parseJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v ?? null);

// Declarative row -> JSON: one field table per resource drives both the JS mapper (single rows, bundle export)
// and a SQL json_object(...) (list endpoints build the body in D1, so the worker never parses rows).
/** plain: as is; bool: 0/1 -> false/true; json: TEXT holding JSON, passed through verbatim (NULL -> null);
 *  real: REAL printed as the shortest of 15/16/17 significant digits that round-trips (json_object alone keeps 15). */
type Kind = "plain" | "bool" | "json" | "real";
/** [JSON key, column (SQL expression for SQL-only tables), kind (default plain)] */
export type Field = readonly [key: string, col: string, kind?: Kind];

const mapperOf = (fields: readonly Field[]) => (r: Row): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  for (const [k, col, kind] of fields) o[k] = kind === "bool" ? !!r[col] : kind === "json" ? parseJson(r[col]) : r[col];
  return o;
};
const realSql = (c: string) =>
  `json(CASE WHEN ${c} IS NULL THEN NULL WHEN CAST(printf('%.15g', ${c}) AS REAL) = ${c} THEN printf('%.15g', ${c})` +
  ` WHEN CAST(printf('%.16g', ${c}) AS REAL) = ${c} THEN printf('%.16g', ${c}) ELSE printf('%!.17g', ${c}) END)`;
/** One row, column `body`: JSON array text of `fields` objects over `tail` (FROM … WHERE … ORDER BY …), in order
 *  ('[]' when empty). `extra` prepends further select columns ("expr AS name, "). */
export function jsonArraySql(fields: readonly Field[], tail: string, extra = "") {
  const values = fields.map(([k, col, kind]) => `'${k}', ${
    kind === "bool" ? `json(CASE WHEN ${col} THEN 'true' ELSE 'false' END)` : kind === "json" ? `json(${col})` : kind === "real" ? realSql(col) : col
  }`);
  return `SELECT ${extra}json_group_array(json(x)) AS body FROM (SELECT json_object(${values.join(", ")}) AS x ${tail})`;
}

export const MAP_COLS = "id, world, no, name, opetext, is_event, max_hp, required_defeat_count";
export const mapJson = (m: Row) => ({
  id: m.id, key: mapName(m.id as number), world: m.world, no: m.no, name: m.name, opetext: m.opetext,
  isEvent: !!m.is_event, maxHp: m.max_hp, requiredDefeatCount: m.required_defeat_count,
});

export const NODE_COLS = "map_id, letter, x, y, color_no, event_id, event_kind, node_type, is_boss";
export const nodeJson = (n: Row, lbasDistance?: ReadonlyMap<string, number>) => ({
  letter: n.letter, x: n.x, y: n.y, colorNo: n.color_no, eventId: n.event_id, eventKind: n.event_kind, type: n.node_type, isBoss: !!n.is_boss,
  lbasDistance: lbasDistance?.get(n.letter as string) ?? null,
});

export const EDGE_COLS = "map_id, edge_id, from_letter, to_letter";
export const edgeJson = (e: Row) => ({ id: e.edge_id, from: e.from_letter, to: e.to_letter });

export const ROUTING_HEAD_COLS = "map_id, layout, sources, defaults, start";
export const ROUTING_RULE_COLS = "map_id, from_letter, ord, node";
/** ROUTING_DSL document from routing_maps + routing_rules rows (rules in any order). */
export function routingDocJson(head: Row, rules: Row[]) {
  return {
    map: mapName(head.map_id as number),
    ...(head.layout ? { layout: head.layout } : {}),
    sources: parseJson(head.sources),
    ...(head.defaults ? { defaults: parseJson(head.defaults) } : {}),
    ...(head.start ? { start: parseJson(head.start) } : {}),
    nodes: Object.fromEntries([...rules].sort((a, b) => (a.ord as number) - (b.ord as number)).map((r) => [r.from_letter, parseJson(r.node)])),
  };
}

export const ROUTING_INFERRED_COLS = "map_id, sorties, generated_at, doc";
/** Where a map's routing document comes from (docs/API.md §2): hand-authored rules, or inferred from observations. */
export interface RoutingMeta { provenance: "hand" | "inferred"; generatedAt: string | null; sortieCount: number | null }
/**
 * The routing document of a map and its provenance: hand-authored rules (routing_maps + routing_rules) win, else
 * the inferred document (routing_inferred, scripts/infer-routing.ts), else null.
 */
export function routingJson(head: Row | null, rules: Row[], inferred: Row | null): { doc: unknown; meta: RoutingMeta } | null {
  if (head) return { doc: routingDocJson(head, rules), meta: { provenance: "hand", generatedAt: null, sortieCount: null } };
  if (inferred) {
    return { doc: parseJson(inferred.doc), meta: { provenance: "inferred", generatedAt: inferred.generated_at as string, sortieCount: inferred.sorties as number } };
  }
  return null;
}

export const COMP_SET_COLS = "s.id, s.map_id, s.node_letter, s.difficulty, s.period_start, s.period_end, s.total_count, s.retrieved_at, src.key AS source, s.layout, s.cell_nos";
export const COMP_COLS = "id, set_id, kcnav_master_id, formation, count, weight, airpower, lbas_airpower, first_seen, last_seen";
export const COMP_SHIP_COLS = "comp_id, fleet, position, ship_id, level, hp, fp, tp, aa, ar, equips";
/** One line per set (map detail `compSets`): node, difficulty, source, sample size and period. */
export const compSetSummaryJson = (s: Row) => ({
  node: s.node_letter, difficulty: s.difficulty, source: s.source, totalCount: s.total_count, layout: s.layout ?? null,
  periodStart: s.period_start || null, periodEnd: s.period_end || null, retrievedAt: s.retrieved_at,
});
/** Enemy comp sets with comps and ships, as in GET …/enemy-comps. */
export function compSetsJson(sets: Row[], comps: Row[], ships: Row[]) {
  const shipsByComp = new Map<unknown, Row[]>();
  for (const sh of ships) {
    if (!shipsByComp.has(sh.comp_id)) shipsByComp.set(sh.comp_id, []);
    shipsByComp.get(sh.comp_id)!.push(sh);
  }
  const shipJson = (sh: Row) => ({ shipId: sh.ship_id, level: sh.level, hp: sh.hp, fp: sh.fp, tp: sh.tp, aa: sh.aa, ar: sh.ar, equips: parseJson(sh.equips) });
  const byPos = (a: Row, b: Row) => (a.position as number) - (b.position as number);
  return sets.map((s) => ({
    difficulty: s.difficulty as number, periodStart: (s.period_start as string) || null, periodEnd: (s.period_end as string) || null,
    totalCount: s.total_count as number, retrievedAt: s.retrieved_at, source: s.source,
    // poi-observed only: layout version and the raw cells merged into this node.
    ...(s.layout == null ? {} : { layout: s.layout, cells: parseJson(s.cell_nos) }),
    comps: comps
      .filter((c) => c.set_id === s.id)
      .sort((a, b) => (b.count as number) - (a.count as number) || (a.id as number) - (b.id as number))
      .map((c) => {
        const mine = shipsByComp.get(c.id) ?? [];
        return {
          id: c.id, kcnavMasterId: c.kcnav_master_id, formation: c.formation, count: c.count as number, weight: c.weight as number,
          airpower: parseJson(c.airpower), lbasAirpower: parseJson(c.lbas_airpower),
          ...(c.first_seen == null ? {} : { firstSeen: c.first_seen, lastSeen: c.last_seen }),
          main: mine.filter((m) => m.fleet === 0).sort(byPos).map(shipJson),
          escort: mine.filter((m) => m.fleet === 1).sort(byPos).map(shipJson),
        };
      }),
  }));
}

export const SHIP_FIELDS: readonly Field[] = [
  ["id", "id"], ["name", "name"], ["nameEn", "name_en"], ["yomi", "yomi"], ["stype", "stype"], ["ctype", "ctype"], ["speed", "speed"],
  ["range", "range"], ["slotNum", "slot_num"], ["isAbyssal", "is_abyssal", "bool"], ["hp", "hp"], ["fp", "fp"], ["tp", "tp"], ["aa", "aa"],
  ["ar", "ar"], ["luck", "luck"], ["maxStats", "max_stats", "json"], ["slots", "slots", "json"], ["equips", "equips", "json"], ["flags", "flags", "json"],
];
export const SHIP_COLS = SHIP_FIELDS.map((f) => f[1]).join(", ");
export const shipJson = mapperOf(SHIP_FIELDS);

export const EQUIP_FIELDS: readonly Field[] = [
  ["id", "id"], ["name", "name"], ["type", "type", "json"], ["typeId", "type_id"], ["icon", "icon"], ["fp", "fp"], ["tp", "tp"], ["aa", "aa"],
  ["ar", "ar"], ["bomb", "bomb"], ["asw", "asw"], ["los", "los"], ["acc", "acc"], ["ev", "ev"], ["luck", "luck"], ["range", "range"],
  ["radius", "radius"], ["cost", "cost"], ["isAbyssal", "is_abyssal", "bool"],
];
export const EQUIP_COLS = EQUIP_FIELDS.map((f) => f[1]).join(", ");
export const equipJson = mapperOf(EQUIP_FIELDS);

export const ESTIMATE_COLS = "e.ship_id, e.stat, e.value, e.confidence, e.sd, e.n, e.note, e.updated_at, e.ci_lo, e.ci_hi, s.key AS source";
export interface EstimateJson {
  stat: string; value: unknown; confidence: string; sd: unknown; n: unknown; ci90: [unknown, unknown] | null; source: unknown; note: unknown; updatedAt: string;
}
/** `ci90` is the estimator:server 90 % credible interval (null for other sources). */
export const estimateJson = (e: Row): EstimateJson => ({
  stat: e.stat as string, value: e.value, confidence: e.confidence as string, sd: e.sd, n: e.n,
  ci90: e.ci_lo == null ? null : [e.ci_lo, e.ci_hi], source: e.source, note: e.note, updatedAt: e.updated_at as string,
});

/** GET /estimates rows over estimator_posteriors (SQL only); `density` (~2 KB per row) only when asked for. */
export const posteriorFields = (density: boolean): readonly Field[] => [
  ["shipId", "ship_id"], ["stat", "stat"], ["mean", "mean", "real"], ["sd", "sd", "real"],
  ["ci90", `json_array(${realSql("ci_lo")}, ${realSql("ci_hi")})`, "json"], ["n", "n"],
  ["priorSource", "coalesce(json_extract(prior, '$.source'), 'flat')"], ["prior", "prior", "json"],
  ...(density ? [["density", "density", "json"] as const] : []), ["updatedAt", "updated_at"],
];

const CONFIDENCE_RANK: Record<string, number> = { observed: 0, datamined: 1, db_estimate: 2, placeholder: 3, unknown: 4 };
/** One estimate per stat: best confidence (observed > datamined > db_estimate > placeholder > unknown), then newest. */
export function bestEstimates(estimates: EstimateJson[]) {
  const rank = (x: EstimateJson) => CONFIDENCE_RANK[x.confidence] ?? 9;
  const best: Record<string, EstimateJson> = {};
  for (const e of estimates) {
    const cur = best[e.stat];
    if (!cur || rank(e) < rank(cur) || (rank(e) === rank(cur) && e.updatedAt > cur.updatedAt)) best[e.stat] = e;
  }
  return Object.fromEntries(Object.entries(best).map(([k, e]) => [k, { value: e.value, confidence: e.confidence, source: e.source }]));
}
