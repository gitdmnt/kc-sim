// Re-validation of stored observations (POST /admin/observations/revalidate): the current rules of validate.ts and
// the battle ↔ sortie linkage of upload.ts, applied to rows stored under older rules. A row whose verdict changes gets
// its new quarantine (a rule that now rejects quarantines: stored rows are kept); the aggregates of the affected maps
// and the estimator state of the affected ships are reset, and the next jobs run refolds them.
import { resetShipsStatements } from "../estimator/job";
import { loadMaster } from "../master";
import { layoutKey, resetStatements } from "../observed/aggregate";
import { observationInput, type ObservationInput } from "../schemas";
import { dayPackets, loadGraphs, UNLINKED } from "./upload";
import { referencedIds, validateObservation } from "./validate";

interface StoredRow {
  id: number; client_id: string; client_obs_id: string; observed_at: string; uploaded_at: string; map_id: number; cell_no: number | null;
  difficulty: number | null; kind: string; fleet: string | null; raw: string | null; layout: string | null; sortie: string | null; quarantine: string | null;
}

export interface RevalidateResult {
  checked: number;
  /** rows whose quarantine changed */
  changed: number;
  /** cursor for the next page (null: done) */
  next: number | null;
  maps: number[];
  ships: number[];
}

const parse = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));

/** The upload item a stored row was made from (as far as validation reads it). */
function inputOf(r: StoredRow): ObservationInput | null {
  const base = {
    clientObsId: r.client_obs_id, observedAt: r.observed_at, map: r.map_id, difficulty: r.difficulty,
    layout: r.layout ? r.layout.split(",").map(Number) : null, fleet: parse(r.fleet),
  };
  const item = r.kind === "battle"
    ? { ...base, kind: "battle", cell: r.cell_no, raw: parse(r.raw) }
    : { ...base, kind: "sortie", sortie: parse(r.sortie), raw: parse(r.raw) };
  const p = observationInput.safeParse(item);
  return p.success ? p.data : null;
}

/** Re-validates up to `limit` stored observations with id > `after`. */
export async function revalidate(db: D1Database, after: number, limit: number): Promise<RevalidateResult> {
  const { results: rows } = await db.prepare(
    `SELECT id, client_id, client_obs_id, observed_at, uploaded_at, map_id, cell_no, difficulty, kind, fleet, raw, layout, sortie, quarantine
     FROM observations WHERE id > ?1 ORDER BY id LIMIT ?2`,
  ).bind(after, limit).all<StoredRow>();
  const out: RevalidateResult = { checked: rows.length, changed: 0, next: rows.length === limit ? rows.at(-1)!.id : null, maps: [], ships: [] };
  if (!rows.length) return out;
  const inputs = rows.map(inputOf);
  const obs = inputs.filter((o): o is ObservationInput => o !== null);
  const ids = referencedIds(obs);
  const [master, graphs] = await Promise.all([loadMaster(db, ids.ships, ids.equips), loadGraphs(db, [...ids.maps])]);
  const clients = [...new Set(rows.map((r) => r.client_id))];
  const days = new Map<string, Map<string, Record<string, unknown>>>();
  for (const c of clients) days.set(c, await dayPackets(db, c, obs.filter((_, i) => rows[i]!.client_id === c)));
  // sorties that can link battles: the clients' stored unquarantined ones
  const wanted = obs.flatMap((o) => (o.kind === "battle" && o.raw.sortieId ? [o.raw.sortieId] : []));
  const { results: sortieRows } = await db.prepare(
    `SELECT client_id, client_obs_id, sortie, layout FROM observations
     WHERE kind = 'sortie' AND quarantine IS NULL AND sortie IS NOT NULL AND client_id IN (SELECT value FROM json_each(?1))
       AND client_obs_id IN (SELECT value FROM json_each(?2))`,
  ).bind(JSON.stringify(clients), JSON.stringify([...new Set(wanted)])).all<{ client_id: string; client_obs_id: string; sortie: string; layout: string | null }>();
  const sorties = new Map(sortieRows.map((s) => [`${s.client_id}|${s.client_obs_id}`, { cells: (JSON.parse(s.sortie) as { cells: { no: number; battles: string[] }[] }).cells, layout: s.layout ?? "" }]));

  const updates: { id: number; quarantine: string | null; layout: string | null; ships: number[] }[] = [];
  rows.forEach((r, i) => {
    const o = inputs[i];
    let quarantine: string | null;
    let layout = r.layout;
    let ships: number[] = [];
    if (!o) quarantine = "schema";
    else {
      const ctx = { now: Date.parse(r.uploaded_at), master, maps: graphs, dayPacket: (v: string) => days.get(r.client_id)?.get(v) };
      const { findings, derived } = validateObservation(o, ctx);
      const rules = findings.filter((f) => f.action !== "flag").map((f) => f.rule);
      if (o.kind === "battle") {
        const s = o.raw.sortieId ? sorties.get(`${r.client_id}|${o.raw.sortieId}`) : undefined;
        if (s && s.cells.some((c) => c.no === o.cell && c.battles.includes(o.clientObsId))) layout = s.layout;
        else rules.push(UNLINKED);
      } else layout = layoutKey(derived.layout);
      quarantine = [...new Set(rules)].join(",") || null;
      if (!quarantine || quarantine === UNLINKED) ships = derived.estimableShips;
    }
    if (quarantine !== r.quarantine || layout !== r.layout) updates.push({ id: r.id, quarantine, layout, ships });
  });
  if (!updates.length) return out;
  const changed = rows.filter((r) => updates.some((u) => u.id === r.id));
  const { results: queued } = await db.prepare("SELECT DISTINCT ship_id FROM observation_ships WHERE observation_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(changed.map((r) => r.id))).all<{ ship_id: number }>();
  out.changed = updates.length;
  out.maps = [...new Set(changed.map((r) => r.map_id))].sort((a, b) => a - b);
  out.ships = [...new Set([...queued.map((q) => q.ship_id), ...updates.flatMap((u) => u.ships)])].sort((a, b) => a - b);
  const json = JSON.stringify(updates);
  await db.batch([
    db.prepare(`UPDATE observations SET
        quarantine = (SELECT json_extract(j.value, '$.quarantine') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = observations.id),
        layout = (SELECT json_extract(j.value, '$.layout') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = observations.id)
      WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`).bind(json),
    // the estimator queue follows the new verdicts: rows of now-quarantined observations go, usable ones are queued
    db.prepare("DELETE FROM observation_ships WHERE observation_id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))").bind(json),
    db.prepare(`INSERT INTO observation_ships (observation_id, ship_id)
      SELECT json_extract(j.value, '$.id'), s.value FROM json_each(?1) j, json_each(json_extract(j.value, '$.ships')) s WHERE true ON CONFLICT DO NOTHING`).bind(json),
    ...resetStatements(db, out.maps),
    ...(out.ships.length ? resetShipsStatements(db, out.ships) : []),
  ]);
  return out;
}
