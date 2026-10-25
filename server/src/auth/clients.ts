// Per-install upload clients (private notes API §3 "Clients and limits"): token issuance, bearer
// authentication and the per-IP write limit.
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

/**
 * `error` codes of the write 403s. The plugin keeps its token and retries later on ORIGIN_REJECTED (a request it
 * cannot change), and stops sending on BANNED.
 */
export const ORIGIN_REJECTED = "origin_rejected";
export const BANNED = "banned";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomB64url = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** HMAC-SHA-256(salt, ip) as hex. IPs are never stored raw. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip)));
}

/**
 * The address the per-IP limits key on: IPv4 as is, IPv6 by its /64 (one subscriber or VPS usually gets a whole
 * /64, so per-address keys would not limit anything). IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function ipKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("%")[0]!.split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

/** Salted hash of the client IP (CF-Connecting-IP, IPv6 by /64); null when IP_HASH_SALT is missing (callers fail closed). */
export async function requestIpHash(env: Env, ip: string | undefined): Promise<string | null> {
  if (!env.IP_HASH_SALT) return null;
  return hashIp(ipKey(ip ?? "unknown"), env.IP_HASH_SALT);
}

/** Issues `{clientId, token}`: 32 random bytes (base64url), stored as SHA-256. One INSERT. */
export async function issueClient(db: D1Database, ipHash: string, now: number): Promise<{ clientId: string; token: string }> {
  const clientId = `c_${randomB64url(16)}`;
  const token = randomB64url(32);
  await db.prepare("INSERT INTO clients (id, token_hash, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(clientId, await sha256Hex(token), ipHash, now).run();
  return { clientId, token };
}

export interface ClientVars { clientId: string }

/** `Authorization: Bearer <token>` → `c.var.clientId` (one read); 401 for unknown tokens, 403 for banned clients. */
export const requireClient: MiddlewareHandler<{ Bindings: Env; Variables: ClientVars }> = async (c, next) => {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("Authorization") ?? "");
  if (!m) return c.json({ error: "missing or malformed bearer token (POST /api/v1/clients issues one)" }, 401);
  const row = await c.env.DB.prepare("SELECT id, banned_at FROM clients WHERE token_hash = ?1")
    .bind(await sha256Hex(m[1]!)).first<{ id: string; banned_at: string | null }>();
  if (!row) return c.json({ error: "unknown token" }, 401);
  if (row.banned_at) return c.json({ error: BANNED, message: "this client is banned" }, 403);
  c.set("clientId", row.id);
  return next();
};

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

/** Bans (`ban`) or unbans every client registered from an address (salted IP hash). Returns how many changed. */
export async function setIpBan(db: D1Database, ipHash: string, ban: boolean, reason: string | null, now: string): Promise<number> {
  const r = ban
    ? await db.prepare("UPDATE clients SET banned_at = COALESCE(banned_at, ?2), ban_reason = COALESCE(ban_reason, ?3) WHERE ip_hash = ?1").bind(ipHash, now, reason).run()
    : await db.prepare("UPDATE clients SET banned_at = NULL, ban_reason = NULL WHERE ip_hash = ?1 AND banned_at IS NOT NULL").bind(ipHash).run();
  return r.meta.changes ?? 0;
}
