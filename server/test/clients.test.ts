// Per-install tokens, bearer auth, ban, the per-IP write limiter, body caps and CORS (src/auth/clients.ts, src/routes/write.ts).
import { beforeEach, describe, expect, test } from "bun:test";
import { hashIp, ipKey, sha256Hex } from "../src/auth/clients";
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
    expect(row).toMatchObject({ token_hash: await sha256Hex(token), ip_hash: await hashIp("198.51.100.4", "test-salt"), banned_at: null });
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("198.51.100.4");
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
    expect(await upload(token, [obs()])).toMatchObject({ status: 403, json: { error: "banned" } });
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

  test("write CORS: only poi's origins, POST with Authorization/Content-Type; reads stay open", async () => {
    const pre = (origin: string, reqHeaders = "authorization,content-type") => h.call("OPTIONS", "/api/v1/observations", {
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": reqHeaders },
    });
    for (const origin of ["null", "file://"]) {
      const ok = await pre(origin);
      expect(ok.status).toBe(204);
      expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(ok.headers.get("Access-Control-Allow-Headers")).toBe("Authorization,Content-Type");
      expect(ok.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    }
    expect((await pre("https://evil.example")).headers.get("Access-Control-Allow-Origin")).toBeNull();
    // a requested User-Agent header is not echoed back, so a browser cannot spoof it
    expect((await pre("null", "user-agent")).headers.get("Access-Control-Allow-Headers")).toBe("Authorization,Content-Type");
    const { token } = await h.register();
    h.limiter.block = true;
    const limited = await upload(token, [obs()]);
    expect(limited.headers.get("Access-Control-Allow-Origin")).toBe("null");
    expect(limited.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    const read = await h.call("GET", "/api/v1/health", { headers: { Origin: "https://example.org" } });
    expect(read.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("writes without poi's Origin or an Electron User-Agent → 403 and a log line; nothing registered", async () => {
    const logs: string[] = [];
    const log = console.log;
    console.log = (s: string) => void logs.push(s);
    try {
      const cases: [Record<string, string>, string][] = [
        [{ Origin: "", "User-Agent": "curl/8.7.1" }, "no_origin"],
        [{ Origin: "https://evil.example" }, "origin"],
        [{ "User-Agent": "Mozilla/5.0 Chrome/130.0 Safari/537.36", "Sec-Fetch-Site": "cross-site" }, "user_agent"],
      ];
      for (const [headers, reason] of cases) {
        const r = await h.call("POST", "/api/v1/clients", { headers });
        expect(r).toMatchObject({ status: 403, json: { error: "origin_rejected" } });
        expect(JSON.parse(logs.at(-1)!)).toMatchObject({ write_rejected: reason, path: "/api/v1/clients" });
      }
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ origin: "null", sfs: "cross-site" });
      const { token } = await h.register();
      expect((await h.call("POST", "/api/v1/observations", { token, body: { observations: [obs()] }, headers: { Origin: "" } })).status).toBe(403);
    } finally {
      console.log = log;
    }
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM clients").first()).toEqual({ n: 1 });
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM upload_items").first()).toEqual({ n: 0 });
  });
});

describe("IPv6 keys, kill switches", () => {
  test("IPv6 addresses of one /64 share a key; IPv4-mapped IPv6 is the IPv4 address", async () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0db8:0001:0002:ffff:1:2:3")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::5")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(ipKey("192.0.2.1")).toBe("192.0.2.1");
    await h.register("2001:db8:1:2::1");
    await h.register("2001:db8:1:2:ffff::9");
    await h.register("2001:db8:1:3::1");
    const [a, b, c] = h.limiter.keys;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
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
