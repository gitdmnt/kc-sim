// Server-side hidden-stat estimator (docs/ESTIMATOR.md "Server job"), in three stages that each charge the CPU
// cost model (src/budget.ts) and stop when the next unit would not fit; the queues keep the rest:
//  1. count: pending (battle observation, enemy ship) pairs of `observation_ships` become attack rolls
//     (shared/estimate/observe), counted per (ship, role, canonical query signature) in `estimator_rolls`.
//     Counts and pair marks are written in one D1 batch, so each observation counts exactly once. No forward
//     model: this stage is cheap.
//  2. fold: for the next pending (ship, role) after the last one folded (round robin over the key order, the
//     cursor in kv_state), one hitProbabilityGrid call per signature row adds its counts to the ship's
//     log-likelihood grid in `estimator_accum`; grid, row deletions and cursor are written in one batch. A
//     signature that many rolls share costs one grid call however many observations it came from.
//  3. summarize: ships whose grids changed are summarized against their current prior into
//     `estimator_posteriors` (all n) and `estimates` (source estimator:server, n >= 30), once the queues are
//     caught up or a ship has waited PUBLISH_EVERY_MS (each summary bumps data_version).
// Callers hold the jobs lease (src/jobs.ts).
import type { AttackEvent, CapturedBattle, CapturedEnemy, CapturedFleet } from "../../../shared/capture/types";
import { extractAttackEvents } from "../../../shared/capture/parser";
import type { Confidence, ShipEstimate } from "../../../shared/data/types";
import { gridFor, type GridFn } from "../../../shared/estimate/forward";
import { groupObservations, newPosterior, shipPrior, summarizeShip, type PriorTable } from "../../../shared/estimate/infer";
import { buildObservations } from "../../../shared/estimate/observe";
import { DEFAULT_GRID, type GridSpec, type PosteriorState } from "../../../shared/estimate/posterior";
import { choosePrior } from "../../../shared/estimate/prior";
import { ESTIMATED_STATS, type BattleRecord, type EstimateResult, type ObservationRole, type SkipCounts } from "../../../shared/estimate/types";
import type { FitEntry } from "../../../shared/sim/fit";
import { COST, type Budget } from "../budget";
import { bumpDataVersion, PUBLISH_EVERY_MS } from "../cache";
import { mapName, parseMapKey } from "../maps";
import { loadFitBonuses, loadMaster } from "../master";

export const ESTIMATOR_SOURCE = "estimator:server";
/** Rows with fewer rolls stay out of `estimates` (and so out of `best`), as in the plugin before. */
export const ESTIMATE_MIN_N = 30;
const DENSITY_POINTS = 101;
const SRC = `(SELECT id FROM sources WHERE key = '${ESTIMATOR_SOURCE}')`;
/** Bound JSON parameters stay below D1's 2 MB value limit (UTF-16 length; ≤ 3 UTF-8 bytes per unit). */
const MAX_PARAM_CHARS = 300_000;
/** KB of one stored grid with the default axes (201 × 101 Float32 values as base64), for the D1 transfer cost. */
const GRID_KB = (201 * 101 * 4 * 4) / 3 / 1024;

export interface EstimatorOptions {
  /** sim-core hitProbabilityGrid (src/estimator/wasm.ts instantiates and compiles it at isolate startup) */
  gridFn: () => GridFn;
  budget: Budget;
  now: number;
  epsilon?: number;
}

export interface EstimatorResult {
  observations: number;
  rolls: number;
  /** signature rows folded (= grid calls) */
  gridCalls: number;
  /** ships whose grids were updated */
  ships: number[];
  summarized: number;
  skipped: SkipCounts;
}

// ---- grid storage: base64 of Float32 little-endian, shifted so the maximum is 0 ----

const toBase64 = (bytes: Uint8Array): string => {
  if ("toBase64" in bytes && typeof bytes.toBase64 === "function") return String(bytes.toBase64());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const fromBase64 = (s: string): Uint8Array => {
  if ("fromBase64" in Uint8Array && typeof Uint8Array.fromBase64 === "function") {
    const out: unknown = Uint8Array.fromBase64(s);
    if (out instanceof Uint8Array) return out;
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const encodeGrid = (ll: Float64Array): string => {
  let max = -Infinity;
  for (const v of ll) if (v > max) max = v;
  const shift = Number.isFinite(max) ? max : 0;
  const out = new Float32Array(ll.length);
  for (let i = 0; i < ll.length; i++) out[i] = ll[i]! - shift;
  return toBase64(new Uint8Array(out.buffer));
};

export const decodeGrid = (s: string | null, length: number): Float64Array => {
  if (s === null) return new Float64Array(length);
  const bytes = fromBase64(s); // a fresh buffer: 4-byte aligned
  const grid = Float64Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  if (grid.length !== length) throw new Error(`stored grid has ${grid.length} values, axes need ${length}`);
  return grid;
};

/** JSON arrays of `rows`, each below MAX_PARAM_CHARS. */
function chunkJson(rows: unknown[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (cur.length && size + s.length + 1 > MAX_PARAM_CHARS) {
      out.push(`[${cur.join(",")}]`);
      cur = [];
      size = 2;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(",")}]`);
  return out;
}

const axisLength = (a: GridSpec["ev"]) => Math.floor((a.max - a.min) / a.step + 1e-9) + 1;

// ---- priors: the best non-estimator estimate per stat (shared/estimate/prior choosePrior) ----

async function loadPriors(db: D1Database, shipIds: number[]): Promise<PriorTable> {
  const { results } = await db.prepare(
    `SELECT e.ship_id, e.stat, e.value, e.confidence, e.sd, e.n, e.note, e.updated_at, s.key AS source
     FROM estimates e JOIN sources s ON s.id = e.source_id WHERE e.ship_id IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(shipIds)).all<{
    ship_id: number; stat: ShipEstimate["stat"]; value: number; confidence: Confidence; sd: number | null; n: number | null;
    note: string | null; updated_at: string; source: string;
  }>();
  const byShip = new Map<number, ShipEstimate[]>();
  for (const r of results) {
    const list = byShip.get(r.ship_id) ?? [];
    list.push({ stat: r.stat, value: r.value, confidence: r.confidence, sd: r.sd, n: r.n, source: r.source, note: r.note, updatedAt: r.updated_at });
    byShip.set(r.ship_id, list);
  }
  const table: PriorTable = {};
  for (const id of shipIds) {
    const detail = { estimates: byShip.get(id) ?? [], best: {} };
    table[id] = {};
    for (const stat of ESTIMATED_STATS) {
      const p = choosePrior(detail, stat);
      if (p) table[id]![stat] = p;
    }
  }
  return table;
}

// ---- 1. count ----

interface ObsRow {
  id: number; client_id: string; observed_at: string; map_id: number; cell_no: number | null; difficulty: number | null;
  fleet: string | null; enemy: string | null; raw: string | null; quarantine: string | null; bytes: number;
}
interface SiblingRow { id: number; observed_at: string; map_id: number; cell_no: number | null; fleet_deck: number | null; enemy: string | null; path: string; visit: string }

const mapInfo = (mapId: number, cell: number | null, difficulty: number | null, step: number, sortieId?: string) => {
  const key = parseMapKey(String(mapId))!;
  return {
    map: mapName(mapId), area: key.world, mapNo: key.no, cellId: cell ?? 0, node: String(cell ?? 0), difficulty,
    eventId: null, eventKind: null, step, ...(sortieId ? { sortieId } : {}),
  };
};

/**
 * Battle records for one observation. Without a supply snapshot the estimator infers fuel from the earlier
 * battles of the same sortie, so those are added (with no events) in capture order, one step per cell visit
 * (one more D1 call; `siblings` reports it).
 */
async function recordsFor(db: D1Database, o: ObsRow, siblings: () => void): Promise<BattleRecord[]> {
  const raw = JSON.parse(o.raw ?? "{}") as { path: string; visitId: string; sortieId?: string | null; raw: Record<string, unknown> };
  const fleet = o.fleet === null ? null : (JSON.parse(o.fleet) as CapturedFleet);
  const enemy = JSON.parse(o.enemy ?? "null") as CapturedEnemy;
  const events: AttackEvent[] = extractAttackEvents(raw.raw, raw.path);
  let sibs: SiblingRow[] = [];
  if (!fleet?.supply && raw.sortieId) {
    siblings();
    sibs = (await db.prepare(
      `SELECT id, observed_at, map_id, cell_no, json_extract(fleet, '$.deckId') AS fleet_deck, enemy,
         json_extract(raw, '$.path') AS path, json_extract(raw, '$.visitId') AS visit
       FROM observations WHERE client_id = ?1 AND kind = 'battle' AND json_extract(raw, '$.sortieId') = ?2 AND observed_at < ?3 AND id <> ?4
       ORDER BY observed_at`,
    ).bind(o.client_id, raw.sortieId, o.observed_at, o.id).all<SiblingRow>()).results;
  }
  const visits = [...new Set([...sibs.map((s) => s.visit), raw.visitId])];
  const step = (visit: string) => visits.indexOf(visit) + 1;
  const records: BattleRecord[] = sibs.map((s) => ({
    battle: {
      id: `sib-${s.id}`, capturedAt: Date.parse(s.observed_at), path: s.path, visitId: s.visit,
      map: mapInfo(s.map_id, s.cell_no, null, step(s.visit)), fleet: s.fleet_deck == null ? null : { deckId: s.fleet_deck, ships: [] },
      enemy: JSON.parse(s.enemy ?? "null") ?? { ships: [], escort: [], friendFormation: null, enemyFormation: null, engagement: null },
      enemyMasterIds: [], pending: 0, raw: null,
    },
    events: [],
  }));
  const battle: CapturedBattle = {
    id: String(o.id), capturedAt: Date.parse(o.observed_at), path: raw.path, visitId: raw.visitId,
    map: mapInfo(o.map_id, o.cell_no, o.difficulty, step(raw.visitId), raw.sortieId ?? undefined), fleet, enemy,
    enemyMasterIds: [...new Set(enemy.ships.map((s) => s.masterId))], pending: 0, raw: raw.raw,
  };
  records.push({ battle, events });
  return records;
}

const masterIdsOf = (records: BattleRecord[]) => {
  const ships = new Set<number>();
  const equips = new Set<number>();
  for (const { battle: b } of records) {
    for (const s of [...(b.fleet?.ships ?? []), ...(b.fleet?.escort ?? [])]) {
      ships.add(s.masterId);
      for (const e of [...s.equips, s.exSlot ?? null]) if (e) equips.add(e.masterId);
    }
    for (const s of [...b.enemy.ships, ...b.enemy.escort]) {
      ships.add(s.masterId);
      for (const id of s.slots ?? []) if (id > 0) equips.add(id);
    }
    const touch = b.raw && typeof b.raw === "object" ? Reflect.get(b.raw, "api_touch_plane") : null;
    if (Array.isArray(touch)) for (const id of touch) if (typeof id === "number" && id > 0) equips.add(id);
  }
  return { ships, equips };
};

/** Per observation: its processing and its raw read from D1 (COST per KB of the stored row). */
const OBS_KB = COST.estimateKb + COST.d1Kb;
/** A typical stored battle plus its fleet snapshot, in KB (the step needs room for at least one). */
const TYPICAL_OBS_KB = 8;

/** The fit bonus table for counting: `prepare` checks the isolate cache (one query) and returns the cost of `load`. */
interface FitLoader { prepare: () => Promise<number>; load: () => Promise<FitEntry[]> }

/**
 * One count step over the oldest pending observations whose cumulative cost fits (SQLite sums it). Returns false
 * when nothing is pending or the next observation does not fit; it is then counted by a run with more budget left.
 */
async function countStep(db: D1Database, budget: Budget, fit: FitLoader, now: string, totals: EstimatorResult): Promise<boolean> {
  if (!budget.fits(6 * COST.d1Call + COST.estimateStep + COST.estimateObservation + TYPICAL_OBS_KB * OBS_KB, 7)) return false;
  const fixed = 5 * COST.d1Call + COST.estimateStep + (await fit.prepare());
  if (!budget.fits(fixed + COST.estimateObservation + TYPICAL_OBS_KB * OBS_KB, 6)) return false;
  const { results: rows } = await db.prepare(
    `SELECT id, client_id, observed_at, map_id, cell_no, difficulty, fleet, enemy, raw, quarantine, bytes FROM (
       SELECT o.*, length(CAST(o.raw AS BLOB)) + length(CAST(o.fleet AS BLOB)) AS bytes,
         SUM(?1 + ?2 * (length(CAST(o.raw AS BLOB)) + length(CAST(o.fleet AS BLOB))) / 1024.0) OVER (ORDER BY o.id) AS cost
       FROM observations o WHERE o.id IN (SELECT DISTINCT observation_id FROM observation_ships WHERE est_at IS NULL ORDER BY observation_id LIMIT 50))
     WHERE cost <= ?3 ORDER BY id`,
  ).bind(COST.estimateObservation, OBS_KB, budget.left - fixed).all<ObsRow>();
  budget.charge(COST.d1Call, 1);
  if (!rows.length) return false;
  const fitBonuses = await fit.load();
  const { results: pending } = await db.prepare(
    "SELECT observation_id, ship_id FROM observation_ships WHERE est_at IS NULL AND observation_id IN (SELECT value FROM json_each(?1))",
  ).bind(JSON.stringify(rows.map((r) => r.id))).all<{ observation_id: number; ship_id: number }>();
  budget.charge(COST.d1Call, 1);
  const wanted = new Map<string, Set<number>>(); // battleId → pending ships
  for (const p of pending) {
    const k = String(p.observation_id);
    wanted.set(k, (wanted.get(k) ?? new Set()).add(p.ship_id));
  }

  // Observations whose sibling query would exceed the D1 calls stay pending for the next run.
  const done: number[] = [];
  const perObs: BattleRecord[][] = [];
  for (const r of rows) {
    if (!budget.fits(0, 4)) break;
    budget.charge(COST.estimateObservation + OBS_KB * r.bytes / 1024);
    done.push(r.id);
    if (r.quarantine !== null || r.raw === null || r.enemy === null) continue;
    perObs.push(await recordsFor(db, r, () => budget.charge(COST.d1Call, 1)));
  }
  const ids = masterIdsOf(perObs.flat());
  const master = await loadMaster(db, ids.ships, ids.equips);
  budget.charge(2 * COST.d1Call, 2);
  const rolls = perObs.flatMap((records) => {
    const r = buildObservations(records, { master: master.data, lookup: master.lookup, fitBonuses });
    for (const [k, v] of Object.entries(r.skipped)) totals.skipped[k as keyof SkipCounts] = (totals.skipped[k as keyof SkipCounts] ?? 0) + (v ?? 0);
    return r.observations.filter((o) => wanted.get(o.battleId)?.has(o.shipId));
  });

  const counts: [number, ObservationRole, string, number, number, number][] = [];
  for (const [shipId, groups] of groupObservations(rolls)) {
    for (const g of groups.values()) counts.push([shipId, g.obs.role, JSON.stringify(g.obs.query), g.counts.miss, g.counts.hit, g.counts.crit]);
  }
  const chunks = chunkJson(counts);
  budget.charge(COST.d1Call, 1); // the signatures' serialization is part of COST.estimateObservation
  await db.batch([
    ...chunks.map((p) => db.prepare(
      `INSERT INTO estimator_rolls (ship_id, role, sig, miss, hit, crit)
       SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
         json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]')
       FROM json_each(?1) j WHERE true
       ON CONFLICT (ship_id, role, sig) DO UPDATE SET miss = miss + excluded.miss, hit = hit + excluded.hit, crit = crit + excluded.crit`,
    ).bind(p)),
    db.prepare("UPDATE observation_ships SET est_at = ?1 WHERE est_at IS NULL AND observation_id IN (SELECT value FROM json_each(?2))")
      .bind(now, JSON.stringify(done)),
  ]);
  totals.observations += done.length;
  totals.rolls += rolls.length;
  return done.length === rows.length;
}

// ---- 2. fold ----

interface AccumRow { axes: string; grid: string | null; n_ev: number; n_acc: number }

const FOLD_CURSOR = "estimator_fold_cursor";

/**
 * Folds pending signature rows of the next pending (ship, role) into its grid: as many rows as the budget
 * allows, one grid read and one grid write. Returns false when nothing is pending or nothing fits.
 */
async function foldStep(db: D1Database, opts: EstimatorOptions, totals: EstimatorResult): Promise<boolean> {
  const { budget } = opts;
  // grid read + write (base64 ≈ 4/3 × 4 bytes per value, through D1 both ways) and 5 D1 calls (this one included)
  const io = 2 * COST.gridIo + 2 * COST.d1Kb * GRID_KB + 5 * COST.d1Call;
  const perRow = COST.gridCall + 2 * COST.d1Kb; // + the signature (~1-2 KB) read
  if (!budget.fits(io + perRow, 5)) return false;
  // the first key after the cursor, else the first key (two primary-key seeks)
  const head = await db.prepare(
    `SELECT ship_id, role FROM (
       SELECT * FROM (SELECT 0 AS k, r.ship_id, r.role FROM estimator_rolls r, kv_state c
         WHERE c.key = ?1 AND (r.ship_id, r.role) > (json_extract(c.value, '$[0]'), json_extract(c.value, '$[1]')) ORDER BY r.ship_id, r.role LIMIT 1)
       UNION ALL SELECT * FROM (SELECT 1, ship_id, role FROM estimator_rolls ORDER BY ship_id, role LIMIT 1)
     ) ORDER BY k LIMIT 1`,
  ).bind(FOLD_CURSOR).first<{ ship_id: number; role: ObservationRole }>();
  budget.charge(COST.d1Call, 1);
  if (!head) return false;
  const limit = Math.floor((budget.left - (io - COST.d1Call)) / perRow);
  const col = head.role === "evasion" ? "ll_ev" : "ll_acc";
  const [{ results: sigs }, accum] = await Promise.all([
    db.prepare("SELECT sig, miss, hit, crit FROM estimator_rolls WHERE ship_id = ?1 AND role = ?2 ORDER BY sig LIMIT ?3")
      .bind(head.ship_id, head.role, limit).all<{ sig: string; miss: number; hit: number; crit: number }>(),
    db.prepare(`SELECT axes, ${col} AS grid, n_ev, n_acc FROM estimator_accum WHERE ship_id = ?1`).bind(head.ship_id).first<AccumRow>(),
  ]);
  budget.charge(2 * COST.d1Call + COST.gridIo + COST.d1Kb * GRID_KB, 2);
  let axes: GridSpec;
  if (accum) {
    axes = JSON.parse(accum.axes) as GridSpec;
  } else {
    axes = shipPrior((await loadPriors(db, [head.ship_id]))[head.ship_id], DEFAULT_GRID).axes;
    budget.charge(COST.d1Call, 1);
  }
  const [nEv, nAcc, nLuck] = [axisLength(axes.ev), axisLength(axes.acc), axisLength(axes.luck)];
  const mine = decodeGrid(accum?.grid ?? null, head.role === "evasion" ? nEv * nLuck : nLuck * nAcc);
  const state: PosteriorState = {
    llEv: head.role === "evasion" ? mine : new Float64Array(nEv * nLuck),
    llAcc: head.role === "accuracy" ? mine : new Float64Array(nLuck * nAcc),
    nEvasion: accum?.n_ev ?? 0,
    nAccuracy: accum?.n_acc ?? 0,
  };
  const post = newPosterior(axes, opts.epsilon, state);
  const values = { ev: post.ev, acc: post.acc, luck: post.luck };
  const gridFn = opts.gridFn();
  for (const s of sigs) {
    const grid = gridFor(gridFn, JSON.parse(s.sig), head.role, values);
    const c = { miss: s.miss, hit: s.hit, crit: s.crit };
    if (head.role === "evasion") post.addEvasion(grid, c);
    else post.addAccuracy(grid, c);
    budget.charge(perRow);
  }
  const encoded = encodeGrid(head.role === "evasion" ? post.llEv : post.llAcc);
  budget.charge(COST.gridIo + COST.d1Kb * encoded.length / 1024 + COST.d1Call, 1);
  await db.batch([
    db.prepare(
      `INSERT INTO estimator_accum (ship_id, axes, ${col}, n_ev, n_acc, dirty_since, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (ship_id) DO UPDATE SET ${col} = excluded.${col}, n_ev = excluded.n_ev, n_acc = excluded.n_acc,
         dirty_since = COALESCE(estimator_accum.dirty_since, excluded.dirty_since), updated_at = excluded.updated_at`,
    ).bind(head.ship_id, JSON.stringify(axes), encoded, post.nEvasion, post.nAccuracy, new Date(opts.now).toISOString()),
    // the rows read (sig order); the lease keeps other writers out between the read and this batch
    db.prepare("DELETE FROM estimator_rolls WHERE ship_id = ?1 AND role = ?2 AND sig <= ?3").bind(head.ship_id, head.role, sigs.at(-1)!.sig),
    db.prepare("INSERT INTO kv_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(FOLD_CURSOR, JSON.stringify([head.ship_id, head.role])),
  ]);
  totals.gridCalls += sigs.length;
  if (!totals.ships.includes(head.ship_id)) totals.ships.push(head.ship_id);
  return true;
}

// ---- 3. summarize ----

/** ≤ DENSITY_POINTS bins: adjacent grid points summed (step × factor), probabilities rounded to 6 decimals. */
export function compactDensity(d: NonNullable<EstimateResult["density"]>) {
  const f = Math.max(1, Math.ceil(d.posterior.length / DENSITY_POINTS));
  const bin = (p: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < p.length; i += f) out.push(Math.round(p.slice(i, i + f).reduce((s, x) => s + x, 0) * 1e6) / 1e6);
    return out;
  };
  return { min: d.min, step: d.step * f, posterior: bin(d.posterior), prior: bin(d.prior) };
}

/** One ship: marginals, both grids read, and its 3 posterior rows (~2 KB of densities each) written. */
const SUMMARY_COST = COST.summarizeShip + 2 * COST.gridIo + 2 * COST.d1Kb * GRID_KB + COST.d1Kb * 12;

/**
 * Summarizes the dirty ships that fit, oldest change first, once nothing is queued (no staged uploads, pending
 * pairs or rolls) or some ship has been dirty for PUBLISH_EVERY_MS. Then every dirty ship goes, not only the
 * overdue ones, so under a steady stream the ships stay in one cycle and the data version is bumped in a few
 * consecutive runs every PUBLISH_EVERY_MS rather than in every run. Returns how many.
 */
async function summarizeStep(db: D1Database, budget: Budget, now: string, epsilon?: number): Promise<number> {
  const limit = Math.floor((budget.left - 3 * COST.d1Call) / SUMMARY_COST);
  if (limit < 1 || !budget.fits(0, 3)) return 0;
  const cutoff = new Date(Date.parse(now) - PUBLISH_EVERY_MS).toISOString();
  const { results } = await db.prepare(
    `SELECT ship_id, axes, ll_ev, ll_acc, n_ev, n_acc FROM estimator_accum WHERE dirty_since IS NOT NULL
       AND (EXISTS (SELECT 1 FROM estimator_accum WHERE dirty_since <= ?2) OR NOT (EXISTS (SELECT 1 FROM upload_items)
         OR EXISTS (SELECT 1 FROM observation_ships WHERE est_at IS NULL) OR EXISTS (SELECT 1 FROM estimator_rolls)))
     ORDER BY dirty_since, ship_id LIMIT ?1`,
  ).bind(limit, cutoff).all<{ ship_id: number; axes: string; ll_ev: string | null; ll_acc: string | null; n_ev: number; n_acc: number }>();
  budget.charge(COST.d1Call, 1);
  if (!results.length) return 0;
  const priors = await loadPriors(db, results.map((r) => r.ship_id));
  budget.charge(COST.d1Call, 1);
  const rows: Record<string, unknown>[] = [];
  for (const r of results) {
    budget.charge(SUMMARY_COST);
    const axes = JSON.parse(r.axes) as GridSpec;
    const [nEv, nAcc, nLuck] = [axisLength(axes.ev), axisLength(axes.acc), axisLength(axes.luck)];
    const post = newPosterior(axes, epsilon, {
      llEv: decodeGrid(r.ll_ev, nEv * nLuck), llAcc: decodeGrid(r.ll_acc, nLuck * nAcc), nEvasion: r.n_ev, nAccuracy: r.n_acc,
    });
    const sp = shipPrior(priors[r.ship_id], axes);
    for (const e of summarizeShip(r.ship_id, post, sp, { ev: axes.ev.step, acc: axes.acc.step, luck: axes.luck.step })) {
      rows.push({ ship: e.shipId, stat: e.stat, mean: e.mean, sd: e.sd, lo: e.ci90[0], hi: e.ci90[1], n: e.n, prior: e.prior, density: compactDensity(e.density!) });
    }
  }
  const v = (k: string) => `json_extract(j.value, '$.${k}')`;
  const ships = JSON.stringify(results.map((r) => r.ship_id));
  const mine = `ship_id IN (SELECT value FROM json_each(?1))`;
  const note = `'posterior mean; ci90 [' || printf('%.15g', ci_lo) || ', ' || printf('%.15g', ci_hi) || ']; prior '
    || json_extract(prior, '$.source') || ' (' || json_extract(prior, '$.confidence') || ')'`;
  await db.batch([
    db.prepare(
      `INSERT INTO estimator_posteriors (ship_id, stat, mean, sd, ci_lo, ci_hi, n, prior, density, updated_at)
       SELECT ${v("ship")}, ${v("stat")}, ${v("mean")}, ${v("sd")}, ${v("lo")}, ${v("hi")}, ${v("n")}, ${v("prior")}, ${v("density")}, ?2
       FROM json_each(?1) j WHERE true
       ON CONFLICT (ship_id, stat) DO UPDATE SET mean = excluded.mean, sd = excluded.sd, ci_lo = excluded.ci_lo, ci_hi = excluded.ci_hi,
         n = excluded.n, prior = excluded.prior, density = excluded.density, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(rows), now),
    // estimates from the rows just written (the JSON above is bound once)
    db.prepare(
      `INSERT INTO estimates (ship_id, stat, value, confidence, sd, n, source_id, note, updated_at, ci_lo, ci_hi)
       SELECT ship_id, stat, ROUND(mean, 2), 'observed', ROUND(sd, 2), n, ${SRC}, ${note}, ?2, ci_lo, ci_hi
       FROM estimator_posteriors WHERE ${mine} AND n >= ${ESTIMATE_MIN_N} AND true
       ON CONFLICT (ship_id, stat, source_id) DO UPDATE SET value = excluded.value, sd = excluded.sd, n = excluded.n, note = excluded.note,
         updated_at = excluded.updated_at, ci_lo = excluded.ci_lo, ci_hi = excluded.ci_hi`,
    ).bind(ships, now),
    db.prepare(
      `DELETE FROM estimates WHERE source_id = ${SRC} AND (ship_id, stat) IN
         (SELECT ship_id, stat FROM estimator_posteriors WHERE ${mine} AND n < ${ESTIMATE_MIN_N})`,
    ).bind(ships),
    db.prepare(`UPDATE estimator_accum SET dirty_since = NULL WHERE ${mine}`).bind(ships),
    bumpDataVersion(db),
  ]);
  budget.charge(COST.d1Call + COST.d1Kb * rows.length * 2, 1);
  return results.length;
}

// ---- entry point ----

/**
 * The fit bonus table, kept per isolate: it only changes when scripts/ingest-fit-bonuses.ts runs, which updates
 * the source's fetched_at (part of the stamp, with the row count).
 */
let fitCache: { stamp: string; entries: FitEntry[] } | null = null;
/** Drops the cached fit bonus table (benchmarks replay invocations as if each ran in a fresh isolate). */
export const clearFitBonusCache = () => {
  fitCache = null;
};

/** One budgeted estimator run (jobs stage and POST /admin/estimate/run): count, fold, summarize. */
export async function runEstimator(db: D1Database, opts: EstimatorOptions): Promise<EstimatorResult> {
  const now = new Date(opts.now).toISOString();
  const result: EstimatorResult = { observations: 0, rolls: 0, gridCalls: 0, ships: [], summarized: 0, skipped: {} };
  let stamp: string | null = null;
  const loader: FitLoader = {
    prepare: async () => {
      if (stamp === null) {
        const s = await db.prepare(
          "SELECT (SELECT fetched_at FROM sources WHERE key = 'kcr-slotitem-bonus') AS at, (SELECT COUNT(*) FROM fit_bonuses) AS n",
        ).first<{ at: string | null; n: number }>();
        opts.budget.charge(COST.d1Call, 1);
        stamp = `${s?.at}|${s?.n}`;
      }
      return fitCache?.stamp === stamp ? 0 : COST.fitBonuses + COST.d1Call;
    },
    load: async () => {
      if (fitCache?.stamp !== stamp) {
        fitCache = { stamp: stamp!, entries: await loadFitBonuses(db) };
        opts.budget.charge(COST.fitBonuses + COST.d1Call, 1);
      }
      return fitCache.entries;
    },
  };
  // Counting is cheap and keeps the queue of observations short; folding gets what is left, summaries last.
  while (await countStep(db, opts.budget, loader, now, result)) { /* until the budget or the queue ends */ }
  while (await foldStep(db, opts, result)) { /* ditto */ }
  result.summarized = await summarizeStep(db, opts.budget, now, opts.epsilon);
  result.ships.sort((a, b) => a - b);
  return result;
}

/** Queue sizes for the admin status and run responses. */
export async function estimatorBacklog(db: D1Database) {
  const r = await db.prepare(
    `SELECT (SELECT COUNT(DISTINCT observation_id) FROM observation_ships WHERE est_at IS NULL) AS observations,
       (SELECT COUNT(*) FROM estimator_rolls) AS signatures, (SELECT COUNT(*) FROM estimator_accum WHERE dirty_since IS NOT NULL) AS dirtyShips`,
  ).first<{ observations: number; signatures: number; dirtyShips: number }>();
  return r ?? { observations: 0, signatures: 0, dirtyShips: 0 };
}

/**
 * Forgets the grids, pending rolls and posteriors of `shipIds` (all ships when null) and re-queues their remaining
 * observations, e.g. after observations were deleted or to rebuild with new priors / grid axes.
 */
export function resetShipsStatements(db: D1Database, shipIds: number[] | null): D1PreparedStatement[] {
  const ids = shipIds === null ? null : JSON.stringify(shipIds);
  const inShips = "(?1 IS NULL OR ship_id IN (SELECT value FROM json_each(?1)))";
  return [
    db.prepare(`DELETE FROM estimator_accum WHERE ${inShips}`).bind(ids),
    db.prepare(`DELETE FROM estimator_rolls WHERE ${inShips}`).bind(ids),
    db.prepare(`DELETE FROM estimator_posteriors WHERE ${inShips}`).bind(ids),
    db.prepare(`DELETE FROM estimates WHERE source_id = ${SRC} AND ${inShips}`).bind(ids),
    db.prepare(`UPDATE observation_ships SET est_at = NULL WHERE ${inShips}`).bind(ids),
    bumpDataVersion(db),
  ];
}

/** Removes a client's observations from the estimator: drops their queue rows and resets the ships they fed. */
export async function forgetClientObservations(db: D1Database, clientId: string): Promise<number[]> {
  const sub = "SELECT id FROM observations WHERE client_id = ?1";
  const { results } = await db.prepare(`SELECT DISTINCT ship_id FROM observation_ships WHERE observation_id IN (${sub})`)
    .bind(clientId).all<{ ship_id: number }>();
  const ships = results.map((r) => r.ship_id);
  await db.batch([
    db.prepare(`DELETE FROM observation_ships WHERE observation_id IN (${sub})`).bind(clientId),
    ...(ships.length ? resetShipsStatements(db, ships) : []),
  ]);
  return ships;
}
