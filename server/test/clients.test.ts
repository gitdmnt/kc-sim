// Per-install tokens, per-IP issuance limits, bearer auth, ban, the 1-per-60-s upload gate (injected clock),
// the per-IP write limiter, body caps and CORS (src/auth/clients.ts, src/routes/write.ts).
import { beforeEach, describe, expect, test } from "bun:test";
import { hashIp, ipKey, sha256Hex } from "../src/auth/clients";
import { CLIENT_DAY_ITEMS, QUOTA_WINDOW_MS, STAGED_MAX_ITEMS } from "../src/ingest/upload";
import { battleResponse, drainJobs, fleet, harness, LAYOUT_15, seedBasic, uploadAndProcess, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = harness();
  await seedBasic(h.db);
});

let n = 0;
const obs = (o: Record<string, unknown> = {}) => ({
  clientObsId: `o${++n}`, observedAt: new Date(h.clock.t - 60_000).toISOString(), map: "1-5", cell: 1, layout: LAYOUT_15, difficulty: 0,
  kind: "battle", fleet: fleet(), raw: { path: "api_req_sortie/battle", visitId: `v${n}`, sortieId: null, raw: battleResponse([1501, 1502]), result: null }, ...o,
});
const upload = (token: string, observations: unknown[], extra: Record<string, unknown> = {}) =>
  h.call<Record<string, unknown>>("POST", "/api/v1/observations", { token, body: { observations, ...extra } });

describe("POST /api/v1/clients", () => {
  test("issues a 32-byte base64url token stored only as SHA-256, IP only as a salted HMAC", async () => {
    const { clientId, token } = await h.register("198.51.100.4");
    expect(clientId).toMatch(/^c_[A-Za-z0-9_-]{22}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const row = await h.db.prepare("SELECT * FROM clients WHERE id = ?1").bind(clientId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ token_hash: await sha256Hex(token), ip_hash: await hashIp("198.51.100.4", "test-salt"), last_post_at: 0, banned_at: null });
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("198.51.100.4");
  });

  test("per-IP limits: 3 per hour, 10 per day, with Retry-After; other IPs unaffected", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < 3; i++) {
      await h.register(ip);
      h.clock.t += 60_000;
    }
    const fourth = await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": ip } });
    expect(fourth.status).toBe(429);
    // the first issuance (3 min ago) leaves the hour window in 57 min
    expect(fourth.headers.get("Retry-After")).toBe(String(57 * 60));
    expect((await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": "198.51.100.10" } })).status).toBe(201);
    // hourly windows pass, the daily cap of 10 still applies
    for (let i = 3; i < 10; i++) {
      h.clock.t += 61 * 60_000;
      await h.register(ip);
    }
    h.clock.t += 61 * 60_000;
    const eleventh = await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": ip } });
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get("Retry-After"))).toBeGreaterThan(3600);
    h.clock.t += 24 * 60 * 60_000;
    expect((await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": ip } })).status).toBe(201);
  });

  test("fails closed without IP_HASH_SALT", async () => {
    const bare = harness({ env: { IP_HASH_SALT: undefined } });
    expect((await bare.call("POST", "/api/v1/clients")).status).toBe(500);
  });
});

describe("bearer auth and ban", () => {
  test("missing / unknown token → 401; banned → 403; ban of an unknown client → 404", async () => {
    expect((await upload("", [obs()])).status).toBe(401);
    expect((await upload("x".repeat(43), [obs()])).status).toBe(401);
    const { clientId, token } = await h.register();
    expect((await upload(token, [obs()])).status).toBe(202);
    expect((await h.call("POST", `/admin/clients/${clientId}/ban`, { body: { reason: "test" } })).json).toEqual({ clientId, banned: true });
    h.clock.t += 120_000;
    expect((await upload(token, [obs()])).status).toBe(403);
    expect((await h.call("POST", "/admin/clients/c_nope/ban")).status).toBe(404);
    expect(await h.db.prepare("SELECT ban_reason FROM clients WHERE id = ?1").bind(clientId).first()).toEqual({ ban_reason: "test" });
  });

  test("clientId in the body is ignored: the token decides", async () => {
    const { clientId, token } = await h.register();
    expect((await upload(token, [obs()], { clientId: "someone-else" })).json).toMatchObject({ queued: 1, duplicates: 0 });
    await drainJobs(h);
    expect((await h.db.prepare("SELECT DISTINCT client_id FROM observations").all()).results).toEqual([{ client_id: clientId }]);
  });
});

describe("1 POST per 60 s per token", () => {
  test("second upload within 60 s → 429 + Retry-After, body not processed; admitted again after 60 s", async () => {
    const a = await h.register();
    const b = await h.register("198.51.100.20");
    expect((await upload(a.token, [obs()])).status).toBe(202);
    h.clock.t += 45_000;
    // not even parsed: invalid JSON gets 429, not 400, and nothing is stored
    const second = await h.call("POST", "/api/v1/observations", { token: a.token, raw: "{not json" });
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("15");
    expect(second.json).toMatchObject({ retryAfter: 15 });
    expect((await upload(a.token, [obs()])).status).toBe(429);
    // other clients have their own slot
    expect((await upload(b.token, [obs()])).status).toBe(202);
    h.clock.t += 15_000;
    expect((await upload(a.token, [obs()])).status).toBe(202);
    await drainJobs(h);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM observations").first())).toEqual({ n: 3 });
  });

  test("concurrent uploads: exactly one is admitted", async () => {
    const { token } = await h.register();
    const results = await Promise.all([upload(token, [obs()]), upload(token, [obs()]), upload(token, [obs()])]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 429, 429]);
  });
});

describe("caps and per-IP write limit", () => {
  test("body > 256 KiB → 413; not JSON / > 100 observations → 400; observation > 64 KiB → rejected too_large; resend → duplicate", async () => {
    const { token } = await h.register();
    expect((await h.call("POST", "/api/v1/observations", { token, raw: JSON.stringify({ observations: [obs({ pad: "x".repeat(270_000) })] }) })).status).toBe(413);
    h.clock.t += 61_000;
    const notJson = await h.call("POST", "/api/v1/observations", { token, raw: "{not json" });
    expect(notJson).toMatchObject({ status: 400, json: { error: "body is not JSON" } });
    h.clock.t += 61_000;
    const many = await upload(token, Array.from({ length: 101 }, () => obs()));
    expect(many.status).toBe(400);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM upload_items").first()).toEqual({ n: 0 });
    const big = obs();
    (big.raw.raw as Record<string, unknown>).api_padding = "y".repeat(70_000);
    const small = obs();
    const r = await uploadAndProcess(h, token, [big, small]);
    expect(r).toMatchObject({ status: 202, accepted: 1, rejected: [{ clientObsId: big.clientObsId, rule: "too_large" }] });
    const again = await uploadAndProcess(h, token, [small]);
    expect(again).toMatchObject({ status: 202, response: { queued: 0, duplicates: 1 }, accepted: 0 });
  });

  test("per-IP write limiter (rate limit binding) keyed by the salted IP hash", async () => {
    const { token } = await h.register("198.51.100.30");
    expect(h.limiter.keys).toEqual([await hashIp("198.51.100.30", "test-salt")]);
    h.limiter.block = true;
    const r = await h.call("POST", "/api/v1/clients");
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    expect((await upload(token, [obs()])).status).toBe(429);
    // reads are not limited
    expect((await h.call("GET", "/api/v1/health")).status).toBe(200);
  });

  test("CORS: open, preflight allows Authorization, Retry-After is readable", async () => {
    const pre = await h.call("OPTIONS", "/api/v1/observations", {
      headers: { Origin: "file://", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(pre.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("authorization");
    const { token } = await h.register();
    await upload(token, [obs()]);
    const limited = await upload(token, [obs()]);
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(limited.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  });
});

describe("IPv6 keys, quotas, backlog cap, kill switch", () => {
  test("IPv6 addresses of one /64 share a key; IPv4-mapped IPv6 is the IPv4 address", async () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0db8:0001:0002:ffff:1:2:3")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::5")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(ipKey("192.0.2.1")).toBe("192.0.2.1");
    for (let i = 0; i < 3; i++) await h.register(`2001:db8:1:2::${i + 1}`);
    expect((await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": "2001:db8:1:2:ffff::9" } })).status).toBe(429);
    expect((await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": "2001:db8:1:3::1" } })).status).toBe(201);
  });

  test("a client's 24 h item quota → 429 until its window passes; staged counters follow staging and ingest", async () => {
    const { clientId, token } = await h.register();
    expect((await upload(token, [obs(), obs()])).status).toBe(202);
    expect(await h.db.prepare("SELECT value FROM kv_state WHERE key = 'staged_items'").first()).toEqual({ value: "2" });
    await h.db.prepare("UPDATE clients SET quota_items = ?2 WHERE id = ?1").bind(clientId, CLIENT_DAY_ITEMS).run();
    h.clock.t += 61_000;
    const over = await upload(token, [obs()]);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBe(24 * 3600 - 61);
    await drainJobs(h);
    expect(await h.db.prepare("SELECT value FROM kv_state WHERE key = 'staged_items'").first()).toEqual({ value: "0" });
    h.clock.t += QUOTA_WINDOW_MS;
    expect((await upload(token, [obs()])).status).toBe(202);
    expect(await h.db.prepare("SELECT quota_items FROM clients WHERE id = ?1").bind(clientId).first()).toEqual({ quota_items: 1 });
  });

  test("a full backlog → 503 with Retry-After for everyone", async () => {
    const { token } = await h.register();
    await h.db.prepare("UPDATE kv_state SET value = ?1 WHERE key = 'staged_items'").bind(String(STAGED_MAX_ITEMS)).run();
    const r = await upload(token, [obs()]);
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("3600");
  });

  test("WRITES_DISABLED: registration and uploads answer 503, reads still work", async () => {
    const off = harness({ env: { WRITES_DISABLED: "1" } });
    const r = await off.call("POST", "/api/v1/clients");
    expect(r.status).toBe(503);
    expect(r.headers.get("Retry-After")).toBe("3600");
    expect((await off.call("GET", "/api/v1/health")).status).toBe(200);
  });

  test("INGEST_PAUSED: jobs runs leave staged uploads staged", async () => {
    const paused = harness({ env: { INGEST_PAUSED: "1" } });
    await seedBasic(paused.db);
    const { token } = await paused.register();
    expect((await paused.call("POST", "/api/v1/observations", { token, body: { observations: [obs()] } })).status).toBe(202);
    await paused.call("POST", "/admin/ingest/run");
    expect(await paused.db.prepare("SELECT COUNT(*) AS n FROM upload_items").first()).toEqual({ n: 1 });
  });
});
