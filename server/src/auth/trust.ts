// Trust model for uploads. A new client is on probation: its observations are validated and stored, but they reach
// the aggregates, the estimator and routing inference only once the client is trusted (promoteClients, run by the
// jobs). So a fresh identity, however many an attacker registers, changes nothing until it has uploaded plausible
// data over several days. Trusted clients are further limited per day (CLIENT_CELL_DAY_CAP, CLIENT_SHIP_DAY_CAP)
// and need corroboration by other reporters (MIN_REPORTERS) before a layout becomes current or observed comps are
// preferred over KCNav.

/** A client becomes trusted no earlier than this after its registration… */
export const PROBATION_MS = 3 * 24 * 60 * 60_000;
/** …with at least this many stored, unquarantined observations… */
export const MIN_ACCEPTED = 20;
/** …uploaded on at least this many distinct (UTC) days… */
export const MIN_UPLOAD_DAYS = 2;
/** …and at most this share of its items rejected. */
export const MAX_REJECT_SHARE = 0.1;

/** Distinct reporters (salted IP hashes of trusted clients) that make a layout current or prefer observed comps. */
export const MIN_REPORTERS = 2;
/** Per client, map, cell and upload day: battles folded into the comp counts (sorties: cell -1). */
export const CLIENT_CELL_DAY_CAP = 100;
/** Per client, enemy ship and upload day: battles counted by the estimator. */
export const CLIENT_SHIP_DAY_CAP = 100;

/** SQL: the row `alias` (with a client_id column) belongs to a trusted, unbanned client. */
export const trustedClient = (alias: string) =>
  `EXISTS (SELECT 1 FROM clients tc WHERE tc.id = ${alias}.client_id AND tc.trusted_at IS NOT NULL AND tc.banned_at IS NULL)`;

/** Promotes the clients that finished probation (one statement; the jobs run it once per run). Returns how many. */
export async function promoteClients(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare(
    `UPDATE clients SET trusted_at = ?1
     WHERE trusted_at IS NULL AND banned_at IS NULL AND created_at <= ?2
       AND NOT EXISTS (SELECT 1 FROM banned_ips b WHERE b.ip_hash = clients.ip_hash)
       AND (SELECT COUNT(*) FROM observations o WHERE o.client_id = clients.id AND o.quarantine IS NULL) >= ?3
       AND (SELECT COUNT(DISTINCT substr(o.uploaded_at, 1, 10)) FROM observations o WHERE o.client_id = clients.id AND o.quarantine IS NULL) >= ?4
       AND (SELECT COUNT(*) FROM observation_rejections r WHERE r.client_id = clients.id AND r.action = 'reject')
         <= ?5 * ((SELECT COUNT(*) FROM observations o WHERE o.client_id = clients.id)
           + (SELECT COUNT(*) FROM observation_rejections r WHERE r.client_id = clients.id AND r.action = 'reject'))`,
  ).bind(new Date(now).toISOString(), now - PROBATION_MS, MIN_ACCEPTED, MIN_UPLOAD_DAYS, MAX_REJECT_SHARE).run();
  return r.meta.changes ?? 0;
}
