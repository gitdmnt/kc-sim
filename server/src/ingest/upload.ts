// POST /api/v1/observations (private notes API §3) in two halves, so that the request does bounded work:
// - stageUpload (the request): one D1 batch in which SQLite checks the body's JSON and splits it into
//   upload_items rows. The worker never parses the body.
// - ingestPending (the jobs run, budgeted): per staged item size and schema checks, re-derivation and validation
//   (validate.ts), then one multi-row INSERT per table through json_each; the batch also deletes the items.
import { BACKLOG_COUNT_CAP, COST, type Budget } from "../budget";
import { layoutKey } from "../observed/aggregate";
import { loadMaster } from "../master";
import { observationInput, type ObservationInput } from "../schemas";
import { referencedIds, validateObservation, type Finding, type MapGraph } from "./validate";

/** Request body limit: ~60 battles. Larger bodies get 413 before they are read. */
export const MAX_BODY_BYTES = 256 * 1024;
/** One observation (its JSON as uploaded); larger ones are rejected with rule `too_large`. */
export const MAX_ITEM_BYTES = 64 * 1024;
export const MAX_OBSERVATIONS_PER_REQUEST = 100;

/** Bound JSON parameters stay below D1's 2 MB value limit. */
const MAX_PARAM_BYTES = 900_000;

/**
 * Write quotas. A client may stage CLIENT_DAY_ITEMS items / CLIENT_DAY_BYTES bytes per rolling 24 h window (a heavy
 * player uploads a few hundred battles a day, ~8 KB each); the whole backlog is capped at STAGED_MAX_ITEMS /
 * STAGED_MAX_BYTES (several days of ingest), beyond which uploads get 503 until the jobs catch up.
 */
export const QUOTA_WINDOW_MS = 24 * 60 * 60_000;
export const CLIENT_DAY_ITEMS = 3000;
export const CLIENT_DAY_BYTES = 32 * 1024 * 1024;
export const STAGED_MAX_ITEMS = 20_000;
export const STAGED_MAX_BYTES = 256 * 1024 * 1024;

export type QuotaVerdict = { ok: true } | { ok: false; status: 429 | 503; retryAfter: number; error: string };

/** Whether `clientId` may stage another upload now (its 24 h quota, the global backlog cap). */
export async function checkQuota(db: D1Database, clientId: string, now: number): Promise<QuotaVerdict> {
  const r = await db.prepare(
    `SELECT quota_start, quota_items, quota_bytes,
       (SELECT CAST(value AS INTEGER) FROM kv_state WHERE key = 'staged_items') AS si,
       (SELECT CAST(value AS INTEGER) FROM kv_state WHERE key = 'staged_bytes') AS sb
     FROM clients WHERE id = ?1`,
  ).bind(clientId).first<{ quota_start: number; quota_items: number; quota_bytes: number; si: number | null; sb: number | null }>();
  if (!r) return { ok: true };
  if ((r.si ?? 0) >= STAGED_MAX_ITEMS || (r.sb ?? 0) >= STAGED_MAX_BYTES) {
    return { ok: false, status: 503, retryAfter: 3600, error: "upload backlog is full; try again later" };
  }
  const fresh = r.quota_start <= now - QUOTA_WINDOW_MS;
  if (!fresh && (r.quota_items >= CLIENT_DAY_ITEMS || r.quota_bytes >= CLIENT_DAY_BYTES)) {
    const retryAfter = Math.max(1, Math.ceil((r.quota_start + QUOTA_WINDOW_MS - now) / 1000));
    return { ok: false, status: 429, retryAfter, error: `daily upload quota reached (${CLIENT_DAY_ITEMS} observations / ${CLIENT_DAY_BYTES >> 20} MiB per 24 h)` };
  }
  return { ok: true };
}

/** Exact staged backlog counters (after ingest and purges; staging only adds to them). */
export const recountStaged = (db: D1Database): D1PreparedStatement[] => [
  db.prepare("UPDATE kv_state SET value = (SELECT COUNT(*) FROM upload_items) WHERE key = 'staged_items'"),
  db.prepare("UPDATE kv_state SET value = (SELECT COALESCE(SUM(bytes), 0) FROM upload_items) WHERE key = 'staged_bytes'"),
];

/** JSON arrays of `rows`, each at most MAX_PARAM_BYTES serialized. */
function chunkJson(rows: unknown[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (cur.length && size + s.length + 1 > MAX_PARAM_BYTES / 3) { // UTF-16 length; ≤ 3 UTF-8 bytes per unit
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

// ---- the request: staging ----

export type StageResult =
  | { ok: true; queued: number; duplicates: number; pending: number }
  | { ok: false; error: "not_json" | "envelope"; observations: number | null };

const ITEM_ID = "json_extract(j.value, '$.clientObsId')";
const STAGE_ITEMS = `INSERT INTO upload_items (client_id, client_obs_id, received_at, item, bytes)
  SELECT ?1, CASE WHEN json_type(j.value, '$.clientObsId') = 'text' AND length(${ITEM_ID}) BETWEEN 1 AND 100 THEN ${ITEM_ID} END,
    ?2, j.value, length(CAST(j.value AS BLOB))
  FROM upload_bodies b, json_each(CASE WHEN json_valid(b.body) THEN b.body ELSE '{}' END, '$.observations') j
  WHERE b.id = (SELECT MAX(id) FROM upload_bodies)
    AND CASE WHEN json_valid(b.body) AND json_type(b.body, '$.observations') = 'array' THEN json_array_length(b.body, '$.observations') END BETWEEN 1 AND ?3
    AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.client_id = ?1 AND o.client_obs_id = ${ITEM_ID})
  ON CONFLICT (client_id, client_obs_id) DO NOTHING`;

const MINE = "FROM upload_items WHERE client_id = ?1 AND received_at = ?2";

/**
 * Stages one upload in one D1 call: the body is bound once, SQLite validates it as JSON, counts the items and
 * stores each as an upload_items row. Items already stored or already staged for this client are duplicates.
 */
export async function stageUpload(db: D1Database, clientId: string, body: string, now: number): Promise<StageResult> {
  const at = new Date(now).toISOString();
  const [, staged, envelope, , pending] = await db.batch<{ valid?: number; n?: number | null }>([
    db.prepare("INSERT INTO upload_bodies (body) VALUES (?1)").bind(body),
    db.prepare(STAGE_ITEMS).bind(clientId, at, MAX_OBSERVATIONS_PER_REQUEST),
    db.prepare(`SELECT json_valid(body) AS valid, CASE WHEN json_valid(body) AND json_type(body, '$.observations') = 'array'
      THEN json_array_length(body, '$.observations') END AS n FROM upload_bodies WHERE id = (SELECT MAX(id) FROM upload_bodies)`),
    db.prepare("DELETE FROM upload_bodies"),
    db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM upload_items LIMIT ${BACKLOG_COUNT_CAP})`),
    // this request's items count against the client's 24 h quota and the global backlog counters
    db.prepare(`UPDATE clients SET
        quota_items = CASE WHEN quota_start <= ?3 - ?4 THEN 0 ELSE quota_items END + (SELECT COUNT(*) ${MINE}),
        quota_bytes = CASE WHEN quota_start <= ?3 - ?4 THEN 0 ELSE quota_bytes END + (SELECT COALESCE(SUM(bytes), 0) ${MINE}),
        quota_start = CASE WHEN quota_start <= ?3 - ?4 THEN ?3 ELSE quota_start END
      WHERE id = ?1`).bind(clientId, at, now, QUOTA_WINDOW_MS),
    db.prepare(`UPDATE kv_state SET value = CAST(value AS INTEGER) + (SELECT COUNT(*) ${MINE}) WHERE key = 'staged_items'`).bind(clientId, at),
    db.prepare(`UPDATE kv_state SET value = CAST(value AS INTEGER) + (SELECT COALESCE(SUM(bytes), 0) ${MINE}) WHERE key = 'staged_bytes'`).bind(clientId, at),
  ]);
  const env = envelope?.results[0];
  if (!env?.valid) return { ok: false, error: "not_json", observations: null };
  const n = env.n ?? null;
  if (n === null || n < 1 || n > MAX_OBSERVATIONS_PER_REQUEST) return { ok: false, error: "envelope", observations: n };
  const queued = staged?.meta.changes ?? 0;
  return { ok: true, queued, duplicates: n - queued, pending: pending?.results[0]?.n ?? 0 };
}

export interface IngestResult { ingested: number; duplicates: number; rejected: number; flagged: number; quarantined: number; remaining: number }

async function loadGraphs(db: D1Database, mapIds: number[]): Promise<Map<number, MapGraph>> {
  const ids = JSON.stringify(mapIds);
  const inMaps = "IN (SELECT value FROM json_each(?1))";
  const [maps, edges, cells] = await Promise.all([
    db.prepare(`SELECT id, is_event FROM maps WHERE id ${inMaps}`).bind(ids).all<{ id: number; is_event: number }>(),
    db.prepare(`SELECT map_id, edge_id, from_letter, to_letter FROM edges WHERE map_id ${inMaps}`).bind(ids)
      .all<{ map_id: number; edge_id: number; from_letter: string; to_letter: string }>(),
    db.prepare(`SELECT DISTINCT map_id, cell_no FROM poi_cells WHERE map_id ${inMaps}`).bind(ids).all<{ map_id: number; cell_no: number }>(),
  ]);
  const out = new Map<number, MapGraph>(maps.results.map((m) => [m.id, { isEvent: !!m.is_event, edges: new Map(), observedCells: new Set() }]));
  for (const e of edges.results) out.get(e.map_id)?.edges.set(e.edge_id, { from: e.from_letter, to: e.to_letter });
  for (const c of cells.results) out.get(c.map_id)?.observedCells.add(c.cell_no);
  return out;
}

/** Day battle responses by visitId: from these observations, else from the client's stored observations. */
async function dayPackets(db: D1Database, clientId: string, obs: ObservationInput[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const o of obs) if (o.kind === "battle" && o.raw.path === "api_req_sortie/battle") out.set(o.raw.visitId, o.raw.raw);
  const missing = obs.flatMap((o) => (o.kind === "battle" && o.raw.path === "api_req_battle_midnight/battle" && !out.has(o.raw.visitId) ? [o.raw.visitId] : []));
  if (missing.length) {
    const { results } = await db.prepare(
      `SELECT json_extract(raw, '$.visitId') AS visit, json_extract(raw, '$.raw') AS packet FROM observations
       WHERE client_id = ?1 AND kind = 'battle' AND json_extract(raw, '$.path') = 'api_req_sortie/battle'
         AND json_extract(raw, '$.visitId') IN (SELECT value FROM json_each(?2))`,
    ).bind(clientId, JSON.stringify(missing)).all<{ visit: string; packet: string }>();
    for (const r of results) out.set(r.visit, JSON.parse(r.packet));
  }
  return out;
}

const INSERT_OBSERVATIONS = `INSERT INTO observations (client_id, client_obs_id, observed_at, map_id, node_letter, difficulty, kind, fleet, enemy,
    raw, uploaded_at, cell_no, layout, sortie, quarantine)
  SELECT ?1, json_extract(j.value, '$.id'), json_extract(j.value, '$.observedAt'), json_extract(j.value, '$.map'),
    COALESCE((SELECT to_letter FROM edges WHERE map_id = json_extract(j.value, '$.map') AND edge_id = json_extract(j.value, '$.cell')),
      CAST(json_extract(j.value, '$.cell') AS TEXT)),
    json_extract(j.value, '$.difficulty'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.fleet'), json_extract(j.value, '$.enemy'),
    json_extract(j.value, '$.raw'), json_extract(j.value, '$.uploadedAt'), json_extract(j.value, '$.cell'), json_extract(j.value, '$.layout'),
    json_extract(j.value, '$.sortie'), json_extract(j.value, '$.quarantine')
  FROM json_each(?2) j WHERE true
  ON CONFLICT (client_id, client_obs_id) DO NOTHING`;

// Rows stored by this batch are the ones whose uploaded_at is their item's request time (duplicates keep theirs).
const FRESH = "o.client_id = ?1 AND o.client_obs_id = json_extract(j.value, '$.id') AND o.uploaded_at = json_extract(j.value, '$.uploadedAt')";

const INSERT_SHIPS = `INSERT INTO observation_ships (observation_id, ship_id)
  SELECT o.id, s.value FROM json_each(?2) j JOIN observations o ON ${FRESH} AND o.quarantine IS NULL, json_each(json_extract(j.value, '$.ships')) s
  WHERE true ON CONFLICT DO NOTHING`;

const INSERT_FINDINGS = `INSERT INTO observation_rejections (client_id, client_obs_id, kind, map_id, rule, action, detail, observation_id, created_at)
  SELECT ?1, json_extract(j.value, '$.id'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.map'), json_extract(j.value, '$.rule'),
    json_extract(j.value, '$.action'), json_extract(j.value, '$.detail'), (SELECT o.id FROM observations o WHERE ${FRESH}), ?3
  FROM json_each(?2) j
  WHERE json_extract(j.value, '$.action') = 'reject' OR EXISTS (SELECT 1 FROM observations o WHERE ${FRESH})`;

interface StagedRow { id: number; client_obs_id: string | null; received_at: string; item: string; bytes: number }
type Located = Finding & { id: string | null; kind: string | null; map: number | null; uploadedAt: string };

/** Validates and stores staged items of one client, deleting them in the same batch. */
async function ingestItems(db: D1Database, clientId: string, staged: StagedRow[], now: number, budget: Budget) {
  const findings: Located[] = [];
  const parsed: { o: ObservationInput; uploadedAt: string }[] = [];
  for (const s of staged) {
    const at = { id: s.client_obs_id, kind: null, map: null, uploadedAt: s.received_at };
    if (s.bytes > MAX_ITEM_BYTES) {
      findings.push({ ...at, rule: "too_large", action: "reject", detail: `observation is ${s.bytes} bytes (max ${MAX_ITEM_BYTES})` });
      continue;
    }
    const r = observationInput.safeParse(JSON.parse(s.item));
    if (!r.success) {
      const detail = r.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");
      findings.push({ ...at, rule: "schema", action: "reject", detail });
      continue;
    }
    parsed.push({ o: r.data, uploadedAt: s.received_at });
  }

  const obs = parsed.map((p) => p.o);
  const ids = referencedIds(obs);
  const [master, graphs, days] = await Promise.all([
    loadMaster(db, ids.ships, ids.equips),
    loadGraphs(db, [...ids.maps]),
    dayPackets(db, clientId, obs),
  ]);
  budget.charge(0, 6);
  const ctx = { now, master, maps: graphs, dayPacket: (v: string) => days.get(v) };
  const rows: Record<string, unknown>[] = [];
  const ships: { id: string; uploadedAt: string; ships: number[] }[] = [];
  let quarantined = 0;
  for (const { o, uploadedAt } of parsed) {
    const { findings: f, derived } = validateObservation(o, ctx);
    const meta = { id: o.clientObsId, kind: o.kind, map: o.map, uploadedAt };
    const rejects = f.filter((x) => x.action === "reject");
    if (rejects.length) {
      findings.push(...rejects.map((x) => ({ ...meta, ...x })));
      continue;
    }
    findings.push(...f.map((x) => ({ ...meta, ...x })));
    const quarantine = [...new Set(f.filter((x) => x.action === "quarantine").map((x) => x.rule))].join(",") || null;
    if (quarantine) quarantined++;
    rows.push({
      id: o.clientObsId, uploadedAt, observedAt: new Date(o.observedAt).toISOString(), map: o.map, kind: o.kind,
      difficulty: o.difficulty ?? null, fleet: o.fleet ?? null, layout: layoutKey(derived.layout), quarantine,
      ...(o.kind === "battle"
        ? { cell: o.cell, enemy: derived.enemy, raw: { path: o.raw.path, visitId: o.raw.visitId, sortieId: o.raw.sortieId ?? null, raw: o.raw.raw, result: o.raw.result ?? null } }
        : { cell: null, sortie: derived.sortie, raw: o.raw ?? null }),
    });
    if (!quarantine && derived.estimableShips.length) ships.push({ id: o.clientObsId, uploadedAt, ships: derived.estimableShips });
  }

  const processedAt = new Date(now).toISOString();
  const findingRows = findings.map((f) => ({ id: f.id, uploadedAt: f.uploadedAt, kind: f.kind, map: f.map, rule: f.rule, action: f.action, detail: f.detail.slice(0, 500) }));
  const obsChunks = chunkJson(rows);
  const res = await db.batch([
    ...obsChunks.map((p) => db.prepare(INSERT_OBSERVATIONS).bind(clientId, p)),
    ...chunkJson(ships).map((p) => db.prepare(INSERT_SHIPS).bind(clientId, p)),
    ...chunkJson(findingRows).map((p) => db.prepare(INSERT_FINDINGS).bind(clientId, p, processedAt)),
    db.prepare("DELETE FROM upload_items WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(staged.map((s) => s.id))),
  ]);
  budget.charge(0, 1);
  const ingested = res.slice(0, obsChunks.length).reduce((s, r) => s + (r.meta.changes ?? 0), 0);
  return {
    ingested, duplicates: rows.length - ingested, rejected: findings.filter((f) => f.action === "reject").length,
    flagged: findings.filter((f) => f.action === "flag").length, quarantined,
  };
}

/**
 * Jobs step: validates and stores staged upload items, oldest first, one client at a time, while the budget
 * lasts. SQLite picks the items whose cumulative cost (COST.ingestItem + COST.ingestKb per KB) fits.
 */
export async function ingestPending(db: D1Database, budget: Budget, now: number): Promise<IngestResult> {
  const out: IngestResult = { ingested: 0, duplicates: 0, rejected: 0, flagged: 0, quarantined: 0, remaining: 0 };
  // per item: its processing plus reading it from D1 and writing its rows back (≈ its size twice)
  const perKb = COST.ingestKb + 2 * COST.d1Kb;
  const largest = COST.ingestGroup + 3 * COST.d1Call + COST.ingestItem + perKb * (MAX_ITEM_BYTES / 1024);
  while (budget.fits(largest, 8)) {
    const left = budget.left - COST.ingestGroup - 3 * COST.d1Call;
    const { results } = await db.prepare(
      `SELECT id, client_id, client_obs_id, received_at, item, bytes FROM (
         SELECT *, SUM(?1 + ?2 * bytes / 1024.0) OVER (ORDER BY id) AS cost FROM (
           SELECT * FROM upload_items WHERE client_id = (SELECT client_id FROM upload_items ORDER BY id LIMIT 1) ORDER BY id LIMIT ?4))
       WHERE cost <= ?3 OR id = (SELECT MIN(id) FROM upload_items) ORDER BY id`,
    ).bind(COST.ingestItem, perKb, left, MAX_OBSERVATIONS_PER_REQUEST).all<StagedRow & { client_id: string }>();
    budget.charge(COST.d1Call, 1);
    if (!results.length) break;
    budget.charge(COST.ingestGroup + 2 * COST.d1Call + results.reduce((s, r) => s + COST.ingestItem + perKb * r.bytes / 1024, 0));
    const r = await ingestItems(db, results[0]!.client_id, results, now, budget);
    out.ingested += r.ingested;
    out.duplicates += r.duplicates;
    out.rejected += r.rejected;
    out.flagged += r.flagged;
    out.quarantined += r.quarantined;
  }
  out.remaining = (await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM upload_items LIMIT ${BACKLOG_COUNT_CAP})`).first<{ n: number }>())?.n ?? 0;
  budget.charge(COST.d1Call, 1);
  if (out.ingested + out.duplicates + out.rejected > 0) {
    await db.batch(recountStaged(db));
    budget.charge(COST.d1Call, 1);
  }
  return out;
}
