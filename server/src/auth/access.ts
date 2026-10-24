// Cloudflare Access for /admin/* (private deployment notes "Access"). Access sits in front of the worker and adds a
// signed JWT (`Cf-Access-Jwt-Assertion`) to every request it lets through; the worker verifies it against
// the team's JWKS so that a request reaching the worker by any other route (workers.dev, a missing Access
// policy) is still refused.
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

export interface AccessConfig {
  /** "kc-sim.cloudflareaccess.com" or "https://kc-sim.cloudflareaccess.com" */
  teamDomain: string;
  /** Application audience tag */
  aud: string;
}

export interface AccessClaims {
  aud: string | string[];
  iss: string;
  exp: number;
  nbf?: number;
  iat?: number;
  email?: string;
  sub?: string;
  common_name?: string;
}

export interface VerifyDeps {
  fetch: (url: string) => Promise<Response>;
  /** epoch ms */
  now: () => number;
}

const DEFAULT_DEPS: VerifyDeps = { fetch: (url) => fetch(url), now: () => Date.now() };
const JWKS_TTL_MS = 60 * 60_000;
/** An unknown `kid` refetches the JWKS (key rotation), at most this often. */
const JWKS_REFETCH_MS = 60_000;
const CLOCK_SKEW_S = 60;

export const issuerOf = (teamDomain: string) => `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

interface CachedJwks { keys: Map<string, CryptoKey>; fetchedAt: number }
/** Per-isolate JWKS cache, keyed by the certs URL. */
const jwksCache = new Map<string, CachedJwks>();

export const clearJwksCache = () => jwksCache.clear();

async function loadJwks(url: string, deps: VerifyDeps): Promise<CachedJwks> {
  const res = await deps.fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  const entry = { keys, fetchedAt: deps.now() };
  jwksCache.set(url, entry);
  return entry;
}

async function keyFor(url: string, kid: string, deps: VerifyDeps): Promise<CryptoKey | undefined> {
  let jwks = jwksCache.get(url);
  if (!jwks || deps.now() - jwks.fetchedAt > JWKS_TTL_MS) jwks = await loadJwks(url, deps);
  if (!jwks.keys.has(kid) && deps.now() - jwks.fetchedAt > JWKS_REFETCH_MS) jwks = await loadJwks(url, deps);
  return jwks.keys.get(kid);
}

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};
const b64urlJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** Verifies an Access JWT (RS256, team JWKS, issuer, audience, exp/nbf). Throws with the reason. */
export async function verifyAccessJwt(token: string, cfg: AccessConfig, deps: VerifyDeps = DEFAULT_DEPS): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error(`unsupported token header (alg ${header.alg})`);
  const issuer = issuerOf(cfg.teamDomain);
  const key = await keyFor(`${issuer}/cdn-cgi/access/certs`, header.kid, deps);
  if (!key) throw new Error(`unknown signing key ${header.kid}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("bad signature");
  const claims = b64urlJson(p) as AccessClaims;
  const now = deps.now() / 1000;
  if (claims.iss !== issuer) throw new Error(`issuer ${claims.iss} != ${issuer}`);
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(cfg.aud)) throw new Error("audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_S) throw new Error("token expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) throw new Error("token not yet valid");
  return claims;
}

const LOCAL_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/**
 * /admin/* guard. `ENVIRONMENT=development` (local `.dev.vars`) skips the check for requests to localhost;
 * everywhere else a valid Access JWT is required, and missing Access configuration refuses every request.
 */
export const requireAccess = (deps: VerifyDeps = DEFAULT_DEPS): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
  if (c.env.ENVIRONMENT === "development" && LOCAL_HOSTS[new URL(c.req.url).hostname]) return next();
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud } = c.env;
  if (!teamDomain || !aud) return c.json({ error: "admin access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)" }, 503);
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "missing Cf-Access-Jwt-Assertion" }, 401);
  try {
    await verifyAccessJwt(token, { teamDomain, aud }, deps);
  } catch (e) {
    return c.json({ error: "forbidden", reason: e instanceof Error ? e.message : String(e) }, 403);
  }
  return next();
};
