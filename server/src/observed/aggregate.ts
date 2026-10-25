// Incremental aggregation of poi observations into the `poi-observed` source (private notes API §3 "Aggregation").
//
// Every observation is folded into the poi_* counters exactly once: each statement of an observation is
// guarded by `observations.aggregated_at IS NULL` and the batch ends by setting aggregated_at, so a D1 batch
// (one transaction) either counts it fully or not at all, and concurrent or repeated runs are no-ops.
// Aggregates key on raw cell numbers; letters are resolved through `edges` (edge_id = destination cell)
// only when the map's poi-observed comp sets are materialised, so a stale letter is fixed by re-aggregating.
// Quarantined observations (ingest/validate.ts) are never folded in.
import * as z from "zod";
import { BACKLOG_COUNT_CAP, COST, type Budget } from "../budget";
import { bumpDataVersion, PUBLISH_EVERY_MS } from "../cache";
import { CLIENT_CELL_DAY_CAP, MIN_REPORTERS, trustedClient } from "../auth/trust";
import { recountStaged } from "../ingest/upload";
import type { SortieRecord } from "../schemas";

/** agg_error of an observation beyond its client's daily cap: not counted (a rebuild re-decides). */
export const CLIENT_CAP = "client_cap";

export const OBSERVED_SOURCE = "poi-observed";
const SRC = `(SELECT id FROM sources WHERE key = '${OBSERVED_SOURCE}')`;
const GUARD = "EXISTS (SELECT 1 FROM observations WHERE id = ? AND aggregated_at IS NULL)";

/** Layout key of a sortie: sorted, unique api_cell_data cell numbers ("" = unknown). */
export const layoutKey = (cells: readonly number[] | null | undefined): string =>
  cells?.length ? [...new Set(cells)].sort((a, b) => a - b).join(",") : "";

/** Night continuation of the day battle at the same cell: same encounter, not a new one. */
export const isContinuationBattle = (path: string | null | undefined): boolean =>
  !!path && /^api_req_battle_midnight\/battle$|^api_req_combined_battle\/(ec_)?midnight_battle$/.test(path);

/** Normal maps (id < 100) have no difficulty; event maps need the uploaded rank. */
export const effectiveDifficulty = (mapId: number, difficulty: number | null): number | null =>
  difficulty ?? (mapId < 100 ? 0 : null);

// The battle `enemy` is the capture module's CapturedEnemy (poi-plugin-sim/src/capture/types.ts).
const enemyShip = z.object({
  masterId: z.number().int(), level: z.number().nullish(), maxHp: z.number().nullish(),
  slots: z.array(z.number()).nullish(), params: z.array(z.number()).nullish(),
}).loose();
const capturedEnemy = z.object({
  ships: z.array(enemyShip), escort: z.array(enemyShip).nullish(), enemyFormation: z.number().nullish(),
}).loose();

export interface CompShip {
  fleet: 0 | 1; position: number; shipId: number; level: number | null; hp: number | null;
  fp: number; tp: number; aa: number; ar: number; equips: number[];
}
export interface ObservedComp { signature: string; formation: number | null; ships: CompShip[] }

/** Comp of one battle; signature = formation | main ship ids | escort ship ids (in fleet order). */
export function compFromEnemy(enemy: unknown): ObservedComp | null {
  const r = capturedEnemy.safeParse(enemy);
  if (!r.success) return null;
  const conv = (fleet: 0 | 1, list: z.infer<typeof enemyShip>[] | null | undefined): CompShip[] =>
    (list ?? []).filter((s) => s.masterId > 0).map((s, position) => ({
      fleet, position, shipId: s.masterId, level: s.level ?? null, hp: s.maxHp ?? null,
      fp: s.params?.[0] ?? 0, tp: s.params?.[1] ?? 0, aa: s.params?.[2] ?? 0, ar: s.params?.[3] ?? 0, equips: s.slots ?? [],
    }));
  const main = conv(0, r.data.ships);
  const escort = conv(1, r.data.escort);
  if (!main.length) return null;
  const formation = r.data.enemyFormation ?? null;
  const ids = (l: CompShip[]) => l.map((s) => s.shipId).join(",");
  return { signature: `${formation ?? "?"}|${ids(main)}|${ids(escort)}`, formation, ships: [...main, ...escort] };
}

/** Columns read for aggregation (observations row + battle packet path + the client's salted IP hash). */
export interface ObservationRow {
  id: number; client_id: string; kind: string; map_id: number; node_letter: string | null; cell_no: number | null;
  difficulty: number | null; layout: string | null; observed_at: string; enemy: string | null; battle_path: string | null;
  sortie: string | null;
  /** reporter key for the distinct-reporter counts (none: not counted as a reporter) */
  ip_hash?: string | null;
  uploaded_at?: string;
}
const OBS_COLS = `id, client_id, kind, map_id, node_letter, cell_no, difficulty, layout, observed_at, enemy,
  json_extract(raw, '$.path') AS battle_path, sortie, uploaded_at, (SELECT ip_hash FROM clients c WHERE c.id = client_id) AS ip_hash`;

/** Guarded counter statements for one observation (without the final aggregated_at mark). */
export function observationStatements(db: D1Database, o: ObservationRow): D1PreparedStatement[] {
  const at = new Date(o.observed_at).toISOString();
  const layout = o.layout ?? "";
  const difficulty = effectiveDifficulty(o.map_id, o.difficulty);
  const out: D1PreparedStatement[] = [];
  const layoutReporter = () => {
    if (o.ip_hash && layout) {
      out.push(db.prepare(`INSERT INTO poi_layout_reporters (map_id, layout, ip_hash) SELECT ?1, ?2, ?3 WHERE ${GUARD.replace("?", "?4")} ON CONFLICT DO NOTHING`)
        .bind(o.map_id, layout, o.ip_hash, o.id));
    }
  };
  const layoutUpsert = (sorties: number, encounters: number, cells: string | null, boss: number | null) => db.prepare(
    `INSERT INTO poi_layouts (map_id, layout, version, cells, boss_cell, sorties, encounters, first_seen, last_seen)
     SELECT ?1, ?2, CASE WHEN ?2 = '' THEN 0 ELSE (SELECT COALESCE(MAX(version), 0) + 1 FROM poi_layouts WHERE map_id = ?1 AND layout <> '') END,
       ?3, ?4, ?5, ?6, ?7, ?7
     WHERE ${GUARD.replace("?", "?8")}
     ON CONFLICT (map_id, layout) DO UPDATE SET
       cells = CASE WHEN excluded.cells IS NOT NULL AND excluded.last_seen >= poi_layouts.last_seen THEN excluded.cells ELSE poi_layouts.cells END,
       boss_cell = CASE WHEN excluded.boss_cell IS NOT NULL AND excluded.last_seen >= poi_layouts.last_seen THEN excluded.boss_cell ELSE COALESCE(poi_layouts.boss_cell, excluded.boss_cell) END,
       sorties = poi_layouts.sorties + excluded.sorties, encounters = poi_layouts.encounters + excluded.encounters,
       first_seen = MIN(poi_layouts.first_seen, excluded.first_seen), last_seen = MAX(poi_layouts.last_seen, excluded.last_seen)`,
  ).bind(o.map_id, layout, cells, boss, sorties, encounters, at, o.id);

  if (o.kind === "battle") {
    const cell = o.cell_no ?? (o.node_letter && /^\d+$/.test(o.node_letter) ? Number(o.node_letter) : null);
    const comp = compFromEnemy(o.enemy == null ? null : JSON.parse(o.enemy));
    if (cell === null || difficulty === null || !comp || isContinuationBattle(o.battle_path)) return out;
    out.push(layoutUpsert(0, 1, null, null));
    layoutReporter();
    out.push(db.prepare(
      `INSERT INTO poi_comp_counts (map_id, layout, cell_no, difficulty, signature, formation, ships, count, first_seen, last_seen)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8 WHERE ${GUARD.replace("?", "?9")}
       ON CONFLICT (map_id, layout, cell_no, difficulty, signature) DO UPDATE SET count = poi_comp_counts.count + 1,
         first_seen = MIN(poi_comp_counts.first_seen, excluded.first_seen), last_seen = MAX(poi_comp_counts.last_seen, excluded.last_seen)`,
    ).bind(o.map_id, layout, cell, difficulty, comp.signature, comp.formation, JSON.stringify(comp.ships), at, o.id));
    if (o.ip_hash) {
      out.push(db.prepare(
        `INSERT INTO poi_cell_reporters (map_id, layout, cell_no, difficulty, ip_hash) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${GUARD.replace("?", "?6")} ON CONFLICT DO NOTHING`,
      ).bind(o.map_id, layout, cell, difficulty, o.ip_hash, o.id));
    }
    return out;
  }
  if (o.kind !== "sortie" || !o.sortie) return out;

  const s = JSON.parse(o.sortie) as SortieRecord;
  const boss = s.cells.find((c) => c.bossCellNo != null)?.bossCellNo ?? null;
  const cellUpsert = (no: number, color: number | null | undefined, eventId: number | null | undefined, eventKind: number | null | undefined, visits: number, distance?: number | null) =>
    db.prepare(
      `INSERT INTO poi_cells (map_id, layout, cell_no, color_no, event_id, event_kind, visits, is_boss, lbas_distance)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10 WHERE ${GUARD.replace("?", "?9")}
       ON CONFLICT (map_id, layout, cell_no) DO UPDATE SET color_no = COALESCE(excluded.color_no, poi_cells.color_no),
         lbas_distance = COALESCE(excluded.lbas_distance, poi_cells.lbas_distance),
         event_id = COALESCE(excluded.event_id, poi_cells.event_id), event_kind = COALESCE(excluded.event_kind, poi_cells.event_kind),
         visits = poi_cells.visits + excluded.visits, is_boss = MAX(poi_cells.is_boss, excluded.is_boss)`,
    ).bind(o.map_id, layout, no, color ?? null, eventId ?? null, eventKind ?? null, visits, no === boss ? 1 : 0, o.id, distance ?? null);

  out.push(layoutUpsert(1, 0, s.cellData ? JSON.stringify(s.cellData) : null, boss));
  layoutReporter();
  for (const c of s.cellData ?? []) out.push(cellUpsert(c.no, c.colorNo, null, null, 0, c.distance));
  for (const c of s.cells) out.push(cellUpsert(c.no, c.colorNo, c.eventId, c.eventKind, 1));
  if (boss !== null && !s.cells.some((c) => c.no === boss) && !s.cellData?.some((c) => c.no === boss)) out.push(cellUpsert(boss, null, null, null, 0));
  let prev: number | null = null;
  for (const c of s.cells) {
    out.push(db.prepare(
      `INSERT INTO poi_edge_counts (map_id, layout, difficulty, from_cell, to_cell, count)
       SELECT ?1, ?2, ?3, ?4, ?5, 1 WHERE ${GUARD.replace("?", "?6")}
       ON CONFLICT (map_id, layout, difficulty, from_cell, to_cell) DO UPDATE SET count = poi_edge_counts.count + 1`,
    ).bind(o.map_id, layout, difficulty ?? -1, c.from ?? prev ?? 0, c.no, o.id));
    prev = c.no;
  }
  // One row per battle result: the dropped ship, or ship 0 for no drop (the denominator of the drop rate).
  const drops = difficulty === null ? [] : s.cells.flatMap((c) => (c.result?.rank ? [{ cell: c.no, rank: c.result.rank, ship: c.result.drop?.shipId ?? 0 }] : []));
  if (drops.length) {
    out.push(db.prepare(
      `INSERT INTO poi_drop_counts (map_id, layout, difficulty, cell_no, rank, ship_id, count, first_seen, last_seen)
       SELECT ?1, ?2, ?3, json_extract(j.value, '$.cell'), json_extract(j.value, '$.rank'), json_extract(j.value, '$.ship'), 1, ?4, ?4
       FROM json_each(?5) j WHERE ${GUARD.replace("?", "?6")}
       ON CONFLICT (map_id, layout, difficulty, cell_no, rank, ship_id) DO UPDATE SET count = poi_drop_counts.count + 1,
         first_seen = MIN(poi_drop_counts.first_seen, excluded.first_seen), last_seen = MAX(poi_drop_counts.last_seen, excluded.last_seen)`,
    ).bind(o.map_id, layout, difficulty, at, JSON.stringify(drops), o.id));
  }
  out.push(db.prepare(
    `INSERT INTO poi_sorties (observation_id, client_id, map_id, difficulty, layout, observed_at, end_kind, cells, battles, features)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ${GUARD.replace("?", "?1")}
     ON CONFLICT (observation_id) DO NOTHING`,
  ).bind(o.id, o.client_id, o.map_id, difficulty, layout, at, s.endKind, JSON.stringify(s.cells.map((c) => c.no)),
    s.cells.reduce((n, c) => n + c.battles.length, 0), s.features == null ? null : JSON.stringify(s.features)));
  return out;
}

const markStmt = (db: D1Database, id: number, now: string, error: string | null = null) =>
  db.prepare("UPDATE observations SET aggregated_at = ?1, agg_error = ?2 WHERE id = ?3 AND aggregated_at IS NULL").bind(now, error, id);

export interface AggregateResult {
  aggregated: number;
  failed: number;
  /** beyond their client's daily cap: marked, not counted */
  capped: number;
  /** maps re-materialised by this run */
  maps: number[];
  /** observations still pending */
  remaining: number;
  /** maps whose comp sets still wait for re-materialisation */
  dirtyMaps: number;
}

/** SQL (observations `alias`): waits for the fold. Probation clients' observations wait until they are trusted. */
export const foldable = (alias: string) => `${alias}.aggregated_at IS NULL AND ${alias}.quarantine IS NULL AND ${trustedClient(alias)}`;

/** The per-client daily cap key of an observation: battles per cell, sorties (-1) per map, per upload day. */
const capCell = (o: ObservationRow) => (o.kind === "battle" ? (o.cell_no ?? -2) : -1);
const capDay = (o: ObservationRow) => (o.uploaded_at ?? o.observed_at).slice(0, 10);

/**
 * Folds not yet aggregated, non-quarantined observations of trusted clients (oldest first) into the counters while
 * `budget` lasts (COST.aggregateObservation each, ≤ 200) and marks their maps dirty in the same batches. An
 * observation that cannot be aggregated is marked with `agg_error` and skipped until a rebuild; one beyond its
 * client's daily cap (CLIENT_CELL_DAY_CAP) is marked `client_cap` and not counted.
 */
export async function foldPending(db: D1Database, budget: Budget, now: () => string): Promise<{ aggregated: number; failed: number; capped: number }> {
  const out = { aggregated: 0, failed: 0, capped: 0 };
  const dirty = (maps: number[]) =>
    db.prepare("INSERT INTO poi_dirty_maps (map_id, since) SELECT value, ?2 FROM json_each(?1) WHERE true ON CONFLICT DO NOTHING")
      .bind(JSON.stringify([...new Set(maps)]), now());
  const counter = (o: ObservationRow) => db.prepare(
    `INSERT INTO poi_client_days (client_id, map_id, cell_no, day, n) SELECT ?1, ?2, ?3, ?4, 1 WHERE ${GUARD.replace("?", "?5")}
     ON CONFLICT (client_id, map_id, cell_no, day) DO UPDATE SET n = n + 1`,
  ).bind(o.client_id, o.map_id, capCell(o), capDay(o), o.id);
  // one read, one counter read, ≤ 4 batches of 50
  const limit = Math.min(200, Math.floor((budget.left - 6 * COST.d1Call) / COST.aggregateObservation));
  if (limit < 1 || !budget.fits(6 * COST.d1Call + COST.aggregateObservation, 6)) return out;
  const { results: rows } = await db.prepare(`SELECT ${OBS_COLS} FROM observations WHERE ${foldable("observations")} ORDER BY id LIMIT ?1`)
    .bind(limit).all<ObservationRow>();
  budget.charge(COST.d1Call + COST.aggregateObservation * rows.length, 1);
  if (!rows.length) return out;
  const { results: days } = await db.prepare(
    `SELECT client_id, map_id, cell_no, day, n FROM poi_client_days
     WHERE client_id IN (SELECT value FROM json_each(?1)) AND day IN (SELECT value FROM json_each(?2))`,
  ).bind(JSON.stringify([...new Set(rows.map((o) => o.client_id))]), JSON.stringify([...new Set(rows.map(capDay))]))
    .all<{ client_id: string; map_id: number; cell_no: number; day: string; n: number }>();
  budget.charge(COST.d1Call, 1);
  const key = (client: string, map: number, cell: number, day: string) => `${client}|${map}|${cell}|${day}`;
  const counts = new Map(days.map((d) => [key(d.client_id, d.map_id, d.cell_no, d.day), d.n]));
  const capped = new Set<number>();
  for (const o of rows) {
    const k = key(o.client_id, o.map_id, capCell(o), capDay(o));
    const n = counts.get(k) ?? 0;
    if (n >= CLIENT_CELL_DAY_CAP) capped.add(o.id);
    else counts.set(k, n + 1);
  }
  const statements = (o: ObservationRow) =>
    capped.has(o.id) ? [markStmt(db, o.id, now(), CLIENT_CAP)] : [...observationStatements(db, o), counter(o), markStmt(db, o.id, now())];
  const one = async (o: ObservationRow) => {
    try {
      await db.batch([...statements(o), dirty([o.map_id])]);
      if (capped.has(o.id)) out.capped++;
      else out.aggregated++;
    } catch (e) {
      out.failed++;
      await db.batch([markStmt(db, o.id, now(), String(e).slice(0, 500))]);
    }
    budget.charge(COST.d1Call, 1);
  };
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    try {
      await db.batch([...chunk.flatMap(statements), dirty(chunk.map((o) => o.map_id))]);
      const c = chunk.filter((o) => capped.has(o.id)).length;
      out.capped += c;
      out.aggregated += chunk.length - c;
      budget.charge(COST.d1Call, 1);
    } catch {
      // isolate the observation that fails; the rest stays pending if the D1 calls run out
      for (const o of chunk) {
        if (!budget.fits(0, 9)) break;
        await one(o);
      }
    }
  }
  return out;
}

/**
 * Re-materialises dirty maps while `budget` lasts (COST.materializeMap + COST.materializeRow per comp-count row),
 * once a map is caught up (no staged uploads left anywhere and no pending observation of the map) or after it
 * has been dirty for PUBLISH_EVERY_MS. Re-materialising rewrites all of a map's poi-observed comp rows, so
 * once per burst of uploads keeps D1 writes down. Returns the maps done.
 */
export async function materializeDirty(db: D1Database, budget: Budget, now: () => string): Promise<number[]> {
  const maps: number[] = [];
  // per map: 1 probe, 6 reads + 1 batch, 1 delete
  while (budget.fits(COST.materializeMap + 9 * COST.d1Call, 9)) {
    const cutoff = new Date(Date.parse(now()) - PUBLISH_EVERY_MS).toISOString();
    // pending observations through their index (rows read = the pending ones, not all of the map's)
    const next = await db.prepare(
      `SELECT d.map_id, (SELECT COUNT(*) FROM poi_comp_counts c WHERE c.map_id = d.map_id) AS comp_rows FROM poi_dirty_maps d
       WHERE d.since <= ?1 OR (NOT EXISTS (SELECT 1 FROM upload_items) AND NOT EXISTS (SELECT 1 FROM observations o INDEXED BY observations_pending
         WHERE o.map_id = d.map_id AND ${foldable("o")}))
       ORDER BY d.since LIMIT 1`,
    ).bind(cutoff).first<{ map_id: number; comp_rows: number }>();
    budget.charge(COST.d1Call, 1);
    const cost = next ? COST.materializeMap + COST.materializeRow * next.comp_rows + 8 * COST.d1Call : 0;
    if (!next || !budget.fits(cost, 8)) break;
    await materializeMap(db, next.map_id, now());
    await db.prepare("DELETE FROM poi_dirty_maps WHERE map_id = ?1").bind(next.map_id).run();
    budget.charge(cost, 8);
    maps.push(next.map_id);
  }
  return maps.sort((a, b) => a - b);
}

/** Pending observations (up to BACKLOG_COUNT_CAP) and dirty maps left. */
export async function aggregationBacklog(db: D1Database, budget: Budget): Promise<{ remaining: number; dirtyMaps: number }> {
  const left = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM observations WHERE ${foldable("observations")} LIMIT ${BACKLOG_COUNT_CAP})) AS n,
       (SELECT COUNT(*) FROM poi_dirty_maps) AS d`,
  ).first<{ n: number; d: number }>();
  budget.charge(COST.d1Call, 1);
  return { remaining: left?.n ?? 0, dirtyMaps: left?.d ?? 0 };
}

/** One budgeted aggregation step (POST /admin/aggregate/run): fold, then re-materialise what is ready. */
export async function aggregatePending(db: D1Database, budget: Budget, now: () => string = () => new Date().toISOString()): Promise<AggregateResult> {
  const folded = await foldPending(db, budget, now);
  const maps = await materializeDirty(db, budget, now);
  return { ...folded, maps, ...(await aggregationBacklog(db, budget)) };
}

/**
 * Clears the poi-observed aggregates (all maps, or `mapIds`) and marks their observations as not yet
 * aggregated, in one batch. The jobs run (foldPending) then refolds them in budgeted steps.
 */
export function resetStatements(db: D1Database, mapIds?: number[]): D1PreparedStatement[] {
  const ids = mapIds ? JSON.stringify(mapIds) : null;
  const inMaps = (col: string) => `(?1 IS NULL OR ${col} IN (SELECT value FROM json_each(?1)))`;
  const sets = `SELECT id FROM enemy_comp_sets WHERE source_id = ${SRC} AND ${inMaps("map_id")}`;
  return [
    ...["poi_layouts", "poi_cells", "poi_edge_counts", "poi_comp_counts", "poi_drop_counts", "poi_sorties", "poi_graph_mismatches",
      "poi_layout_reporters", "poi_cell_reporters", "poi_client_days"]
      .map((t) => db.prepare(`DELETE FROM ${t} WHERE ${inMaps("map_id")}`).bind(ids)),
    db.prepare(`DELETE FROM enemy_comp_ships WHERE comp_id IN (SELECT id FROM enemy_comps WHERE set_id IN (${sets}))`).bind(ids),
    db.prepare(`DELETE FROM enemy_comps WHERE set_id IN (${sets})`).bind(ids),
    db.prepare(`DELETE FROM enemy_comp_sets WHERE id IN (${sets})`).bind(ids),
    db.prepare(`UPDATE observations SET aggregated_at = NULL, agg_error = NULL WHERE ${inMaps("map_id")}`).bind(ids),
    bumpDataVersion(db),
  ];
}

/**
 * Deletes every observation of `clientId` and resets the aggregates of the maps they touched; the next jobs run refolds
 * the remaining observations of those maps.
 */
export async function deleteClientObservations(db: D1Database, clientId: string): Promise<{ deleted: number; maps: number[] }> {
  const { results } = await db.prepare("SELECT DISTINCT map_id FROM observations WHERE client_id = ?1").bind(clientId).all<{ map_id: number }>();
  const maps = results.map((r) => r.map_id).sort((a, b) => a - b);
  const res = await db.batch([
    db.prepare("DELETE FROM upload_items WHERE client_id = ?1").bind(clientId),
    db.prepare("DELETE FROM observations WHERE client_id = ?1").bind(clientId),
    ...(maps.length ? resetStatements(db, maps) : []),
    ...recountStaged(db),
  ]);
  return { deleted: res[1]?.meta.changes ?? 0, maps };
}

// ---- materialisation: poi_comp_counts -> enemy_comp_sets / enemy_comps / enemy_comp_ships ----

/** Cell number -> node letter (edge_id is the destination cell number; several cells can share a letter). */
export const cellLetters = (edges: { edge_id: number; to_letter: string }[]): Map<number, string> =>
  new Map(edges.map((e) => [e.edge_id, e.to_letter]));

interface CompCountRow { layout: string; cell_no: number; difficulty: number; signature: string; formation: number | null; ships: string; count: number; first_seen: string; last_seen: string }
interface LayoutRow { layout: string; version: number }
/** One reporter (salted IP hash) of a layout, and of a comp cell when `cell_no` is set. */
export interface ReporterRow { layout: string; ip_hash: string; cell_no?: number; difficulty?: number }

export interface MaterializedSet {
  node: string; difficulty: number; layout: number; cells: number[]; periodStart: string; periodEnd: string;
  totalCount: number; retrievedAt: string;
  /** distinct reporters of the set's encounters */
  reporters: number;
  comps: { signature: string; formation: number | null; ships: string; count: number; weight: number; firstSeen: string; lastSeen: string }[];
}

/**
 * The map's current layout. Layouts are taken in version order (first aggregation); a newer one replaces the
 * current one when MIN_REPORTERS distinct reporters saw it, or when everyone who reported the current one did
 * (the same players moved on). So one new reporter cannot retire a layout others report. '' (unknown) only when
 * no layout is known.
 */
export function currentLayout(layouts: LayoutRow[], reporters: ReporterRow[]): string {
  const by = new Map<string, Set<string>>();
  for (const r of reporters) by.set(r.layout, (by.get(r.layout) ?? new Set()).add(r.ip_hash));
  const known = layouts.filter((l) => l.layout !== "").sort((a, b) => a.version - b.version);
  let current = known[0]?.layout ?? "";
  for (const l of known.slice(1)) {
    const mine = by.get(l.layout) ?? new Set<string>();
    const theirs = by.get(current) ?? new Set<string>();
    if (mine.size >= MIN_REPORTERS || [...theirs].every((h) => mine.has(h))) current = l.layout;
  }
  return current;
}

/**
 * Groups per-cell comp counts into sets per (letter, difficulty, layout version). Unresolvable cells keep
 * their number as the node name. The current layout's set is open (periodEnd ''); others end at their
 * last encounter. `reporters` (rows with cell_no) gives each set its distinct reporter count.
 */
export function buildObservedSets(rows: CompCountRow[], layouts: LayoutRow[], letters: Map<number, string>, reporters: ReporterRow[] = []): MaterializedSet[] {
  const version = new Map(layouts.map((l) => [l.layout, l.version]));
  const current = version.get(currentLayout(layouts, reporters.filter((r) => r.cell_no === undefined))) ?? 0;
  const sets = new Map<string, MaterializedSet & { bySig: Map<string, MaterializedSet["comps"][number] & { best: number }>; who: Set<string> }>();
  const cellReporters = new Map<string, string[]>();
  for (const r of reporters) {
    if (r.cell_no === undefined) continue;
    const k = `${r.layout}\u0000${r.cell_no}\u0000${r.difficulty}`;
    cellReporters.set(k, [...(cellReporters.get(k) ?? []), r.ip_hash]);
  }
  for (const r of rows) {
    const node = letters.get(r.cell_no) ?? String(r.cell_no);
    const v = version.get(r.layout) ?? 0;
    const key = `${node}\u0000${r.difficulty}\u0000${v}`;
    let s = sets.get(key);
    if (!s) {
      s = { node, difficulty: r.difficulty, layout: v, cells: [], periodStart: r.first_seen, periodEnd: "", totalCount: 0, retrievedAt: r.last_seen, reporters: 0, comps: [], bySig: new Map(), who: new Set() };
      sets.set(key, s);
    }
    if (!s.cells.includes(r.cell_no)) s.cells.push(r.cell_no);
    for (const h of cellReporters.get(`${r.layout}\u0000${r.cell_no}\u0000${r.difficulty}`) ?? []) s.who.add(h);
    s.totalCount += r.count;
    if (r.first_seen < s.periodStart) s.periodStart = r.first_seen;
    if (r.last_seen > s.retrievedAt) s.retrievedAt = r.last_seen;
    const c = s.bySig.get(r.signature);
    if (!c) {
      s.bySig.set(r.signature, { signature: r.signature, formation: r.formation, ships: r.ships, count: r.count, weight: 0, firstSeen: r.first_seen, lastSeen: r.last_seen, best: r.count });
    } else {
      c.count += r.count;
      if (r.count > c.best) Object.assign(c, { ships: r.ships, best: r.count });
      if (r.first_seen < c.firstSeen) c.firstSeen = r.first_seen;
      if (r.last_seen > c.lastSeen) c.lastSeen = r.last_seen;
    }
  }
  return [...sets.values()].map(({ bySig, who, ...s }) => ({
    ...s,
    cells: s.cells.sort((a, b) => a - b),
    reporters: who.size,
    periodEnd: s.layout === current ? "" : s.retrievedAt,
    comps: [...bySig.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
      .map(({ best: _best, ...c }) => ({ ...c, weight: c.count / s.totalCount })),
  }));
}

/** Replaces the map's poi-observed comp sets and mismatch report and bumps the data version, in one batch. */
export async function materializeMap(db: D1Database, mapId: number, now: string): Promise<void> {
  const [rows, layouts, edges, nodes, observedEdges, cells, layoutReporters, cellReporters] = await Promise.all([
    db.prepare("SELECT layout, cell_no, difficulty, signature, formation, ships, count, first_seen, last_seen FROM poi_comp_counts WHERE map_id = ?1").bind(mapId).all<CompCountRow>(),
    db.prepare("SELECT layout, version, boss_cell FROM poi_layouts WHERE map_id = ?1").bind(mapId).all<LayoutRow & { boss_cell: number | null }>(),
    db.prepare("SELECT edge_id, from_letter, to_letter FROM edges WHERE map_id = ?1").bind(mapId).all<StoredEdge>(),
    db.prepare("SELECT letter, event_id, is_boss FROM nodes WHERE map_id = ?1").bind(mapId).all<StoredNode>(),
    db.prepare("SELECT layout, from_cell, to_cell, SUM(count) AS count FROM poi_edge_counts WHERE map_id = ?1 GROUP BY layout, from_cell, to_cell").bind(mapId).all<ObservedEdge>(),
    db.prepare("SELECT layout, cell_no, event_id, visits, is_boss FROM poi_cells WHERE map_id = ?1").bind(mapId).all<ObservedCell>(),
    db.prepare("SELECT layout, ip_hash FROM poi_layout_reporters WHERE map_id = ?1").bind(mapId).all<ReporterRow>(),
    db.prepare("SELECT layout, cell_no, difficulty, ip_hash FROM poi_cell_reporters WHERE map_id = ?1").bind(mapId).all<ReporterRow>(),
  ]);
  const current = currentLayout(layouts.results, layoutReporters.results);
  const sets = buildObservedSets(rows.results, layouts.results, cellLetters(edges.results), [...layoutReporters.results, ...cellReporters.results]);
  const mismatches = graphMismatches({ edges: edges.results, nodes: nodes.results, observedEdges: observedEdges.results, cells: cells.results });
  const setRef = `(SELECT id FROM enemy_comp_sets WHERE map_id = ?1 AND node_letter = ?2 AND difficulty = ?3 AND layout = ?4 AND source_id = ${SRC})`;
  const stmts: D1PreparedStatement[] = [
    ...resetComps(db, mapId),
    db.prepare("UPDATE poi_layouts SET current = (layout = ?2) WHERE map_id = ?1").bind(mapId, current),
  ];
  for (const s of sets) {
    stmts.push(db.prepare(
      `INSERT INTO enemy_comp_sets (map_id, node_letter, difficulty, period_start, period_end, total_count, retrieved_at, cache_id, source_id, layout, cell_nos, reporters)
       VALUES (?1, ?2, ?3, ?5, ?6, ?7, ?8, NULL, ${SRC}, ?4, ?9, ?10)`,
    ).bind(mapId, s.node, s.difficulty, s.layout, s.periodStart, s.periodEnd, s.totalCount, s.retrievedAt, JSON.stringify(s.cells), s.reporters));
    for (const c of s.comps) {
      stmts.push(db.prepare(
        `INSERT INTO enemy_comps (set_id, kcnav_master_id, formation, count, weight, airpower, lbas_airpower, signature, first_seen, last_seen)
         VALUES (${setRef}, NULL, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?10)`,
      ).bind(mapId, s.node, s.difficulty, s.layout, c.formation, c.count, c.weight, c.signature, c.firstSeen, c.lastSeen));
      stmts.push(db.prepare(
        `INSERT INTO enemy_comp_ships (comp_id, fleet, position, ship_id, level, hp, fp, tp, aa, ar, equips)
         SELECT (SELECT id FROM enemy_comps WHERE set_id = ${setRef} AND signature = ?5),
           json_extract(j.value, '$.fleet'), json_extract(j.value, '$.position'), json_extract(j.value, '$.shipId'),
           json_extract(j.value, '$.level'), json_extract(j.value, '$.hp'), json_extract(j.value, '$.fp'), json_extract(j.value, '$.tp'),
           json_extract(j.value, '$.aa'), json_extract(j.value, '$.ar'), json_extract(j.value, '$.equips')
         FROM json_each(?6) j`,
      ).bind(mapId, s.node, s.difficulty, s.layout, c.signature, c.ships));
    }
  }
  stmts.push(db.prepare("DELETE FROM poi_graph_mismatches WHERE map_id = ?1").bind(mapId));
  for (const m of mismatches) {
    stmts.push(db.prepare(
      `INSERT INTO poi_graph_mismatches (map_id, layout, kind, from_cell, to_cell, count, observed, stored, checked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(mapId, m.layout, m.kind, m.fromCell, m.toCell, m.count, m.observed, m.stored, now));
  }
  stmts.push(bumpDataVersion(db)); // the comp sets, map graph and report changed: new GET cache key space
  await db.batch(stmts);
}

function resetComps(db: D1Database, mapId: number): D1PreparedStatement[] {
  const sets = `SELECT id FROM enemy_comp_sets WHERE map_id = ?1 AND source_id = ${SRC}`;
  return [
    db.prepare(`DELETE FROM enemy_comp_ships WHERE comp_id IN (SELECT id FROM enemy_comps WHERE set_id IN (${sets}))`).bind(mapId),
    db.prepare(`DELETE FROM enemy_comps WHERE set_id IN (${sets})`).bind(mapId),
    db.prepare(`DELETE FROM enemy_comp_sets WHERE id IN (${sets})`).bind(mapId),
  ];
}

// ---- observed graph vs stored edges ----

export interface StoredEdge { edge_id: number; from_letter: string; to_letter: string }
export interface StoredNode { letter: string; event_id: number | null; is_boss: number }
export interface ObservedEdge { layout: string; from_cell: number; to_cell: number; count: number }
export interface ObservedCell { layout: string; cell_no: number; event_id: number | null; visits: number; is_boss: number }
export interface Mismatch {
  layout: string; kind: "unknown_edge" | "from_mismatch" | "boss_mismatch" | "event_mismatch";
  fromCell: number; toCell: number; count: number; observed: string; stored: string | null;
}

/**
 * Disagreements between the observed graph and the stored edges/nodes. Maps without stored edges are not
 * compared. A transition from a cell with no incoming stored edge is a start: the stored edge must leave a
 * Start node.
 */
export function graphMismatches(input: { edges: StoredEdge[]; nodes: StoredNode[]; observedEdges: ObservedEdge[]; cells: ObservedCell[] }): Mismatch[] {
  if (!input.edges.length) return [];
  const byId = new Map(input.edges.map((e) => [e.edge_id, e]));
  const letter = (cell: number) => byId.get(cell)?.to_letter;
  const out: Mismatch[] = [];
  for (const o of input.observedEdges) {
    const e = byId.get(o.to_cell);
    const fromLetter = letter(o.from_cell);
    const observed = `${o.from_cell}(${fromLetter ?? "start?"}) -> ${o.to_cell}`;
    if (!e) out.push({ layout: o.layout, kind: "unknown_edge", fromCell: o.from_cell, toCell: o.to_cell, count: o.count, observed, stored: null });
    else if (fromLetter === undefined ? !e.from_letter.startsWith("Start") : fromLetter !== e.from_letter) {
      out.push({ layout: o.layout, kind: "from_mismatch", fromCell: o.from_cell, toCell: o.to_cell, count: o.count, observed, stored: `edge ${e.edge_id}: ${e.from_letter} -> ${e.to_letter}` });
    }
  }
  const nodes = new Map(input.nodes.map((n) => [n.letter, n]));
  const bosses = input.nodes.filter((n) => n.is_boss).map((n) => n.letter).sort();
  for (const c of input.cells) {
    const l = letter(c.cell_no);
    if (c.is_boss && bosses.length && (!l || !bosses.includes(l))) {
      out.push({ layout: c.layout, kind: "boss_mismatch", fromCell: -1, toCell: c.cell_no, count: c.visits, observed: `boss cell ${c.cell_no}(${l ?? "?"})`, stored: `boss ${bosses.join(",")}` });
    }
    const stored = l ? nodes.get(l)?.event_id : null;
    if (l && c.event_id != null && stored != null && stored !== c.event_id) {
      out.push({ layout: c.layout, kind: "event_mismatch", fromCell: -1, toCell: c.cell_no, count: c.visits, observed: `cell ${c.cell_no}(${l}) event ${c.event_id}`, stored: `${l} event ${stored}` });
    }
  }
  return out;
}
