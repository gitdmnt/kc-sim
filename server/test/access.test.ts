// Cloudflare Access JWT verification for /admin/* (src/auth/access.ts) with generated RS256 keys.
import { beforeEach, describe, expect, test } from "bun:test";
import { clearJwksCache, verifyAccessJwt, type VerifyDeps } from "../src/auth/access";
import { harness } from "./helpers";

const TEAM = "kc-sim-test.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "aud-tag-123";
const NOW = Date.UTC(2026, 9, 22, 0, 0, 0);

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface TestKey {
  /** public JWK as published in the team's certs */
  jwk: object;
  sign: (claims: Record<string, unknown>, header?: Record<string, unknown>) => Promise<string>;
}

async function keyPair(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
    const p = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`)));
    return `${h}.${p}.${b64url(sig)}`;
  };
  return { jwk, sign };
}

const claims = (o: Record<string, unknown> = {}) => ({ aud: [AUD], iss: ISS, exp: NOW / 1000 + 600, iat: NOW / 1000, email: "admin@example.com", ...o });

let k1: TestKey;
let k2: TestKey;
let published: object[];
let fetched: string[];
let now: number;
const deps: VerifyDeps = {
  fetch: async (url) => {
    fetched.push(url);
    return Response.json({ keys: published });
  },
  now: () => now,
};

beforeEach(async () => {
  clearJwksCache();
  k1 ??= await keyPair("k1");
  k2 ??= await keyPair("k2");
  published = [k1.jwk];
  fetched = [];
  now = NOW;
});

describe("verifyAccessJwt", () => {
  test("valid token: signature, issuer, audience; JWKS fetched once and cached", async () => {
    const t = await k1.sign(claims());
    expect((await verifyAccessJwt(t, { teamDomain: TEAM, aud: AUD }, deps)).email).toBe("admin@example.com");
    await verifyAccessJwt(t, { teamDomain: `https://${TEAM}/`, aud: AUD }, deps);
    expect(fetched).toEqual([`${ISS}/cdn-cgi/access/certs`]);
  });

  test("rejects wrong audience, issuer, expiry, not-before, signature, algorithm and garbage", async () => {
    const cfg = { teamDomain: TEAM, aud: AUD };
    const reject = async (token: string, reason: RegExp) => expect(verifyAccessJwt(token, cfg, deps)).rejects.toThrow(reason);
    await reject(await k1.sign(claims({ aud: ["other"] })), /audience/);
    await reject(await k1.sign(claims({ iss: "https://evil.cloudflareaccess.com" })), /issuer/);
    await reject(await k1.sign(claims({ exp: NOW / 1000 - 120 })), /expired/);
    await reject(await k1.sign(claims({ nbf: NOW / 1000 + 600 })), /not yet valid/);
    await reject(await k1.sign(claims(), { alg: "HS256" }), /unsupported/);
    const [h, p] = (await k1.sign(claims())).split(".");
    const forged = `${h}.${b64url(JSON.stringify(claims({ email: "x@evil" })))}.${(await k1.sign(claims())).split(".")[2]}`;
    expect(p).toBeDefined();
    await reject(forged, /bad signature/);
    await reject("abc", /malformed/);
    // a key the team does not publish
    await reject(await k2.sign(claims()), /unknown signing key/);
  });

  test("key rotation: an unknown kid refetches the JWKS (at most once a minute)", async () => {
    await verifyAccessJwt(await k1.sign(claims()), { teamDomain: TEAM, aud: AUD }, deps);
    published = [k1.jwk, k2.jwk];
    const t2 = await k2.sign(claims());
    await expect(verifyAccessJwt(t2, { teamDomain: TEAM, aud: AUD }, deps)).rejects.toThrow(/unknown signing key/); // < 60 s
    now += 61_000;
    expect((await verifyAccessJwt(t2, { teamDomain: TEAM, aud: AUD }, deps)).aud).toEqual([AUD]);
    expect(fetched).toHaveLength(2);
  });
});

describe("/admin guard", () => {
  test("production: Access JWT required (401 missing, 403 invalid, 200 valid); unconfigured → 503", async () => {
    const h = harness({ env: { ENVIRONMENT: "production", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, access: deps });
    expect((await h.call("GET", "/admin/estimate/status")).status).toBe(401);
    expect((await h.call("GET", "/admin/estimate/status", { headers: { "Cf-Access-Jwt-Assertion": await k1.sign(claims({ aud: ["x"] })) } })).status).toBe(403);
    const ok = await h.call("GET", "/admin/estimate/status", { headers: { "Cf-Access-Jwt-Assertion": await k1.sign(claims()) } });
    expect(ok.status).toBe(200);
    // the static bearer token of the old admin API no longer opens anything
    expect((await h.call("GET", "/admin/estimate/status", { token: "dev-admin-token" })).status).toBe(401);
    const bare = harness({ env: { ENVIRONMENT: "production" }, access: deps });
    expect((await bare.call("GET", "/admin/estimate/status", { headers: { "Cf-Access-Jwt-Assertion": await k1.sign(claims()) } })).status).toBe(503);
  });

  test("development bypass only for localhost", async () => {
    const h = harness({ env: { ENVIRONMENT: "development" }, access: deps });
    expect((await h.call("GET", "/admin/estimate/status")).status).toBe(200);
    expect((await h.call("GET", "/admin/estimate/status", { host: "127.0.0.1:8787" })).status).toBe(200);
    expect((await h.call("GET", "/admin/estimate/status", { host: "kc-sim-api.example.com" })).status).toBe(503);
    const prod = harness({ env: { ENVIRONMENT: "production", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, access: deps });
    expect((await prod.call("GET", "/admin/estimate/status")).status).toBe(401);
  });
});
