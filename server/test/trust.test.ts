// Trust model (src/auth/trust.ts): probation and promotion, distinct reporters for the current layout, per-client
// daily caps on the comp counts.
import { beforeEach, describe, expect, test } from "bun:test";
import { CLIENT_CELL_DAY_CAP, MIN_ACCEPTED, PROBATION_MS } from "../src/auth/trust";
import { currentLayout } from "../src/observed/aggregate";
import { battleResponse, drainJobs, fleet, harness, LAYOUT_15, seedBasic, sortieOf, uploadAndProcess, type Harness } from "./helpers";

let h: Harness;
let n = 0;
beforeEach(async () => {
  h = harness();
  await seedBasic(h.db);
});

const battle = (o: Record<string, unknown> = {}) => ({
  clientObsId: `b${++n}`, observedAt: new Date(h.clock.t - 60_000).toISOString(), map: "1-5", cell: 12, layout: LAYOUT_15, difficulty: 0,
  kind: "battle", fleet: fleet(),
  raw: { path: "api_req_sortie/battle", visitId: `v${n}`, sortieId: null as string | null, raw: battleResponse([1530, 1501, 1501]), result: null },
  ...o,
});
/** `k` battles at cell 12 and the sortie that lists them (8 per sortie). */
const linkedBattles = (k: number, o: Record<string, unknown> = {}) => {
  const out: unknown[] = [];
  for (let i = 0; i < k; i += 8) {
    const bs = Array.from({ length: Math.min(8, k - i) }, () => battle(o));
    out.push(...bs, sortieOf(bs));
  }
  return out;
};
const count = async (sql: string) => (await h.db.prepare(sql).first<{ n: number }>())!.n;
const comps = () => count("SELECT COALESCE(SUM(count), 0) AS n FROM poi_comp_counts");

describe("probation", () => {
  test("a new client's observations are stored but wait; promotion after 3 days, enough data on 2 days, folds them", async () => {
    const { clientId, token } = await h.register("198.51.100.50", { probation: true });
    expect(await uploadAndProcess(h, token, linkedBattles(16))).toMatchObject({ accepted: 18, quarantined: 0 });
    expect(await comps()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM observation_ships WHERE est_at IS NULL")).toBeGreaterThan(0);
    // not yet: too young, too little, one upload day
    h.clock.t += PROBATION_MS;
    await drainJobs(h);
    expect(await comps()).toBe(0);
    // a second day with more data
    h.clock.t += 86_400_000;
    expect(MIN_ACCEPTED).toBeLessThanOrEqual(36);
    await uploadAndProcess(h, token, linkedBattles(16));
    // the next jobs run promotes (promotion runs at the start of a run, on what is stored)
    await drainJobs(h);
    expect(await h.db.prepare("SELECT trusted_at IS NOT NULL AS t FROM clients WHERE id = ?1").bind(clientId).first()).toEqual({ t: 1 });
    expect(await comps()).toBe(32);
  });

  test("a client with mostly rejected uploads, or a banned one, is not promoted", async () => {
    const bad = await h.register("198.51.100.51", { probation: true });
    await uploadAndProcess(h, bad.token, [...linkedBattles(24), ...Array.from({ length: 10 }, () => battle({ map: "9-9" }))]);
    h.clock.t += PROBATION_MS + 86_400_000;
    await uploadAndProcess(h, bad.token, linkedBattles(8));
    expect(await h.db.prepare("SELECT trusted_at FROM clients WHERE id = ?1").bind(bad.clientId).first()).toEqual({ trusted_at: null });
    expect(await comps()).toBe(0);
  });
});

describe("current layout", () => {
  const L = (layout: string, version: number) => ({ layout, version });
  test("a newer layout needs MIN_REPORTERS reporters, or everyone who reported the current one", () => {
    const layouts = [L("a", 1), L("b", 2)];
    expect(currentLayout(layouts, [{ layout: "a", ip_hash: "x" }, { layout: "b", ip_hash: "evil" }])).toBe("a");
    expect(currentLayout(layouts, [{ layout: "a", ip_hash: "x" }, { layout: "b", ip_hash: "x" }])).toBe("b");
    expect(currentLayout(layouts, [{ layout: "a", ip_hash: "x" }, { layout: "b", ip_hash: "y" }, { layout: "b", ip_hash: "z" }])).toBe("b");
    expect(currentLayout([L("", 0)], [])).toBe("");
  });

  test("one client's fabricated layout does not retire the layout others report", async () => {
    const owner = await h.register("198.51.100.60");
    const other = await h.register("198.51.100.61");
    await uploadAndProcess(h, owner.token, linkedBattles(2));
    await uploadAndProcess(h, other.token, linkedBattles(1, { layout: [...LAYOUT_15, 13] }));
    const rows = (await h.db.prepare("SELECT layout, version, current FROM poi_layouts ORDER BY version").all()).results;
    expect(rows).toEqual([
      { layout: LAYOUT_15.join(","), version: 1, current: 1 },
      { layout: [...LAYOUT_15, 13].join(","), version: 2, current: 0 },
    ]);
    const open = await h.db.prepare("SELECT layout, reporters FROM enemy_comp_sets WHERE period_end = '' AND source_id = (SELECT id FROM sources WHERE key = 'poi-observed')").all();
    expect(open.results).toEqual([{ layout: 1, reporters: 1 }]);
  });
});

describe("per-client daily caps", () => {
  test(`at most ${CLIENT_CELL_DAY_CAP} battles per client, cell and upload day reach the comp counts`, async () => {
    const { token } = await h.register();
    for (let i = 0; i < 4; i++) expect((await uploadAndProcess(h, token, linkedBattles(24))).status).toBe(202);
    expect((await uploadAndProcess(h, token, linkedBattles(16))).status).toBe(202);
    expect(await comps()).toBe(CLIENT_CELL_DAY_CAP);
    expect(await count("SELECT COUNT(*) AS n FROM observations WHERE agg_error = 'client_cap'")).toBe(12);
    // the next day counts again
    h.clock.t += 86_400_000;
    await uploadAndProcess(h, token, linkedBattles(8));
    expect(await comps()).toBe(CLIENT_CELL_DAY_CAP + 8);
  });
});
