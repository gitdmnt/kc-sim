// Screen views (src/routes/views.ts): each body is exactly the union of the per-resource responses it replaces.
import { beforeEach, describe, expect, test } from "bun:test";
import { harness, seedBasic, type Harness } from "./helpers";

// Response bodies are compared, not typed.
type Row = Record<string, any>;
let h: Harness;
const get = async (path: string) => {
  const r = await h.call<Row>("GET", path);
  expect(r.status).toBe(200);
  return r.json;
};

beforeEach(async () => {
  h = harness();
  const db = h.db;
  await seedBasic(db);
  const NOW = "2026-10-01T00:00:00Z";
  await db.batch([
    db.prepare(`INSERT INTO sources (key, name, fetched_at) VALUES ('kcnav', 'KCNav', ?1), ('kancolle-replay-shipdata', 'kcr', ?1)`).bind(NOW),
    ...["A", "D", "J"].map((l) => db.prepare("INSERT INTO nodes (map_id, letter, event_id, is_boss) VALUES (15, ?1, 4, ?2)").bind(l, l === "J" ? 1 : 0)),
    // J: two difficulties; D: one comp with an escort fleet. 1503 and 1575 are in no comp.
    ...[[900, "J", 0], [910, "J", 2], [920, "D", 0]].map(([id, node, diff]) => db.prepare(
      `INSERT INTO enemy_comp_sets (id, map_id, node_letter, difficulty, total_count, retrieved_at, source_id)
       VALUES (?1, 15, ?2, ?3, 10, ?4, (SELECT id FROM sources WHERE key = 'kcnav'))`).bind(id, node, diff, NOW)),
    ...[[901, 900], [911, 910], [921, 920]].map(([id, set]) => db.prepare(
      "INSERT INTO enemy_comps (id, set_id, kcnav_master_id, formation, count, weight) VALUES (?1, ?2, 7, 1, 10, 1)").bind(id, set)),
    ...[[901, 0, 0, 1530], [901, 0, 1, 1501], [911, 0, 0, 1530], [921, 0, 0, 1502], [921, 1, 0, 1501]].map(([comp, fleet, pos, ship]) => db.prepare(
      `INSERT INTO enemy_comp_ships (comp_id, fleet, position, ship_id, level, equips) VALUES (?1, ?2, ?3, ?4, 1, '[1505]')`).bind(comp, fleet, pos, ship)),
    db.prepare(`INSERT INTO estimates (ship_id, stat, value, confidence, source_id, updated_at)
      VALUES (1501, 'ev', 14, 'datamined', (SELECT id FROM sources WHERE key = 'kancolle-replay-shipdata'), ?1)`).bind(NOW),
    ...[[1501, "ev"], [1501, "luck"], [1530, "acc"]].map(([ship, stat]) => db.prepare(
      `INSERT INTO estimator_posteriors (ship_id, stat, mean, sd, ci_lo, ci_hi, n, prior, density, updated_at)
       VALUES (?1, ?2, 12.5, 1, 11, 14, 40, '{"source":"flat"}', '{"min":0,"step":1,"posterior":[1],"prior":[1]}', ?3)`).bind(ship, stat, NOW)),
    db.prepare(`INSERT INTO fit_bonuses (id, equip_ids, equip_types, bonuses) VALUES (0, '[2]', NULL, '[{"shipType":[2],"bonus":{"houg":1}}]')`),
    db.prepare(`INSERT INTO event_bonuses (map_id, date, note, bonuses, lbas_bonuses, debuffs) VALUES (601, '2026-09-01', NULL, '[{"nodes":["A"],"dmg":1.1}]', '[]', '[]')`),
  ]);
});

describe("views", () => {
  test("boot = GET /maps + /equipments?abyssal=1 + /fit-bonuses, with the data version", async () => {
    await h.db.prepare("INSERT OR REPLACE INTO kv_state (key, value) VALUES ('data_version', '7')").run();
    const boot = await get("/api/v1/views/boot");
    expect(boot).toEqual({
      dataVersion: 7,
      maps: (await get("/api/v1/maps")).maps,
      equipments: (await get("/api/v1/equipments?abyssal=1")).equipments,
      fitBonuses: (await get("/api/v1/fit-bonuses")).fitBonuses,
    });
    expect((boot.equipments as Row[]).map((e) => e.id)).toEqual([1505, 1506]);
    expect(boot.fitBonuses).toHaveLength(1);
  });

  test("map = GET /maps/{map} + every node's enemy-comps + /ships/{id} of their ships + /maps/{map}/bonuses", async () => {
    for (const q of ["", "?minObserved=3", "?difficulty=2"]) {
      const v = await get(`/api/v1/views/map/1-5${q}`);
      expect(v.detail).toEqual(await get("/api/v1/maps/1-5"));
      const nodes: Record<string, Row> = {};
      for (const n of q === "?difficulty=2" ? ["J"] : ["D", "J"]) {
        const one = await get(`/api/v1/maps/1-5/nodes/${n}/enemy-comps${q}`);
        nodes[n] = { selection: one.selection, sets: one.sets };
      }
      expect(v.enemyComps).toEqual({ map: "1-5", minObserved: q === "?minObserved=3" ? 3 : 30, source: "auto", nodes });
      const ids = q === "?difficulty=2" ? [1530] : [1501, 1502, 1530];
      expect(v.ships).toEqual(await Promise.all(ids.map((id) => get(`/api/v1/ships/${id}`))));
      expect(v.bonuses).toBeNull();
    }
    const event = await get("/api/v1/views/map/60-1");
    expect(event.bonuses).toEqual(await get("/api/v1/maps/60-1/bonuses"));
    expect(event).toMatchObject({ enemyComps: { nodes: {} }, ships: [] });
  });

  test("map: 400 on a bad key or query, 404 on an unknown map", async () => {
    expect((await h.call("GET", "/api/v1/views/map/x")).status).toBe(400);
    expect((await h.call("GET", "/api/v1/views/map/1-5?source=foo")).status).toBe(400);
    expect((await h.call("GET", "/api/v1/views/map/1-6")).status).toBe(404);
  });

  test("enemy = GET /ships?abyssal=1 + /estimates?density=0 + the first ship's detail view", async () => {
    const v = await get("/api/v1/views/enemy");
    expect(v.ships).toEqual((await get("/api/v1/ships?abyssal=1")).ships);
    expect(v.estimates).toEqual(await get("/api/v1/estimates?density=0"));
    expect(v.ships[0].id).toBe(1501);
    expect(v.firstShip).toEqual(await get("/api/v1/views/enemy/1501"));
  });

  test("enemy ship = GET /ships/{id} + /estimates?shipId={id}&density=1; 400 / 404", async () => {
    for (const id of [1501, 1530, 1503]) {
      const v = await get(`/api/v1/views/enemy/${id}`);
      expect(v).toEqual({ detail: await get(`/api/v1/ships/${id}`), estimates: await get(`/api/v1/estimates?shipId=${id}&density=1`) });
      expect(v.estimates.estimates.every((r: Row) => r.density)).toBe(true);
    }
    expect((await get("/api/v1/views/enemy/1501")).detail).toMatchObject({ estimates: [{ stat: "ev", value: 14 }], best: { ev: { value: 14 } } });
    for (const id of ["0", "x", "1.5"]) expect((await h.call("GET", `/api/v1/views/enemy/${id}`)).status).toBe(400);
    expect((await h.call("GET", "/api/v1/views/enemy/9999")).status).toBe(404);
  });

  test("enemy with no abyssal ships: empty list, firstShip null", async () => {
    await h.db.prepare("DELETE FROM ships WHERE is_abyssal = 1").run();
    expect(await get("/api/v1/views/enemy")).toEqual({ ships: [], estimates: await get("/api/v1/estimates?density=0"), firstShip: null });
  });
});
