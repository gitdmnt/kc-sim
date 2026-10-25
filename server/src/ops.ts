// Write-side operations: purging clients (with their data) and the write statistics behind the alerts of the jobs
// run (scripts/run-jobs.ts alerts) and GET /admin/writes/status.
import { forgetClientObservations } from "./estimator/job";
import { deleteClientObservations } from "./observed/aggregate";

/** At most this many clients per purge request (each costs a few D1 calls and resets the maps it touched). */
export const MAX_PURGE_CLIENTS = 100;

export interface PurgeResult { clients: number; deleted: number; maps: number[]; estimatorReset: number[]; banned: boolean }

/**
 * Deletes everything `clientIds` uploaded (staged items, observations, validation records), resets the aggregates
 * of the maps and the estimator state of the ships they touched (the next jobs run refolds what remains), then
 * bans the clients (their tokens get 403) or, with `ban: false`, deletes them (their tokens get 401).
 */
export async function purgeClients(db: D1Database, clientIds: string[], o: { ban: boolean; reason: string | null; now: string }): Promise<PurgeResult> {
  const maps = new Set<number>();
  const ships = new Set<number>();
  let deleted = 0;
  for (const id of clientIds) {
    for (const s of await forgetClientObservations(db, id)) ships.add(s);
    const r = await deleteClientObservations(db, id);
    deleted += r.deleted;
    for (const m of r.maps) maps.add(m);
  }
  const ids = JSON.stringify(clientIds);
  await db.batch([
    db.prepare("DELETE FROM observation_rejections WHERE client_id IN (SELECT value FROM json_each(?1))").bind(ids),
    o.ban
      ? db.prepare("UPDATE clients SET banned_at = COALESCE(banned_at, ?2), ban_reason = ?3 WHERE id IN (SELECT value FROM json_each(?1))").bind(ids, o.now, o.reason)
      : db.prepare("DELETE FROM clients WHERE id IN (SELECT value FROM json_each(?1))").bind(ids),
  ]);
  const sort = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { clients: clientIds.length, deleted, maps: sort(maps), estimatorReset: sort(ships), banned: o.ban };
}

/** Alert thresholds over the last 24 h (and the current backlog). */
export const ALERTS = {
  newClients: 20,
  newClientAddresses: 10,
  stagedItems: 5000,
  stagedBytes: 64 * 1024 * 1024,
  /** items of the busiest client in its current 24 h quota window */
  topClientItems: 2000,
  /** rejected / (stored + rejected), once at least `minProcessed` items were processed */
  rejectShare: 0.3,
  minProcessed: 200,
};

export interface WriteStats {
  newClients: number; newClientAddresses: number; probation: number; banned: number;
  stagedItems: number; stagedBytes: number; topClientItems: number;
  stored: number; rejected: number; quarantined: number;
}

/** Write statistics of the 24 h before `now` and the alerts they trip (empty: all quiet). */
export async function writeStats(db: D1Database, now: number): Promise<{ stats: WriteStats; alerts: string[] }> {
  const since = now - 24 * 60 * 60_000;
  const iso = new Date(since).toISOString();
  const r = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM clients WHERE created_at > ?1) AS newClients,
       (SELECT COUNT(DISTINCT ip_hash) FROM clients WHERE created_at > ?1) AS newClientAddresses,
       (SELECT COUNT(*) FROM clients WHERE trusted_at IS NULL AND banned_at IS NULL) AS probation,
       (SELECT COUNT(*) FROM clients WHERE banned_at IS NOT NULL) AS banned,
       (SELECT CAST(value AS INTEGER) FROM kv_state WHERE key = 'staged_items') AS stagedItems,
       (SELECT CAST(value AS INTEGER) FROM kv_state WHERE key = 'staged_bytes') AS stagedBytes,
       (SELECT COALESCE(MAX(quota_items), 0) FROM clients WHERE quota_start > ?1) AS topClientItems,
       (SELECT COUNT(*) FROM observations WHERE uploaded_at > ?2) AS stored,
       (SELECT COUNT(*) FROM observation_rejections WHERE created_at > ?2 AND action = 'reject') AS rejected,
       (SELECT COUNT(*) FROM observation_rejections WHERE created_at > ?2 AND action = 'quarantine' AND rule <> 'unlinked') AS quarantined`,
  ).bind(since, iso).first<WriteStats>();
  const stats = r!;
  const a = ALERTS;
  const processed = stats.stored + stats.rejected;
  const alerts = [
    stats.newClients > a.newClients && `${stats.newClients} clients registered in 24 h (> ${a.newClients})`,
    stats.newClientAddresses > a.newClientAddresses && `${stats.newClientAddresses} addresses registered clients in 24 h (> ${a.newClientAddresses})`,
    (stats.stagedItems ?? 0) > a.stagedItems && `${stats.stagedItems} staged items waiting (> ${a.stagedItems})`,
    (stats.stagedBytes ?? 0) > a.stagedBytes && `${Math.round((stats.stagedBytes ?? 0) / 2 ** 20)} MiB staged (> ${a.stagedBytes / 2 ** 20} MiB)`,
    stats.topClientItems > a.topClientItems && `one client staged ${stats.topClientItems} items in its quota window (> ${a.topClientItems})`,
    processed >= a.minProcessed && stats.rejected / processed > a.rejectShare &&
      `${Math.round((100 * stats.rejected) / processed)} % of ${processed} items processed in 24 h were rejected (> ${a.rejectShare * 100} %)`,
  ].filter((x): x is string => typeof x === "string");
  return { stats, alerts };
}
