// SQL-built list bodies (src/routes/read.ts + jsonArraySql in src/assemble.ts): GET /ships, /equipments and
// /estimates must equal what the JS row mappers produced (the previous behaviour) on the same rows, and
// /estimates caps density=1 at 50 shipIds.
import { beforeEach, describe, expect, test } from "bun:test";
import { EQUIP_COLS, SHIP_COLS, equipJson, parseJson, shipJson } from "../src/assemble";
import { harness, seedMaster, type Harness } from "./helpers";

type Row = Record<string, unknown>;
type Estimates = { source: string; updatedAt: string | null; estimates: Row[] };
/** What c.json(...) of the JS-mapped rows sent. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

let h: Harness;
beforeEach(() => {
  h = harness();
});

const NOW = "2026-10-01T00:00:00Z";
async function seed() {
  await seedMaster(h.db, {
    ships: [{ id: 10, hp: 30, fp: 12, slots: [0, 0] }, { id: 1501, hp: null, fp: null, abyssal: true }],
    equips: [{ id: 1, fp: 2, acc: 1 }, { id: 1505, type: [3, 5, 6, 7, 0], ev: 3 }],
  });
  // nulls everywhere a column allows them, and JSON columns with non-canonical number text
  await h.db.prepare(
    `INSERT INTO ships (id, name, name_en, yomi, stype, ctype, speed, range, slot_num, is_abyssal, hp, fp, tp, aa, ar, luck, max_stats, slots, equips, flags, updated_at)
     VALUES (11, '吹雪', 'Fubuki', 'ふぶき', 2, 12, 10, 1, 2, 0, 15, 10, 27, 10, 5, 17, '{"hp": 31, "fp": 29.50, "luck": 49}', '[0, 0]', NULL, NULL, ?1),
            (1502, 'x "q"\\n', NULL, NULL, 9, NULL, NULL, NULL, NULL, 1, 4000, 0, 0, 0, 0, NULL, NULL, '[]', '[1505, -1]', '{"installation": true, "pt": false}', ?1)`,
  ).bind(NOW).run();
  await h.db.prepare(
    `INSERT INTO equipments (id, name, type, type_id, icon, fp, tp, aa, ar, bomb, asw, los, acc, ev, luck, range, radius, cost, is_abyssal, updated_at)
     VALUES (2, 'radar', '[5, 8, 12, 11, 0]', 12, 11, NULL, NULL, NULL, NULL, NULL, NULL, 5, 2, NULL, NULL, NULL, 4, 6, 0, ?1)`,
  ).bind(NOW).run();
}

const POSTERIORS: [number, string, number, number, number, number, number, string, string, string][] = [
  [1501, "luck", 1 / 3, 0.1 + 0.2, 30, 52.5, 412, '{"source":"flat","confidence":"none","value":null,"sd":58.30}', '{"min":0,"step":2,"posterior":[0.1,0.25,1e-06],"prior":[0.009901]}', "2026-10-20T00:00:00.000Z"],
  [1501, "ev", 41.23456789012345, 6.5, 30.000000000000004, 52, 3, '{"confidence":"none","value":40}', '{"min":10,"step":1,"posterior":[],"prior":[]}', "2026-10-21T00:00:00.000Z"],
  [1501, "acc", 2 / 3, 1e-7, -1.5, 1e21, 0, 'null', '{"min":0,"step":1,"posterior":[1],"prior":[1]}', "2026-10-19T00:00:00.000Z"],
  [10, "ev", 12, 0.5, 11, 13, 50, '{"source":"datamined","confidence":"high","value":12,"sd":1}', '{"min":0,"step":1,"posterior":[1],"prior":[1]}', "2026-10-18T00:00:00.000Z"],
];
async function seedPosteriors(ships: number[] = []) {
  const ins = `INSERT INTO estimator_posteriors (ship_id, stat, mean, sd, ci_lo, ci_hi, n, prior, density, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`;
  await h.db.batch([
    ...POSTERIORS.map((p) => h.db.prepare(ins).bind(...p)),
    ...ships.map((id) => h.db.prepare(ins).bind(id, "ev", 1, 1, 0, 2, 1, "{}", '{"min":0,"step":1,"posterior":[1],"prior":[1]}', "2026-10-01T00:00:00.000Z")),
  ]);
}

/** The pre-SQL mapping of GET /estimates (inline in read.ts), over the same filter and order. */
async function oldEstimates(where: string, withDensity: boolean) {
  const { results } = await h.db.prepare(
    `SELECT * FROM estimator_posteriors ${where} ORDER BY ship_id, CASE stat WHEN 'ev' THEN 0 WHEN 'acc' THEN 1 ELSE 2 END`,
  ).all<Row>();
  return wire(results.map((r) => {
    const prior = parseJson(r.prior);
    return {
      shipId: r.ship_id, stat: r.stat, mean: r.mean, sd: r.sd, ci90: [r.ci_lo, r.ci_hi], n: r.n,
      priorSource: prior?.source ?? "flat", prior,
      ...(withDensity ? { density: parseJson(r.density) } : {}),
      updatedAt: r.updated_at,
    };
  }));
}

describe("ships / equipments", () => {
  test("empty tables give []", async () => {
    expect((await h.call("GET", "/api/v1/ships")).json).toEqual({ ships: [] });
    expect((await h.call("GET", "/api/v1/equipments?abyssal=1")).json).toEqual({ equipments: [] });
  });

  test("same JSON as the JS mappers, in id order, for every abyssal filter", async () => {
    await seed();
    for (const [q, where] of [["", ""], ["?abyssal=1", "WHERE is_abyssal = 1"], ["?abyssal=true", "WHERE is_abyssal = 1"], ["?abyssal=0", "WHERE is_abyssal = 0"]]) {
      const ships = (await h.db.prepare(`SELECT ${SHIP_COLS} FROM ships ${where} ORDER BY id`).all<Row>()).results;
      const equips = (await h.db.prepare(`SELECT ${EQUIP_COLS} FROM equipments ${where} ORDER BY id`).all<Row>()).results;
      expect(ships.length).toBeGreaterThan(0);
      const s = await h.call("GET", `/api/v1/ships${q}`);
      expect(s.status).toBe(200);
      expect(s.headers.get("Content-Type")).toStartWith("application/json");
      expect(s.json).toEqual({ ships: wire(ships.map(shipJson)) });
      expect((await h.call("GET", `/api/v1/equipments${q}`)).json).toEqual({ equipments: wire(equips.map(equipJson)) });
    }
  });

  test("shape is the documented one (pinned) and matches the single-row endpoints", async () => {
    await seed();
    const { ships } = (await h.call<{ ships: Row[] }>("GET", "/api/v1/ships")).json;
    expect(ships.map((s) => s.id)).toEqual([10, 11, 1501, 1502]);
    expect(ships[1]).toEqual({
      id: 11, name: "吹雪", nameEn: "Fubuki", yomi: "ふぶき", stype: 2, ctype: 12, speed: 10, range: 1, slotNum: 2, isAbyssal: false,
      hp: 15, fp: 10, tp: 27, aa: 10, ar: 5, luck: 17, maxStats: { hp: 31, fp: 29.5, luck: 49 }, slots: [0, 0], equips: null, flags: null,
    });
    expect(ships[3]).toMatchObject({ name: 'x "q"\\n', nameEn: null, ctype: null, isAbyssal: true, luck: null, equips: [1505, -1], flags: { installation: true, pt: false } });
    for (const s of ships) expect((await h.call<{ ship: Row }>("GET", `/api/v1/ships/${s.id}`)).json.ship).toEqual(s);
    const { equipments } = (await h.call<{ equipments: Row[] }>("GET", "/api/v1/equipments")).json;
    expect(equipments[1]).toEqual({
      id: 2, name: "radar", type: [5, 8, 12, 11, 0], typeId: 12, icon: 11, fp: null, tp: null, aa: null, ar: null, bomb: null, asw: null,
      los: 5, acc: 2, ev: null, luck: null, range: null, radius: 4, cost: 6, isAbyssal: false,
    });
    for (const e of equipments) expect((await h.call<{ equipment: Row }>("GET", `/api/v1/equipments/${e.id}`)).json.equipment).toEqual(e);
  });

  test("stored JSON text is passed through, not re-printed", async () => {
    await seed();
    expect(await (await h.fetch("http://localhost/api/v1/ships")).text()).toContain('"maxStats":{"hp":31,"fp":29.50,"luck":49}');
  });
});

describe("estimates", () => {
  test("empty: [] and updatedAt null", async () => {
    expect((await h.call("GET", "/api/v1/estimates")).json).toEqual({ source: "estimator:server", updatedAt: null, estimates: [] });
  });

  test("same JSON as the old mapping (REAL columns round-trip exactly), filters and order kept", async () => {
    await seedPosteriors();
    const env = { source: "estimator:server", updatedAt: "2026-10-21T00:00:00.000Z" };
    const cases: [string, string, boolean][] = [
      ["", "", false],
      ["?density=0", "", false],
      ["?shipId=1501", "WHERE ship_id = 1501", true],
      ["?shipId=1501,10&density=1", "WHERE ship_id IN (1501, 10)", true],
      ["?shipId=1501&density=0", "WHERE ship_id = 1501", false],
      ["?shipId=1501&stat=ev,luck", "WHERE ship_id = 1501 AND stat IN ('ev', 'luck')", true],
      ["?minN=50", "WHERE n >= 50", false],
      ["?minN=100000", "WHERE n >= 100000", false],
    ];
    for (const [q, where, withDensity] of cases) {
      const r = await h.call<Estimates>("GET", `/api/v1/estimates${q}`);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ...env, estimates: await oldEstimates(where, withDensity) });
    }
    const all = (await h.call<Estimates>("GET", "/api/v1/estimates?shipId=1501")).json.estimates;
    expect(all.map((e) => e.stat)).toEqual(["ev", "acc", "luck"]);
    expect(all[2]).toMatchObject({ mean: 1 / 3, sd: 0.1 + 0.2, ci90: [30, 52.5], priorSource: "flat" });
    expect(all[0]).toMatchObject({ mean: 41.23456789012345, ci90: [30.000000000000004, 52], priorSource: "flat" });
    expect(all[1]).toMatchObject({ sd: 1e-7, ci90: [-1.5, 1e21], prior: null, priorSource: "flat" });
  });

  test("density=1 needs shipId with at most 50 ids; defaults never 400", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => 2000 + i);
    await seedPosteriors(ids);
    const err = { error: "density=1 requires shipId with at most 50 ids" };
    for (const q of ["density=1", `shipId=${ids.join(",")}&density=1`, "stat=ev&density=1"]) {
      const r = await h.call("GET", `/api/v1/estimates?${q}`);
      expect(r.status).toBe(400);
      expect(r.json).toEqual(err);
    }
    const ok = async (q: string) => {
      const r = await h.call<Estimates>("GET", `/api/v1/estimates?${q}`);
      expect(r.status).toBe(200);
      return r.json.estimates;
    };
    const fifty = await ok(`shipId=${ids.slice(0, 50).join(",")}&density=1`);
    expect(fifty).toHaveLength(50);
    expect(fifty.every((e) => e.density !== undefined)).toBe(true);
    const fiftyDefault = await ok(`shipId=${ids.slice(0, 50).join(",")}`);
    expect(fiftyDefault.every((e) => e.density !== undefined)).toBe(true);
    for (const q of [`shipId=${ids.join(",")}`, `shipId=${ids.join(",")}&density=0`, "density=0", ""]) {
      const rows = await ok(q);
      expect(rows.length).toBeGreaterThanOrEqual(51);
      expect(rows.some((e) => "density" in e)).toBe(false);
    }
  });

  test("other validation errors are unchanged", async () => {
    const cases: [string, string][] = [
      ["shipId=x", "shipId must be up to 200 positive integers"],
      ["shipId=0", "shipId must be up to 200 positive integers"],
      [`shipId=${Array.from({ length: 201 }, (_, i) => i + 1).join(",")}`, "shipId must be up to 200 positive integers"],
      ["stat=hp", "stat must be one of ev, acc, luck"],
      ["minN=-1", "minN must be a non-negative integer"],
      ["minN=1.5", "minN must be a non-negative integer"],
      ["density=2", "density must be 0 or 1"],
    ];
    for (const [q, error] of cases) {
      const r = await h.call("GET", `/api/v1/estimates?${q}`);
      expect([r.status, r.json]).toEqual([400, { error }]);
    }
  });
});
