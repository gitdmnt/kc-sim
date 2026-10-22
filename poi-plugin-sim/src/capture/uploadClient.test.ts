import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test } from "bun:test";
import { MAX_OBSERVATIONS_PER_REQUEST, MAX_REQUEST_BYTES, ObservationDb } from "./db";
import type { CapturedBattle } from "@shared/capture/types";
import { UPLOAD_INTERVAL_MS, createUploadClient, memoryStore } from "./uploadClient";

const BASE = "http://api.test";

const battle = (i: number): CapturedBattle => ({
  id: `b-${String(i).padStart(4, "0")}`,
  capturedAt: 1_000 + i,
  path: "api_req_sortie/battle",
  visitId: `v-${i}`,
  map: { map: "1-1", area: 1, mapNo: 1, cellId: 1, node: "1", difficulty: 0, eventId: 4, eventKind: 1, step: 1 },
  fleet: null,
  enemy: { ships: [], escort: [], friendFormation: 1, enemyFormation: 1, engagement: 1 },
  enemyMasterIds: [],
  pending: 1,
  raw: {},
});

interface Req {
  url: string;
  method: string;
  auth: string | null;
  body: { observations: { clientObsId: string; kind: string }[] };
}

/** サーバの代役。handler が null を返したら 200 (登録なら新しいトークン)。 */
const setup = () => {
  let t = 1_000_000;
  const requests: Req[] = [];
  const server = {
    registers: 0,
    /** 観測 POST ごとに呼ばれる。{status, retryAfter} を返すとその応答にする。 */
    onObservations: null as null | ((r: Req) => { status: number; retryAfter?: string } | null),
    onRegister: null as null | (() => { status: number; retryAfter?: string } | null),
  };
  const respond = (r: { status: number; retryAfter?: string }, body: unknown = {}) =>
    ({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: `S${r.status}`,
      headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? (r.retryAfter ?? null) : null) },
      json: async () => body,
    }) as unknown as Response;
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const req: Req = {
      url,
      method: init.method ?? "GET",
      auth: (init.headers as Record<string, string> | undefined)?.Authorization ?? null,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    requests.push(req);
    if (url.endsWith("/api/v1/clients")) {
      const over = server.onRegister?.();
      if (over) return respond(over);
      server.registers += 1;
      return respond({ status: 201 }, { clientId: `c-${server.registers}`, token: `tok-${server.registers}` });
    }
    const over = server.onObservations?.(req);
    return respond(over ?? { status: 200 }, { accepted: 1 });
  }) as unknown as typeof fetch;
  const store = memoryStore();
  const client = createUploadClient({ store, fetch: fakeFetch, now: () => t });
  return {
    client,
    store,
    server,
    requests,
    posts: () => requests.filter((r) => r.url.endsWith("/api/v1/observations")),
    registrations: () => requests.filter((r) => r.url.endsWith("/api/v1/clients")),
    advance: (ms: number) => void (t += ms),
    now: () => t,
  };
};

let db: ObservationDb;
const addBattles = async (n: number, from = 0) => {
  for (let i = from; i < from + n; i++) await db.saveBattle(battle(i), []);
};

beforeEach(() => {
  db = new ObservationDb(new IDBFactory());
});

describe("registration", () => {
  test("registers on the first send, stores the token, and authenticates the upload without clientId in the body", async () => {
    const s = setup();
    await addBattles(3);
    expect(s.client.state(BASE)).toEqual({ kind: "none" });
    const out = await s.client.send(db, BASE);
    expect(out).toMatchObject({ status: "sent", sent: 3, remaining: 0 });
    expect(s.registrations()).toHaveLength(1);
    expect(s.registrations()[0]).toMatchObject({ method: "POST", url: `${BASE}/api/v1/clients`, body: undefined });
    expect(s.client.state(BASE)).toEqual({ kind: "registered", clientId: "c-1" });
    expect(s.store.credentials()).toEqual({ apiBase: BASE, clientId: "c-1", token: "tok-1", banned: false });
    const [post] = s.posts();
    expect(post.auth).toBe("Bearer tok-1");
    expect(Object.keys(post.body)).toEqual(["observations"]);
    expect(post.body.observations).toHaveLength(3);
    expect(await db.countPending(s.now())).toBe(0);
  });

  test("a trailing slash on the API base is the same server", async () => {
    const s = setup();
    await addBattles(1);
    await s.client.send(db, `${BASE}/`);
    expect(s.client.state(BASE).kind).toBe("registered");
  });

  test("nothing pending: no registration, no request", async () => {
    const s = setup();
    expect(await s.client.send(db, BASE)).toEqual({ status: "idle" });
    expect(s.requests).toHaveLength(0);
    expect(s.store.credentials()).toBeNull();
  });

  test("reuses the stored token on later sends", async () => {
    const s = setup();
    await addBattles(1);
    await s.client.send(db, BASE);
    s.advance(UPLOAD_INTERVAL_MS);
    await addBattles(1, 10);
    await s.client.send(db, BASE);
    expect(s.registrations()).toHaveLength(1);
    expect(s.posts().map((p) => p.auth)).toEqual(["Bearer tok-1", "Bearer tok-1"]);
  });

  test("a rate-limited registration (429) waits for Retry-After and is not an error", async () => {
    const s = setup();
    await addBattles(1);
    s.server.onRegister = () => ({ status: 429, retryAfter: "120" });
    expect(await s.client.send(db, BASE)).toEqual({ status: "deferred", until: s.now() + 120_000, reason: "server" });
    expect(s.posts()).toHaveLength(0);
    s.advance(119_999);
    expect((await s.client.send(db, BASE)).status).toBe("deferred");
    expect(s.registrations()).toHaveLength(1);
    s.server.onRegister = null;
    s.advance(1);
    expect((await s.client.send(db, BASE)).status).toBe("sent");
  });

  test("a failed registration throws (the caller backs off)", async () => {
    const s = setup();
    await addBattles(1);
    s.server.onRegister = () => ({ status: 503 });
    await expect(s.client.send(db, BASE)).rejects.toThrow("503");
    expect(s.store.credentials()).toBeNull();
  });
});

describe("limiter: at most one POST per 60 s", () => {
  test("a second send inside the interval is deferred without a request", async () => {
    const s = setup();
    await addBattles(1);
    await s.client.send(db, BASE);
    await addBattles(1, 10);
    s.advance(UPLOAD_INTERVAL_MS - 1);
    expect(await s.client.send(db, BASE)).toEqual({ status: "deferred", until: s.now() + 1, reason: "limiter" });
    expect(s.posts()).toHaveLength(1);
    s.advance(1);
    expect((await s.client.send(db, BASE)).status).toBe("sent");
    expect(s.posts()).toHaveLength(2);
  });

  test("the limiter is shared through the store (manual and auto upload, or two windows)", async () => {
    const s = setup();
    await addBattles(1);
    await s.client.send(db, BASE);
    const other = createUploadClient({ store: s.store, fetch: (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch, now: s.now });
    await addBattles(1, 10);
    expect((await other.send(db, BASE)).status).toBe("deferred");
  });

  test("a failed POST (5xx / network) also uses up the interval, and stays pending", async () => {
    const s = setup();
    await addBattles(2);
    s.server.onObservations = () => ({ status: 500 });
    await expect(s.client.send(db, BASE)).rejects.toThrow("500");
    expect(await db.countPending(s.now())).toBe(2);
    expect((await s.client.send(db, BASE)).status).toBe("deferred");
    expect(s.posts()).toHaveLength(1);
    s.advance(UPLOAD_INTERVAL_MS);
    s.server.onObservations = null;
    expect(await s.client.send(db, BASE)).toMatchObject({ status: "sent", sent: 2 });
  });

  test("concurrent sends share one request", async () => {
    const s = setup();
    await addBattles(1);
    const [a, b] = await Promise.all([s.client.send(db, BASE), s.client.send(db, BASE)]);
    expect(a).toBe(b);
    expect(s.posts()).toHaveLength(1);
  });
});

describe("200-observation packing", () => {
  test("packs 200 per request, oldest first, one request per interval", async () => {
    const s = setup();
    await addBattles(450);
    const sizes: number[] = [];
    const firstIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await s.client.send(db, BASE);
      expect(out.status).toBe("sent");
      const post = s.posts().at(-1)!;
      sizes.push(post.body.observations.length);
      firstIds.push(post.body.observations[0].clientObsId);
      if (out.status === "sent") expect(out.remaining).toBe(450 - sizes.reduce((a, b) => a + b, 0));
      expect((await s.client.send(db, BASE)).status).toBe("deferred"); // 同じ間隔のうちは次を送らない
      s.advance(UPLOAD_INTERVAL_MS);
    }
    expect(MAX_OBSERVATIONS_PER_REQUEST).toBe(200);
    expect(sizes).toEqual([200, 200, 50]);
    expect(firstIds).toEqual(["b-0000", "b-0200", "b-0400"]);
    expect(s.posts()).toHaveLength(3);
  });
});

describe("2 MB body cap", () => {
  const big = (i: number, kb: number): CapturedBattle => ({ ...battle(i), raw: { pad: "x".repeat(kb * 1024) } });

  test("packs by serialized size as well as count, oldest first, and everything is eventually sent", async () => {
    const s = setup();
    for (let i = 0; i < 40; i++) await db.saveBattle(big(i, 100), []); // ~100 KB each: about 20 fit under 2 MB
    const sizes: number[] = [];
    for (let guard = 0; guard < 10 && (await db.countPending(s.now())) > 0; guard++) {
      const out = await s.client.send(db, BASE);
      expect(out.status).toBe("sent");
      const post = s.posts().at(-1)!;
      sizes.push(post.body.observations.length);
      s.advance(UPLOAD_INTERVAL_MS);
    }
    expect(Math.max(...sizes)).toBeLessThan(MAX_OBSERVATIONS_PER_REQUEST);
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(40);
    for (const p of s.posts()) expect(JSON.stringify(p.body).length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(s.posts()[0].body.observations[0].clientObsId).toBe("b-0000");
    expect(s.posts()[1].body.observations[0].clientObsId).toBe(`b-${String(sizes[0]).padStart(4, "0")}`);
  });

  test("a single observation larger than the cap is dropped, not retried forever", async () => {
    const s = setup();
    await db.saveBattle(big(0, 2100), []);
    await db.saveBattle(big(1, 1), []);
    const out = await s.client.send(db, BASE);
    expect(out).toMatchObject({ status: "sent", sent: 1, remaining: 0 });
    expect(s.posts()[0].body.observations.map((o) => o.clientObsId)).toEqual(["b-0001"]);
    expect(await db.countPending(s.now())).toBe(0);
  });
});

describe("429 from the observations endpoint", () => {
  test("defers to exactly Retry-After, leaves the data pending, and is not an error", async () => {
    const s = setup();
    await addBattles(2);
    s.server.onObservations = () => ({ status: 429, retryAfter: "37" });
    const out = await s.client.send(db, BASE);
    expect(out).toEqual({ status: "deferred", until: s.now() + 37_000, reason: "server" });
    expect(s.client.nextAt()).toBe(s.now() + 37_000);
    expect(await db.countPending(s.now())).toBe(2);
    s.advance(36_999);
    expect((await s.client.send(db, BASE)).status).toBe("deferred");
    expect(s.posts()).toHaveLength(1);
    s.server.onObservations = null;
    s.advance(1);
    expect(await s.client.send(db, BASE)).toMatchObject({ status: "sent", sent: 2 });
    expect(s.registrations()).toHaveLength(1);
  });

  test("a missing Retry-After falls back to the 60 s interval", async () => {
    const s = setup();
    await addBattles(1);
    s.server.onObservations = () => ({ status: 429 });
    expect(await s.client.send(db, BASE)).toMatchObject({ status: "deferred", until: s.now() + UPLOAD_INTERVAL_MS });
  });
});

describe("401: token no longer valid", () => {
  test("re-registers once and resends with the new token", async () => {
    const s = setup();
    await addBattles(1);
    await s.client.send(db, BASE);
    s.advance(UPLOAD_INTERVAL_MS);
    await addBattles(1, 10);
    s.server.onObservations = (r) => (r.auth === "Bearer tok-1" ? { status: 401 } : null);
    expect(await s.client.send(db, BASE)).toMatchObject({ status: "sent", sent: 1 });
    expect(s.registrations()).toHaveLength(2);
    expect(s.posts().map((p) => p.auth)).toEqual(["Bearer tok-1", "Bearer tok-1", "Bearer tok-2"]);
    expect(s.client.state(BASE)).toEqual({ kind: "registered", clientId: "c-2" });
  });

  test("a second 401 is an error, not a loop", async () => {
    const s = setup();
    await addBattles(1);
    s.server.onObservations = () => ({ status: 401 });
    await expect(s.client.send(db, BASE)).rejects.toThrow("401");
    expect(s.registrations()).toHaveLength(2);
    expect(s.posts()).toHaveLength(2);
    expect(await db.countPending(s.now())).toBe(1);
  });
});

describe("403: banned", () => {
  test("stops sending, keeps the data, and survives across clients", async () => {
    const s = setup();
    await addBattles(1);
    s.server.onObservations = () => ({ status: 403 });
    expect(await s.client.send(db, BASE)).toEqual({ status: "banned" });
    expect(s.client.state(BASE)).toEqual({ kind: "banned", clientId: "c-1" });
    expect(await db.countPending(s.now())).toBe(1);

    s.server.onObservations = null;
    s.advance(10 * UPLOAD_INTERVAL_MS);
    expect(await s.client.send(db, BASE)).toEqual({ status: "banned" });
    const reopened = createUploadClient({ store: s.store, fetch: (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch, now: s.now });
    expect(await reopened.send(db, BASE)).toEqual({ status: "banned" });
    expect(s.posts()).toHaveLength(1);
    expect(s.registrations()).toHaveLength(1);
  });

  test("an explicit re-registration lifts the stop", async () => {
    const s = setup();
    await addBattles(1);
    s.server.onObservations = (r) => (r.auth === "Bearer tok-1" ? { status: 403 } : null);
    await s.client.send(db, BASE);
    expect(await s.client.register(BASE)).toEqual({ status: "registered", clientId: "c-2" });
    expect(s.client.state(BASE).kind).toBe("registered");
    s.advance(UPLOAD_INTERVAL_MS);
    expect(await s.client.send(db, BASE)).toMatchObject({ status: "sent" });
  });

  test("the ban applies to that server only", async () => {
    const s = setup();
    await addBattles(1);
    s.server.onObservations = () => ({ status: 403 });
    await s.client.send(db, BASE);
    expect(s.client.state("http://other.test")).toEqual({ kind: "none" });
  });
});

describe("API base change", () => {
  test("re-registers against the new server, replacing the old token, with a fresh limiter", async () => {
    const s = setup();
    await addBattles(1);
    await s.client.send(db, BASE);
    await addBattles(1, 10);
    // 直後なので同じサーバなら間隔に引っ掛かる
    expect((await s.client.send(db, BASE)).status).toBe("deferred");

    const out = await s.client.send(db, "http://other.test");
    expect(out).toMatchObject({ status: "sent", sent: 1 });
    expect(s.registrations().map((r) => r.url)).toEqual([`${BASE}/api/v1/clients`, "http://other.test/api/v1/clients"]);
    expect(s.posts().at(-1)).toMatchObject({ url: "http://other.test/api/v1/observations", auth: "Bearer tok-2" });
    expect(s.store.credentials()).toMatchObject({ apiBase: "http://other.test", token: "tok-2" });
    expect(s.client.state(BASE)).toEqual({ kind: "none" });
    expect(s.client.state("http://other.test")).toEqual({ kind: "registered", clientId: "c-2" });
  });

  test("a banned token is dropped when the URL changes", async () => {
    const s = setup();
    await addBattles(2);
    s.server.onObservations = (r) => (r.url.startsWith(BASE) ? { status: 403 } : null);
    expect(await s.client.send(db, BASE)).toEqual({ status: "banned" });
    expect((await s.client.send(db, "http://other.test")).status).toBe("sent");
  });
});
