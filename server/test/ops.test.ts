// Write-side operations (src/ops.ts, src/ingest/revalidate.ts, admin routes): IP bans, bulk purge, re-validation of
// stored observations, write statistics and alerts.
import { beforeEach, describe, expect, test } from "bun:test";
import { hashIp, ipKey } from "../src/auth/clients";
import { ALERTS, writeStats } from "../src/ops";
import { battleResponse, drainJobs, fleet, harness, LAYOUT_15, seedBasic, sortieOf, uploadAndProcess, type Harness } from "./helpers";

let h: Harness;
let n = 0;
beforeEach(async () => {
  h = harness();
  await seedBasic(h.db);
});

const battle = () => ({
  clientObsId: `b${++n}`, observedAt: new Date(h.clock.t - 60_000).toISOString(), map: "1-5", cell: 12, layout: LAYOUT_15, difficulty: 0,
  kind: "battle", fleet: fleet(),
  raw: { path: "api_req_sortie/battle", visitId: `v${n}`, sortieId: null as string | null, raw: battleResponse([1530, 1501, 1501]), result: null },
});
const linked = () => {
  const b = battle();
  return [b, sortieOf([b])];
};
const count = async (sql: string) => (await h.db.prepare(sql).first<{ n: number }>())!.n;
const ipHashOf = (ip: string) => hashIp(ipKey(ip), "test-salt");

describe("IP bans and bulk purge", () => {
  test("a banned address cannot register; its clients' uploads get 403", async () => {
    const ip = "198.51.100.70";
    const { token } = await h.register(ip);
    const r = await h.call("POST", `/admin/ips/${await ipHashOf(ip)}/ban`, { body: { reason: "sybils" } });
    expect(r.json).toMatchObject({ banned: true });
    expect((await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": ip } })).status).toBe(403);
    // the client's registration address is banned, whatever address it uploads from
    h.clock.t += 61_000;
    expect((await h.call("POST", "/api/v1/observations", { token, body: { observations: linked() }, headers: { "CF-Connecting-IP": "203.0.113.99" } })).status).toBe(403);
    expect((await h.call("DELETE", `/admin/ips/${await ipHashOf(ip)}/ban`)).json).toMatchObject({ unbanned: true });
    expect((await h.call("POST", "/api/v1/clients", { headers: { "CF-Connecting-IP": ip } })).status).toBe(201);
  });

  test("purge by registration address removes the clients' data, refolds the rest, bans them", async () => {
    const keep = await h.register("198.51.100.80");
    await uploadAndProcess(h, keep.token, linked());
    const ip = "198.51.100.81";
    const a = await h.register(ip);
    const b = await h.register(ip);
    await uploadAndProcess(h, a.token, [...linked(), ...linked()]);
    await uploadAndProcess(h, b.token, linked());
    expect(await count("SELECT COALESCE(SUM(count), 0) AS n FROM poi_comp_counts")).toBe(4);
    const list = await h.call<{ clients: { id: string }[] }>("GET", `/admin/clients?ipHash=${await ipHashOf(ip)}`);
    expect(list.json.clients.map((c) => c.id).sort()).toEqual([a.clientId, b.clientId].sort());
    expect((await h.call("POST", "/admin/clients/purge", { body: {} })).status).toBe(400);
    const r = await h.call("POST", "/admin/clients/purge", { body: { ipHash: await ipHashOf(ip), banIp: true, reason: "test" } });
    expect(r.json).toMatchObject({ clients: 2, deleted: 6, maps: ["1-5"], banned: true, ipBanned: true });
    await drainJobs(h);
    expect(await count("SELECT COALESCE(SUM(count), 0) AS n FROM poi_comp_counts")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM clients WHERE banned_at IS NOT NULL")).toBe(2);
    h.clock.t += 61_000;
    expect((await h.call("POST", "/api/v1/observations", { token: a.token, body: { observations: linked() } })).status).toBe(403);
  });
});

describe("re-validation", () => {
  test("rows stored under older rules get today's verdict; their maps are refolded", async () => {
    const { token } = await h.register();
    const [b, s] = linked();
    await uploadAndProcess(h, token, [b, s]);
    expect(await count("SELECT COALESCE(SUM(count), 0) AS n FROM poi_comp_counts")).toBe(1);
    // as if stored before the linkage rule: a battle whose sortie is gone
    await h.db.prepare("DELETE FROM observations WHERE kind = 'sortie'").run();
    const r = await h.call<{ checked: number; changed: number; next: number | null; maps: string[] }>("POST", "/admin/observations/revalidate?limit=10");
    expect(r.json).toMatchObject({ checked: 1, changed: 1, next: null, maps: ["1-5"] });
    expect(await h.db.prepare("SELECT quarantine FROM observations").first()).toEqual({ quarantine: "unlinked" });
    await drainJobs(h);
    expect(await count("SELECT COALESCE(SUM(count), 0) AS n FROM poi_comp_counts")).toBe(0);
    // nothing changes the second time
    expect((await h.call("POST", "/admin/observations/revalidate")).json).toMatchObject({ changed: 0 });
  });
});

describe("write statistics", () => {
  test("alerts trip on a registration wave and a growing backlog", async () => {
    expect((await writeStats(h.db, h.clock.t)).alerts).toEqual([]);
    for (let i = 0; i <= ALERTS.newClientAddresses; i++) await h.register(`198.51.100.${100 + i}`);
    await h.db.prepare("UPDATE kv_state SET value = ?1 WHERE key = 'staged_items'").bind(String(ALERTS.stagedItems + 1)).run();
    const r = await h.call<{ stats: { newClients: number }; alerts: string[] }>("GET", "/admin/writes/status");
    expect(r.json.stats.newClients).toBe(ALERTS.newClientAddresses + 1);
    expect(r.json.alerts).toHaveLength(2);
  });
});
