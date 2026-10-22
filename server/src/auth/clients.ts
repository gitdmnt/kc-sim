// Per-install upload clients (docs/API.md §3 "Clients and limits"): token issuance with per-IP limits,
// bearer authentication, the 1-per-60-s observation gate, and the per-IP write limit.
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

export const ISSUE_LIMITS = [
  { windowMs: 60 * 60_000, max: 3 },
  { windowMs: 24 * 60 * 60_000, max: 10 },
] as const;
export const POST_INTERVAL_MS = 60_000;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomB64url = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** HMAC-SHA-256(salt, ip) as hex. IPs are never stored raw. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip)));
}

/** Salted hash of the client IP (CF-Connecting-IP); null when IP_HASH_SALT is missing (callers fail closed). */
export async function requestIpHash(env: Env, ip: string | undefined): Promise<string | null> {
  if (!env.IP_HASH_SALT) return null;
  return hashIp(ip ?? "unknown", env.IP_HASH_SALT);
}

export type IssueResult = { ok: true; clientId: string; token: string } | { ok: false; retryAfter: number };

/**
 * Issues `{clientId, token}`: 32 random bytes (base64url), stored as SHA-256. One conditional INSERT checks
 * both per-IP windows, so concurrent requests cannot exceed them.
 */
export async function issueClient(db: D1Database, ipHash: string, now: number): Promise<IssueResult> {
  const clientId = `c_${randomB64url(16)}`;
  const token = randomB64url(32);
  const [hour, day] = ISSUE_LIMITS;
  const r = await db.prepare(
    `INSERT INTO clients (id, token_hash, ip_hash, created_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM clients WHERE ip_hash = ?3 AND created_at > ?4 - ?5) < ?6
       AND (SELECT COUNT(*) FROM clients WHERE ip_hash = ?3 AND created_at > ?4 - ?7) < ?8`,
  ).bind(clientId, await sha256Hex(token), ipHash, now, hour.windowMs, hour.max, day.windowMs, day.max).run();
  if ((r.meta.changes ?? 0) > 0) return { ok: true, clientId, token };
  // Seconds until the oldest issuance of the full window leaves it.
  const { results } = await db.prepare("SELECT created_at FROM clients WHERE ip_hash = ?1 AND created_at > ?2 ORDER BY created_at DESC")
    .bind(ipHash, now - day.windowMs).all<{ created_at: number }>();
  const freeAt = ISSUE_LIMITS.map(({ windowMs, max }) => {
    const inWindow = results.filter((x) => x.created_at > now - windowMs);
    return inWindow.length >= max ? inWindow[max - 1]!.created_at + windowMs : now;
  });
  return { ok: false, retryAfter: Math.max(1, Math.ceil((Math.max(...freeAt) - now) / 1000)) };
}

export interface ClientVars { clientId: string }

/** `Authorization: Bearer <token>` → `c.var.clientId`; 401 for unknown tokens, 403 for banned clients. */
export const requireClient: MiddlewareHandler<{ Bindings: Env; Variables: ClientVars }> = async (c, next) => {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("Authorization") ?? "");
  if (!m) return c.json({ error: "missing or malformed bearer token (POST /api/v1/clients issues one)" }, 401);
  const row = await c.env.DB.prepare("SELECT id, banned_at FROM clients WHERE token_hash = ?1")
    .bind(await sha256Hex(m[1]!)).first<{ id: string; banned_at: string | null }>();
  if (!row) return c.json({ error: "unknown token" }, 401);
  if (row.banned_at) return c.json({ error: "client is banned" }, 403);
  c.set("clientId", row.id);
  return next();
};

/**
 * Admits one POST /observations per client per POST_INTERVAL_MS: an atomic conditional UPDATE of
 * `clients.last_post_at`. Returns 0 when admitted, else the seconds to wait.
 */
export async function claimPostSlot(db: D1Database, clientId: string, now: number): Promise<number> {
  const r = await db.prepare("UPDATE clients SET last_post_at = ?2 WHERE id = ?1 AND last_post_at <= ?2 - ?3")
    .bind(clientId, now, POST_INTERVAL_MS).run();
  if ((r.meta.changes ?? 0) > 0) return 0;
  const row = await db.prepare("SELECT last_post_at FROM clients WHERE id = ?1").bind(clientId).first<{ last_post_at: number }>();
  return Math.max(1, Math.ceil(((row?.last_post_at ?? now) + POST_INTERVAL_MS - now) / 1000));
}

/**
 * Per-IP limit on every write request (Workers Rate Limiting binding, keyed by the salted IP hash). The
 * binding counts per Cloudflare location and is eventually consistent, which is fine for abuse damping.
 */
export const limitWritesPerIp: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const ipHash = await requestIpHash(c.env, c.req.header("CF-Connecting-IP"));
  if (!ipHash) return c.json({ error: "server misconfigured: IP_HASH_SALT is not set" }, 500);
  const { success } = await c.env.WRITE_LIMITER.limit({ key: ipHash });
  if (!success) {
    c.header("Retry-After", "60");
    return c.json({ error: "too many write requests from this address", retryAfter: 60 }, 429);
  }
  return next();
};

/** Marks a client as banned: its token gets 403 from then on. Returns false for an unknown client. */
export async function banClient(db: D1Database, clientId: string, reason: string | null, now: string): Promise<boolean> {
  const r = await db.prepare("UPDATE clients SET banned_at = COALESCE(banned_at, ?2), ban_reason = ?3 WHERE id = ?1")
    .bind(clientId, now, reason).run();
  return (r.meta.changes ?? 0) > 0;
}
