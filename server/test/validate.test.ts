// Server-side re-derivation and validation rules (src/ingest/validate.ts): one test per rule, through the
// upload endpoint and the jobs that process it, checking the outcome, the stored row and observation_rejections.
import { beforeEach, describe, expect, test } from "bun:test";
import type { AttackEvent } from "../../shared/capture/types";
import { battlePacket } from "../../shared/estimate/synthetic";
import { battleResponse, ENEMIES, fleet, FRIENDS, harness, LAYOUT_15, mapPackets, seedBasic, sortieOf, uploadAndProcess, type Harness } from "./helpers";

let h: Harness;
let token: string;
let clientId: string;
let n = 0;
beforeEach(async () => {
  h = harness();
  await seedBasic(h.db);
  ({ token, clientId } = await h.register());
});

const battle = (o: { raw?: Record<string, unknown>; path?: string; visitId?: string } & Record<string, unknown> = {}) => {
  const { raw, path, visitId, ...rest } = o;
  return {
    clientObsId: `b${++n}`, observedAt: new Date(h.clock.t - 60_000).toISOString(), map: "1-5", cell: 1, layout: LAYOUT_15, difficulty: 0,
    kind: "battle", fleet: fleet(),
    raw: { path: path ?? "api_req_sortie/battle", visitId: visitId ?? `v${n}`, sortieId: null as string | null, raw: raw ?? battleResponse([1501, 1502]), result: null },
    ...rest,
  };
};
const cellOf = (no: number, from: number | null, eventId: number, next: number) =>
  ({ no, from, colorNo: 4, eventId, eventKind: 1, bossCellNo: 12, next, selectCells: null, battles: [] as string[] });
const sortie = (o: Record<string, unknown> = {}) => {
  const cells = (o.sortie as { cells?: ReturnType<typeof cellOf>[] } | undefined)?.cells ?? [cellOf(1, null, 4, 1), cellOf(4, 1, 4, 2)];
  return {
    clientObsId: `s${++n}`, observedAt: new Date(h.clock.t - 60_000).toISOString(), map: "1-5", layout: LAYOUT_15, difficulty: 0, kind: "sortie",
    fleet: fleet(),
    sortie: { deckId: 1, combined: 0, endKind: "boss", endedAt: null, cells, cellData: null, features: null },
    raw: { packets: mapPackets(15, cells) },
    ...o,
  };
};
/** Battles plus the sortie that links them (a battle alone is quarantined 'unlinked'). */
const linked = (...battles: ReturnType<typeof battle>[]) => [...battles, sortieOf(battles)];
const upload = async (observations: unknown[]) => {
  const r = await uploadAndProcess(h, token, observations);
  expect(r.status).toBe(202);
  return r;
};
const findings = (action?: string) =>
  h.db.prepare("SELECT client_obs_id, rule, action, observation_id IS NOT NULL AS stored FROM observation_rejections WHERE (?1 IS NULL OR action = ?1) ORDER BY id")
    .bind(action ?? null).all<{ client_obs_id: string; rule: string; action: string; stored: number }>().then((r) => r.results);
/** Asserts that `o` is rejected with `rule` (and not stored). */
const rejects = async (o: { clientObsId: string }, rule: string) => {
  const r = await upload([o]);
  expect(r.accepted).toBe(0);
  expect(r.rejected.map((x) => x.rule)).toContain(rule);
  expect((await findings("reject")).filter((f) => f.client_obs_id === o.clientObsId).map((f) => f.rule)).toContain(rule);
  expect(await h.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE client_obs_id = ?1").bind(o.clientObsId).first()).toEqual({ n: 0 });
};
const quarantines = async (o: { clientObsId: string }, rule: string) => {
  const r = await upload("cell" in o ? linked(o as ReturnType<typeof battle>) : [o]);
  expect(r).toMatchObject({ quarantined: 1, rejected: [] });
  const row = await h.db.prepare("SELECT quarantine FROM observations WHERE client_obs_id = ?1").bind(o.clientObsId).first<{ quarantine: string }>();
  expect(row?.quarantine?.split(",")).toContain(rule);
  expect((await findings("quarantine")).find((f) => f.client_obs_id === o.clientObsId)).toMatchObject({ rule, stored: 1 });
};
const flags = async (o: { clientObsId: string }, rule: string) => {
  const r = await upload("cell" in o ? linked(o as ReturnType<typeof battle>) : [o]);
  expect(r).toMatchObject({ rejected: [] });
  expect(r.flagged).toBeGreaterThan(0);
  expect((await findings("flag")).filter((f) => f.client_obs_id === o.clientObsId).map((f) => f.rule)).toContain(rule);
  expect(await h.db.prepare("SELECT quarantine FROM observations WHERE client_obs_id = ?1").bind(o.clientObsId).first()).toEqual({ quarantine: null });
};

const hit = (attackerSide: "friend" | "enemy", attackerIdx: number, defenderIdx: number, damage: number): AttackEvent => ({
  seq: 0, phase: "shelling1", attackerSide, attackerIdx, defenderSide: attackerSide === "friend" ? "enemy" : "friend", defenderIdx,
  attackType: 0, hit: "hit", damage, protected: false,
});

describe("accepted", () => {
  test("a clean battle and sortie are stored with the server-derived enemy; nothing recorded", async () => {
    const b = battle({ enemy: { ships: [{ masterId: 999 }] } }); // client summary is ignored (cross-check flag only)
    const s = sortie({ raw: { packets: [
      { path: "api_req_map/start", body: { api_maparea_id: 1, api_mapinfo_no: 5, api_no: 1, api_event_id: 4, api_next: 1, api_cell_data: LAYOUT_15.map((no) => ({ api_no: no })) } },
      { path: "api_req_map/next", body: { api_maparea_id: 1, api_mapinfo_no: 5, api_no: 4, api_from_no: 1, api_event_id: 4, api_next: 2 } },
    ] } });
    s.sortie.cells[0]!.battles.push(b.clientObsId);
    b.raw.sortieId = s.clientObsId;
    const r = await upload([b, s]);
    expect(r).toMatchObject({ accepted: 2, rejected: [], quarantined: 0 });
    const enemy = JSON.parse((await h.db.prepare("SELECT enemy FROM observations WHERE client_obs_id = ?1").bind(b.clientObsId).first<{ enemy: string }>())!.enemy);
    expect(enemy.ships.map((s: { masterId: number; maxHp: number }) => [s.masterId, s.maxHp])).toEqual([[1501, 20], [1502, 24]]);
    expect((await findings()).map((f) => f.rule)).toEqual(["client_mismatch"]);
    // the battle is queued for the estimator, per enemy ship
    expect((await h.db.prepare("SELECT ship_id FROM observation_ships ORDER BY ship_id").all()).results).toEqual([{ ship_id: 1501 }, { ship_id: 1502 }]);
  });
});

describe("battle ↔ sortie linkage", () => {
  test("a battle without its sortie is quarantined 'unlinked' (still queued, not estimated) until the sortie releases it", async () => {
    const b = battle();
    const s = sortieOf([b]);
    expect(await upload([b])).toMatchObject({ accepted: 1, quarantined: 1 });
    expect(await h.db.prepare("SELECT quarantine, layout FROM observations WHERE client_obs_id = ?1").bind(b.clientObsId).first()).toEqual({ quarantine: "unlinked", layout: LAYOUT_15.join(",") });
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM poi_comp_counts").first()).toEqual({ n: 0 });
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM observation_ships WHERE est_at IS NULL").first()).toEqual({ n: 2 });
    expect(await upload([s])).toMatchObject({ accepted: 1, quarantined: 0 });
    expect(await h.db.prepare("SELECT quarantine FROM observations WHERE client_obs_id = ?1").bind(b.clientObsId).first()).toEqual({ quarantine: null });
    expect(await h.db.prepare("SELECT SUM(count) AS n FROM poi_comp_counts").first()).toEqual({ n: 1 });
  });

  test("the battle's layout is the sortie's; a battle the sortie does not list, or with no sortie id, stays unlinked", async () => {
    const b = battle();
    const stray = battle({ cell: 4 });
    const orphan = battle();
    const s = sortieOf([b]);
    b.layout = [0, 1]; // the client's claim; the sortie's api_cell_data decides
    stray.raw.sortieId = s.clientObsId;
    const r = await upload([b, stray, orphan, s]);
    expect(r).toMatchObject({ accepted: 4, quarantined: 2 });
    const q = (id: string) => h.db.prepare("SELECT quarantine, layout FROM observations WHERE client_obs_id = ?1").bind(id).first();
    expect(await q(b.clientObsId)).toEqual({ quarantine: null, layout: LAYOUT_15.join(",") });
    expect(await q(stray.clientObsId)).toMatchObject({ quarantine: "unlinked" });
    expect(await q(orphan.clientObsId)).toMatchObject({ quarantine: "unlinked" });
  });

  test("enemy_slots: a loadout other than the master's is quarantined on normal maps, flagged on event maps", async () => {
    await quarantines(battle({ raw: battleResponse([1501], 1, { api_eSlot: [[1506, -1, -1, -1, -1]] }) }), "enemy_slots");
    await flags(battle({ map: "60-1", difficulty: 4, layout: null, cell: 3, raw: battleResponse([1501], 1, { api_eSlot: [[1506, -1, -1, -1, -1]] }) }), "enemy_slots");
  });
});

describe("reject", () => {
  test("schema: malformed observation (other observations of the batch still count)", async () => {
    const bad = { ...battle(), cell: "x" };
    const r = await upload([bad, battle()]);
    expect(r).toMatchObject({ accepted: 1, rejected: [{ clientObsId: bad.clientObsId, rule: "schema" }] });
  });
  test("timestamp: in the future or older than 30 days", async () => {
    await rejects(battle({ observedAt: new Date(h.clock.t + 10 * 60_000).toISOString() }), "timestamp");
    await rejects(battle({ observedAt: new Date(h.clock.t - 31 * 24 * 3600_000).toISOString() }), "timestamp");
  });
  test("map_unknown", () => rejects(battle({ map: "9-9" }), "map_unknown"));
  test("difficulty out of range for the map kind", () => rejects(battle({ difficulty: 2 }), "difficulty"));
  test("cell_unknown: not in the sortie layout, or not a known cell of the map", async () => {
    await rejects(battle({ cell: 13 }), "cell_unknown");
    await rejects(battle({ cell: 40, layout: null }), "cell_unknown");
    await rejects(sortie({ sortie: { ...sortie().sortie, cells: [cellOf(1, null, 4, 1), cellOf(55, 1, 4, 0)] }, layout: null }), "cell_unknown");
  });
  test("raw_invalid: not a battle path; no enemy ships; bad map packets", async () => {
    await rejects(battle({ path: "api_req_map/next" }), "raw_invalid");
    await rejects(battle({ raw: battleResponse([1501], 1, { api_ship_ke: [-1, -1, -1, -1, -1, -1] }) }), "raw_invalid");
    await rejects(sortie({ raw: { packets: [{ path: "api_req_map/next", body: { api_no: 1 } }, { path: "api_req_map/next", body: { api_no: 4 } }] } }), "raw_invalid");
  });
  test("raw_mismatch: packets of another map or for other cells", async () => {
    const p = (no: number, map = 5) => ({ path: no === 1 ? "api_req_map/start" : "api_req_map/next", body: { api_maparea_id: 1, api_mapinfo_no: map, api_no: no } });
    await rejects(sortie({ raw: { packets: [p(1, 4), p(4, 4)] } }), "raw_mismatch");
    await rejects(sortie({ raw: { packets: [p(1)] } }), "raw_mismatch");
  });
  test("formation / engagement out of range", async () => {
    await rejects(battle({ raw: battleResponse([1501], 1, { api_formation: [7, 1, 1] }) }), "formation");
    await rejects(battle({ raw: battleResponse([1501], 1, { api_formation: [1, 1, 5] }) }), "formation");
  });
  test("enemy_ship_unknown: unknown id or not abyssal", async () => {
    await rejects(battle({ raw: battleResponse([1501], 1, { api_ship_ke: [1599] }) }), "enemy_ship_unknown");
    await rejects(battle({ raw: battleResponse([1501], 1, { api_ship_ke: [FRIENDS[0]!.id] }) }), "enemy_ship_unknown");
  });
  test("enemy_stats on a normal map: HP / FP / TP / AA / AR must match the master", async () => {
    await rejects(battle({ raw: battleResponse([1501], 1, { api_e_maxhps: [ENEMIES[1501]!.hp + 5] }) }), "enemy_stats");
    await rejects(battle({ raw: battleResponse([1501], 1, { api_eParam: [[5, 15, 6, 99]] }) }), "enemy_stats");
  });
  test("equipment_unknown: enemy slots and friend equipment", async () => {
    await rejects(battle({ raw: battleResponse([1501], 1, { api_eSlot: [[9999, -1, -1, -1, -1]] }) }), "equipment_unknown");
    const f = fleet();
    f.ships[0]!.equips = [{ masterId: 9998, improvement: 0, proficiency: 0 }, null];
    await rejects(battle({ fleet: f }), "equipment_unknown");
  });
  test("friend_ship: unknown, abyssal, or level outside 1..185", async () => {
    for (const patch of [{ masterId: 777 }, { masterId: 1501 }, { level: 186 }, { level: 0 }]) {
      const f = fleet();
      Object.assign(f.ships[0]!, patch);
      await rejects(battle({ fleet: f }), "friend_ship");
    }
  });
});

describe("quarantine (stored, not aggregated, not estimated)", () => {
  test("fleet_mismatch: the snapshot does not match the response's friend HP / size", async () => {
    const f = fleet();
    f.ships[1]!.observed.maxHp = 99;
    await quarantines(battle({ fleet: f }), "fleet_mismatch");
    await quarantines(battle({ fleet: fleet(2) }), "fleet_mismatch");
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM observation_ships").first()).toEqual({ n: 0 });
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM poi_comp_counts").first()).toEqual({ n: 0 });
  });
  test("hp_progression: HP above max, malformed damage, night start ≠ day end", async () => {
    await quarantines(battle({ raw: battleResponse([1501], 1, { api_e_nowhps: [25] }) }), "hp_progression");
    const dmg = battleResponse([1501], 1, { api_hougeki1: { api_at_eflag: [0], api_at_list: [0], api_at_type: [0], api_df_list: [[0]], api_cl_list: [[1]], api_damage: [[12.5]] } });
    await quarantines(battle({ raw: dmg }), "hp_progression");
    // day: friend 0 hits enemy 0 for 5 → the night continuation must start at 20 − 5 = 15
    const friend = FRIENDS.map((x) => ({ id: x.id, shipType: 2, level: 50, maxHp: x.hp, stats: { firepower: 0, torpedo: 0, antiAir: 0, armor: 0 }, slots: [] }));
    const enemy = [{ id: 1501, shipType: 2, level: 1, maxHp: 20, stats: { firepower: 5, torpedo: 15, antiAir: 6, armor: 5 }, slots: [{ id: 1505, types: [1, 1, 1, 1, 0] }] }];
    const day = battlePacket({ path: "api_req_sortie/battle", formation: [1, 1, 1], friend, enemy, startHp: [[30, 31, 32], [20]], events: [hit("friend", 0, 0, 5)] });
    const nightOk = battleResponse([1501], 1, { api_e_nowhps: [15] });
    const nightBad = battleResponse([1501], 1, { api_e_nowhps: [20] });
    const r = await upload(linked(battle({ raw: day, visitId: "visit-1" }), battle({ raw: nightOk, visitId: "visit-1", path: "api_req_battle_midnight/battle" })));
    expect(r).toMatchObject({ accepted: 3, quarantined: 0 });
    // the day battle is found among stored observations too
    await quarantines(battle({ raw: nightBad, visitId: "visit-1", path: "api_req_battle_midnight/battle" }), "hp_progression");
  });
});

describe("flag only (stored and used)", () => {
  test("enemy_stats on an event map", () =>
    flags(battle({ map: "60-1", difficulty: 4, layout: null, cell: 3, raw: battleResponse([1501], 1, { api_e_maxhps: [400] }) }), "enemy_stats"));
  test("map_graph_unknown: no stored edges or observed cells yet", () => flags(battle({ map: "60-1", difficulty: 4, layout: null, cell: 3 }), "map_graph_unknown"));
  test("edge_unknown: consecutive cells without a stored edge (maps change)", async () => {
    // F (6) → J (12): the stored edge into 12 leaves G
    const s = sortie({ sortie: { ...sortie().sortie, cells: [cellOf(1, null, 4, 1), cellOf(4, 1, 4, 2), cellOf(6, 4, 4, 2), cellOf(12, 6, 5, 0)] } });
    await flags(s, "edge_unknown");
  });
  test("sortie_no_raw (quarantined) and client_mismatch", async () => {
    await quarantines(sortie({ raw: null }), "sortie_no_raw");
    const s = sortie({ raw: { packets: [
      { path: "api_req_map/start", body: { api_maparea_id: 1, api_mapinfo_no: 5, api_no: 1, api_next: 1 } },
      { path: "api_req_map/next", body: { api_maparea_id: 1, api_mapinfo_no: 5, api_no: 2, api_from_no: 1, api_next: 0 } },
    ] } });
    await flags(s, "client_mismatch");
    // the stored sortie uses the cells of the packets, not the client's
    const stored = JSON.parse((await h.db.prepare("SELECT sortie FROM observations WHERE client_obs_id = ?1").bind(s.clientObsId).first<{ sortie: string }>())!.sortie);
    expect(stored.cells.map((c: { no: number }) => c.no)).toEqual([1, 2]);
    expect(stored.endKind).toBe("end_node");
  });
});

test("records keep the client id for the audit and admin listing", async () => {
  await upload([battle({ map: "9-9" })]);
  const list = await h.call<{ byRule: unknown[]; recent: { client_id: string }[] }>("GET", `/admin/rejections?clientId=${clientId}`);
  expect(list.json.byRule).toEqual([{ action: "reject", rule: "map_unknown", n: 1 }]);
  expect(list.json.recent[0]!.client_id).toBe(clientId);
});
