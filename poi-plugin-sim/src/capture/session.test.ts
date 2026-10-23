import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test } from "bun:test";
import { ObservationDb, STALE_SORTIE_MS } from "./db";
import {
  battle15, battleResult, dayBattle, mapinfoEvent, mapNext, mapNext15D, mapNext15F, mapNext15G, mapNext15I, mapNext15J, mapStart,
  mapStart15, mapinfoNormal, midnightBattle, resultNoDrop, resultWithDrop, resultWithEscape, resultWithEventItems,
} from "./fixtures";
import { extractGauge } from "@shared/capture/parser";
import { CaptureSession, isBattlePath, isResultPath } from "./session";
import type { CapturedFleet } from "@shared/capture/types";
import { fleetSnapshot, startCapture, stopCapture } from "./plugin";

const fleet: CapturedFleet = {
  deckId: 1,
  ships: [{ masterId: 131, level: 99, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [] }],
};

describe("path classification", () => {
  test("battle vs result vs other", () => {
    for (const p of [
      "api_req_sortie/battle", "api_req_sortie/airbattle", "api_req_sortie/ld_airbattle",
      "api_req_sortie/ld_shooting", "api_req_sortie/night_to_day", "api_req_battle_midnight/battle",
      "api_req_battle_midnight/sp_midnight", "api_req_combined_battle/battle",
      "api_req_combined_battle/midnight_battle", "api_req_combined_battle/ec_battle",
    ]) expect(isBattlePath(p)).toBe(true);
    for (const p of [
      "api_req_sortie/battleresult", "api_req_combined_battle/battleresult",
      "api_req_map/start", "api_req_practice/battle", "api_req_sortie/goback_port",
    ]) expect(isBattlePath(p)).toBe(false);
    expect(isResultPath("api_req_combined_battle/battleresult")).toBe(true);
    expect(isResultPath("api_req_sortie/battle")).toBe(false);
  });
});

describe("CaptureSession + ObservationDb", () => {
  let db: ObservationDb;
  let session: CaptureSession;
  const calls: [number, boolean][] = [];
  let t = 1000;

  beforeEach(() => {
    db = new ObservationDb(new IDBFactory());
    calls.length = 0;
    session = new CaptureSession({
      sink: db,
      getFleet: (d, c) => (calls.push([d, c]), fleet),
      now: () => ++t,
      onError: (e) => {
        throw e;
      },
    });
  });

  const run = async () => {
    await session.handle("/kcsapi/api_req_map/select_eventmap_rank", {}, { api_maparea_id: "1", api_map_no: "2", api_rank: "3" });
    await session.handle("/kcsapi/api_req_map/start", mapStart, { api_deck_id: "1" });
    await session.handle("/kcsapi/api_req_sortie/battle", dayBattle, {});
    await session.handle("/kcsapi/api_req_sortie/battleresult", battleResult);
    await session.handle("/kcsapi/api_req_map/next", mapNext, {});
    await session.handle("/kcsapi/api_req_sortie/battle", dayBattle, {});
    await session.handle("/kcsapi/api_req_battle_midnight/battle", midnightBattle, {});
    await session.handle("/kcsapi/api_port/port", { api_combined_flag: 0 }, {}); // ends the sortie
  };

  test("records map, fleet, enemy, raw, result", async () => {
    await run();
    const all = await db.listBattles();
    expect(all).toHaveLength(3);
    const first = all[0];
    expect(first.path).toBe("api_req_sortie/battle");
    expect(first.map).toMatchObject({ map: "1-2", cellId: 1, node: "1", difficulty: 3, step: 1, eventId: 4 });
    expect(first.fleet).toEqual(fleet);
    expect(first.enemy.ships).toHaveLength(3);
    expect(first.enemy.engagement).toBe(1);
    expect(first.enemyMasterIds).toEqual([1501, 1502, 1503]);
    expect(first.raw).toEqual(dayBattle);
    expect(first.result).toMatchObject({ rank: "S", mvp: 2, dropShipId: 77 });
    // no letters on the client: node is the raw cell id (the server resolves letters)
    expect(all[1].map).toMatchObject({ node: "5", step: 2, cellId: 5 });
    expect(all[1].result).toBeUndefined();
    // night battle shares the visit with the day battle of the same node
    expect(all[2].visitId).toBe(all[1].visitId);
    expect(all[2].visitId).not.toBe(first.visitId);
    expect(calls[0]).toEqual([1, false]);
  });

  test("queries and events", async () => {
    await run();
    expect(await db.listBattles({ map: "1-2", node: "5" })).toHaveLength(2);
    expect(await db.listBattles({ map: "1-2", node: "1" })).toHaveLength(1);
    expect(await db.listBattles({ map: "9-9" })).toHaveLength(0);
    expect(await db.listBattles({ limit: 1 })).toHaveLength(1);
    expect(await db.countObservations(1501)).toBe(3);
    expect(await db.countObservations(1503)).toBe(2);
    expect(await db.countObservations(9)).toBe(0);

    const [b0] = await db.listBattles();
    const events = await db.listEvents(b0.id);
    expect(events.length).toBeGreaterThan(10);
    expect(events[0]).toMatchObject({ map: "1-2", node: "1", seq: 0, phase: "air" });

    const exported = JSON.parse(await db.exportJSON());
    expect(exported.battles).toHaveLength(3);
    expect(exported.events.length).toBeGreaterThan(20);
  });

  test("combined battles request the escort fleet; the port's combined flag drives the sortie snapshot", async () => {
    await session.handle("api_port/port", { api_combined_flag: 1 });
    await session.handle("api_req_map/start", mapStart, { api_deck_id: "1" });
    await session.handle("api_req_combined_battle/battle", dayBattle, {});
    await session.handle("api_req_combined_battle/ec_battle", dayBattle, {});
    expect(calls).toEqual([[1, true], [1, true], [1, false]]);
    expect((await db.listSorties())[0].combined).toBe(1);
  });

  test("battle without a map start still records (map null)", async () => {
    await session.handle("api_req_sortie/battle", dayBattle, {});
    const [b] = await db.listBattles();
    expect(b.map).toBeNull();
    expect(await db.listBattles({ map: "1-2" })).toHaveLength(0);
  });

  test("uploadPending posts the v1 observation shape and marks them sent", async () => {
    await run();
    await session.handle("api_req_sortie/battle", dayBattle, {}); // map is still set; add one without a map below
    const noMap = new CaptureSession({ sink: db, getFleet: () => null, now: () => ++t });
    await noMap.handle("api_req_sortie/battle", dayBattle, {});
    const bodies: any[] = [];
    let ok = true;
    const fakeFetch = (async (url: string, init: any) => {
      bodies.push({ url, init, body: JSON.parse(init.body) });
      return { ok, status: ok ? 200 : 500, statusText: "x" };
    }) as unknown as typeof fetch;
    const opts = { fetch: fakeFetch, token: "tok-test" };

    ok = false;
    await expect(db.uploadPending("https://api.example/", opts)).rejects.toThrow("500");
    ok = true;
    bodies.length = 0;
    expect(await db.uploadPending("https://api.example/", opts)).toEqual({ sent: 5, remaining: 0 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toBe("https://api.example/api/v1/observations");
    expect(bodies[0].init.headers.Authorization).toBe("Bearer tok-test");
    expect(Object.keys(bodies[0].body)).toEqual(["observations"]);
    expect(bodies[0].body.observations).toHaveLength(5);
    const o = bodies[0].body.observations[0];
    expect(Object.keys(o).sort()).toEqual(
      ["cell", "clientObsId", "difficulty", "fleet", "kind", "map", "node", "observedAt", "raw"].sort()
    );
    expect(o).toMatchObject({ map: "1-2", node: "1", cell: 1, difficulty: 3, kind: "battle" });
    // battles first, then the finished sortie
    expect(bodies[0].body.observations.map((x: any) => x.kind)).toEqual(["battle", "battle", "battle", "battle", "sortie"]);
    const s = bodies[0].body.observations[4];
    expect(s).toMatchObject({ map: "1-2", difficulty: 3, kind: "sortie", sortie: { endKind: "retreat", deckId: 1, combined: null } });
    expect(s.sortie.cells.map((c: any) => [c.no, c.battles.length])).toEqual([[1, 1], [5, 2]]);
    expect(new Date(o.observedAt).toISOString()).toBe(o.observedAt);
    expect(o.raw.path).toBe("api_req_sortie/battle");
    expect(o.raw.raw).toEqual(dayBattle);
    expect(o.raw.result).toMatchObject({ rank: "S" });
    // the server re-derives the enemy and attack events from raw.raw, so neither is sent
    expect(o.raw.events).toBeUndefined();
    expect(o.enemy).toBeUndefined();
    // battles without a map are never sent but no longer pending
    expect(await db.countPending()).toBe(0);
    expect(await db.uploadPending("https://api.example", opts)).toEqual({ sent: 0, remaining: 0 });
  });

  test("errors in sink never reject when no handler throws", async () => {
    const errors: unknown[] = [];
    const s = new CaptureSession({
      sink: { saveBattle: async () => { throw new Error("boom"); }, saveResult: async () => {}, saveSortie: async () => {} },
      getFleet: () => null,
      onError: (e) => errors.push(e),
    });
    await s.handle("api_req_sortie/battle", dayBattle);
    await s.handle("api_req_sortie/battle", dayBattle);
    expect(errors).toHaveLength(2);
  });

  /** 1-5: Start → A(1) → D(4) → F(6) → G(7, 気のせい) → J(12, ボス)。戦闘は A, D, F, J。 */
  const sortie15 = async (s = session) => {
    await s.handle("/kcsapi/api_port/port", { api_combined_flag: 0 });
    await s.handle("/kcsapi/api_req_map/start", mapStart15, { api_deck_id: "1", api_maparea_id: "1", api_mapinfo_no: "5" });
    await s.handle("/kcsapi/api_req_sortie/battle", battle15([1501, 1502, 1503]), {});
    await s.handle("/kcsapi/api_req_sortie/battleresult", battleResult);
    for (const next of [mapNext15D, mapNext15F]) {
      await s.handle("/kcsapi/api_req_map/next", next, { api_recovery_type: "0" });
      await s.handle("/kcsapi/api_req_sortie/battle", battle15([1501, 1502]), {});
      await s.handle("/kcsapi/api_req_sortie/battleresult", battleResult);
    }
    await s.handle("/kcsapi/api_req_map/next", mapNext15G, {});
    await s.handle("/kcsapi/api_req_map/next", mapNext15J, {});
    await s.handle("/kcsapi/api_req_sortie/battle", battle15([1530, 1501, 1502], 4), {});
    await s.handle("/kcsapi/api_req_battle_midnight/battle", midnightBattle, {});
    await s.handle("/kcsapi/api_req_sortie/battleresult", battleResult);
  };

  test("records the sortie: cells, cell data, battle links, boss end", async () => {
    await sortie15();
    // still in progress until the fleet is back in port: not uploadable yet
    const [open] = await db.listSorties();
    expect(open.endKind).toBeNull();
    expect(await db.countPending(t)).toBe(5);
    await session.handle("/kcsapi/api_port/port", { api_combined_flag: 0 });
    const [s] = await db.listSorties("1-5");
    expect(s).toMatchObject({ map: "1-5", area: 1, mapNo: 5, difficulty: null, deckId: 1, combined: 0, endKind: "boss", pending: 1 });
    expect(s.cellData).toHaveLength(13);
    expect(s.cellData![6]).toEqual({ no: 6, colorNo: 4, passed: 0, distance: 3 });
    expect(s.cells.map((c) => [c.no, c.from, c.eventId, c.next])).toEqual([[1, null, 4, 1], [4, 1, 4, 2], [6, 4, 4, 2], [7, 6, 6, 1], [12, 7, 5, 0]]);
    expect(s.cells.map((c) => c.battles.length)).toEqual([1, 1, 1, 0, 2]);
    const battles = await db.listBattles({ map: "1-5" });
    expect(s.cells.flatMap((c) => c.battles)).toEqual(battles.map((b) => b.id));
    expect(battles[0].map).toMatchObject({ cellId: 1, node: "1", sortieId: s.id, layout: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    expect(s.fleet).toEqual(fleet);
    expect(await db.countPending(t)).toBe(6);
  });

  test("end kinds: terminal cell vs retreat; a new start closes a sortie that never reached port", async () => {
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "1" });
    await session.handle("api_req_map/next", mapNext15D, {});
    await session.handle("api_req_map/next", mapNext15F, {});
    await session.handle("api_req_map/next", mapNext15I, {});
    await session.handle("api_port/port", {});
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "2" });
    await session.handle("api_req_map/next", mapNext15D, {});
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "1" });
    const [terminal, retreat, open] = await db.listSorties();
    expect(terminal.endKind).toBe("end_node");
    expect(retreat).toMatchObject({ endKind: "retreat", deckId: 2 });
    expect(retreat.cells.map((c) => c.no)).toEqual([1, 4]);
    expect(open.endKind).toBeNull();
  });

  test("uploadPending sends sortie observations; stale open sorties go up as unknown", async () => {
    await sortie15();
    await session.handle("api_port/port", {});
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "1" }); // left open
    const bodies: any[] = [];
    const fakeFetch = (async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, statusText: "OK" };
    }) as unknown as typeof fetch;
    expect(await db.uploadPending("http://x", { fetch: fakeFetch, token: "c", now: () => t })).toEqual({ sent: 6, remaining: 0 });
    const obs = bodies.flatMap((b) => b.observations);
    const battle = obs.find((o: any) => o.kind === "battle");
    expect(battle).toMatchObject({ map: "1-5", cell: 1, difficulty: 0, layout: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    expect(battle.raw.sortieId).toMatch(/^s-/);
    const sortie = obs.find((o: any) => o.kind === "sortie");
    expect(Object.keys(sortie).sort()).toEqual(["clientObsId", "difficulty", "fleet", "kind", "layout", "map", "observedAt", "raw", "sortie"]);
    // raw map packets in visit order (the server re-derives cells / cellData from them)
    expect(sortie.raw.packets.map((p: any) => p.path)).toEqual(["api_req_map/start", "api_req_map/next", "api_req_map/next", "api_req_map/next", "api_req_map/next"]);
    expect(sortie.raw.packets[0].body).toEqual(mapStart15);
    expect(sortie.sortie.endKind).toBe("boss");
    expect(sortie.sortie.cells[4]).toEqual({
      no: 12, from: 7, colorNo: 5, eventId: 5, eventKind: 1, bossCellNo: 12, next: 0, selectCells: null,
      battles: [obs[3].clientObsId, obs[4].clientObsId],
      result: { rank: "S", drop: { shipId: 77, name: "x" }, escapeFlag: 0 },
    });
    expect(await db.countPending(t)).toBe(0);
    expect(await db.countPending(t + STALE_SORTIE_MS)).toBe(1);
    bodies.length = 0;
    expect(await db.uploadPending("http://x", { fetch: fakeFetch, token: "c", now: () => t + STALE_SORTIE_MS })).toEqual({ sent: 1, remaining: 0 });
    expect(bodies[0].observations[0].sortie).toMatchObject({ endKind: "unknown", endedAt: null });
  });
});

describe("sortie gauge, drops, FCF retreats, striking force", () => {
  const ship = (masterId: number) => ({ masterId, level: 99, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [] });
  const fleet7 = (deckId: number, n: number): CapturedFleet => ({ deckId, ships: Array.from({ length: n }, (_, i) => ship(100 + i)) });
  let t = 5000;
  const setup = (f: CapturedFleet, getGauge?: (a: number, m: number) => any) => {
    const db = new ObservationDb(new IDBFactory());
    const session = new CaptureSession({
      sink: db,
      getFleet: (deckId, combined) => ({ ...f, deckId, ...(combined ? { escort: [ship(200), ship(201)] } : {}) }),
      getGauge,
      now: () => ++t,
      onError: (e) => { throw e; },
    });
    return { db, session };
  };
  const eventStart = { ...mapStart15, api_maparea_id: 62, api_mapinfo_no: 1 };
  const eventNext = { ...mapNext15D, api_maparea_id: 62, api_mapinfo_no: 1 };

  test("gauge state of the sortied map and the fleet size are recorded at the start", async () => {
    const asked: [number, number][] = [];
    const { db, session } = setup(fleet7(1, 6), (a, m) => (asked.push([a, m]), extractGauge(mapinfoEvent)));
    await session.handle("api_req_map/start", eventStart, { api_deck_id: "1" });
    await session.handle("api_req_map/next", eventNext, {});
    const [s] = await db.listSorties();
    expect(asked).toEqual([[62, 1]]);
    expect(s.gauge).toEqual({ gaugeNum: 2, gaugeType: 2, nowHp: 1200, maxHp: 1800, state: 2, rank: 3, cleared: 0, defeatCount: 0 });
    expect([s.deckId, s.fleetSize, s.escortSize]).toEqual([1, 6, 0]);
  });

  test("no gauge source: gauge null", async () => {
    const { db, session } = setup(fleet7(1, 6));
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "1" });
    expect((await db.listSorties())[0].gauge).toBeNull();
  });

  test("striking force: 7 ships in fleet 3", async () => {
    const { db, session } = setup(fleet7(3, 7));
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "3" });
    await session.handle("api_req_map/next", mapNext15D, {});
    const [s] = await db.listSorties();
    expect([s.deckId, s.fleetSize, s.escortSize, s.fleet?.ships.length]).toEqual([3, 7, 0, 7]);
  });

  test("battle results land on the cell: rank, drop, no drop, event items", async () => {
    const { db, session } = setup(fleet7(1, 6));
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "1" });
    await session.handle("api_req_sortie/battle", battle15([1501]), {});
    await session.handle("api_req_sortie/battleresult", resultWithDrop);
    await session.handle("api_req_map/next", mapNext15D, {});
    await session.handle("api_req_sortie/battle", battle15([1501]), {});
    await session.handle("api_req_sortie/battleresult", resultNoDrop);
    await session.handle("api_req_map/next", mapNext15F, {});
    await session.handle("api_req_sortie/battle", battle15([1501]), {});
    await session.handle("api_req_sortie/battleresult", resultWithEventItems);
    const [s] = await db.listSorties();
    expect(s.cells.map((c) => c.result)).toEqual([
      { rank: "A", drop: { shipId: 230, name: "朝潮" }, escapeFlag: 0 },
      { rank: "B", drop: null, escapeFlag: 0 },
      { rank: "S", drop: { shipId: 401, name: "大和改二" }, escapeFlag: 0, useItem: { id: 44, name: "勲章" }, eventItems: [{ type: 1, id: 123, value: 1 }] },
    ]);
  });

  test("FCF escape: ships resolved from the sortie fleet (main 1-6, escort 7-12); goback_port confirms the retreat", async () => {
    const { db, session } = setup(fleet7(1, 6));
    await session.handle("api_port/port", { api_combined_flag: 2 });
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "1" });
    await session.handle("api_req_combined_battle/battle", dayBattle, {});
    await session.handle("api_req_combined_battle/battleresult", resultWithEscape);
    let [s] = await db.listSorties();
    expect(s.cells[0]!.result!.escape).toEqual({ idx: [7], towIdx: [4], shipIds: [200], towShipIds: [103], type: null, retreated: false });
    await session.handle("api_req_combined_battle/goback_port", {});
    await session.handle("api_req_map/next", mapNext15D, {});
    await session.handle("api_req_combined_battle/battle", dayBattle, {});
    await session.handle("api_req_combined_battle/battleresult", { ...resultNoDrop, api_escape_flag: 1, api_escape: { api_escape_idx: [2], api_tow_idx: [] } });
    [s] = await db.listSorties();
    expect(s.cells[0]!.result!.escape!.retreated).toBe(true);
    // offered at the second cell but never confirmed
    expect(s.cells[1]!.result!.escape).toEqual({ idx: [2], towIdx: [], shipIds: [101], towShipIds: [], type: null, retreated: false });
    expect(s.cells[1]!.battles).toHaveLength(1);
  });

  test("goback_port without an offered escape changes nothing", async () => {
    const { db, session } = setup(fleet7(1, 6));
    await session.handle("api_req_map/start", mapStart15, { api_deck_id: "1" });
    await session.handle("api_req_sortie/battle", battle15([1501]), {});
    await session.handle("api_req_sortie/battleresult", resultNoDrop);
    await session.handle("api_req_sortie/goback_port", {});
    expect((await db.listSorties())[0].cells[0]!.result).toEqual({ rank: "B", drop: null, escapeFlag: 0 });
  });

  test("the upload carries gauge, fleet sizes and cell results; old sorties without them still upload", async () => {
    const { db, session } = setup(fleet7(3, 7), () => extractGauge(mapinfoEvent));
    await session.handle("api_req_map/start", eventStart, { api_deck_id: "3" });
    await session.handle("api_req_sortie/battle", battle15([1501]), {});
    await session.handle("api_req_sortie/battleresult", resultWithDrop);
    await session.handle("api_port/port", {});
    const old = { ...(await db.listSorties())[0]!, id: "s-old" } as any;
    delete old.gauge; delete old.fleetSize; delete old.escortSize;
    old.cells = old.cells.map(({ result, ...c }: any) => c);
    await db.saveSortie(old);
    const bodies: any[] = [];
    const fakeFetch = (async (_u: string, init: any) => (bodies.push(JSON.parse(init.body)), { ok: true, status: 200, statusText: "OK" })) as unknown as typeof fetch;
    await db.uploadPending("http://x", { fetch: fakeFetch, token: "c", now: () => t });
    const sorties = bodies.flatMap((b) => b.observations).filter((o: any) => o.kind === "sortie");
    const fresh = sorties.find((o: any) => o.clientObsId !== "s-old");
    expect(fresh.sortie).toMatchObject({ deckId: 3, fleetSize: 7, escortSize: 0, gauge: { gaugeNum: 2, gaugeType: 2, nowHp: 1200, maxHp: 1800 } });
    expect(fresh.sortie.cells[0].result).toEqual({ rank: "A", drop: { shipId: 230, name: "朝潮" }, escapeFlag: 0 });
    const legacy = sorties.find((o: any) => o.clientObsId === "s-old");
    expect(legacy.sortie).toMatchObject({ fleetSize: 7, escortSize: 0, gauge: null });
    expect(legacy.sortie.cells[0].result).toBeUndefined();
  });
});

describe("startCapture", () => {
  test("listens to game.response, is idempotent, stops cleanly", async () => {
    const listeners = new Map<string, (e: Event) => void>();
    const target = {
      addEventListener: (n: string, f: any) => listeners.set(n, f),
      removeEventListener: (n: string) => listeners.delete(n),
    };
    const db = new ObservationDb(new IDBFactory());
    const state = {
      info: {
        fleets: [{ api_ship: [11] }],
        ships: { 11: { api_ship_id: 131, api_lv: 99, api_slot: [], api_slotnum: 0 } },
      },
    };
    const got = startCapture({ db, getState: () => state, target });
    expect(got).toBe(db);
    expect(startCapture({ db: new ObservationDb(new IDBFactory()), target })).toBe(db);
    const fire = (path: string, body: any, postBody?: any) =>
      listeners.get("game.response")!({ detail: { path, body, postBody } } as any);
    fire("/kcsapi/api_req_map/start", mapStart, { api_deck_id: "1" });
    fire("/kcsapi/api_req_sortie/battle", dayBattle, {});
    await new Promise((r) => setTimeout(r, 50));
    const [b] = await db.listBattles();
    expect(b.fleet?.ships[0].masterId).toBe(131);
    // the gauge comes from poi's info.maps entry of the sortied map (mapStart is 1-2: no entry there)
    expect((await db.listSorties())[0].gauge).toBeNull();
    stopCapture();
    expect(listeners.size).toBe(0);
  });

  test("the sortie gauge is read from poi's info.maps (api_eventmap) of the sortied map", async () => {
    const listeners = new Map<string, (e: Event) => void>();
    const target = { addEventListener: (n: string, f: any) => listeners.set(n, f), removeEventListener: (n: string) => listeners.delete(n) };
    const db = new ObservationDb(new IDBFactory());
    const state = { info: { maps: { 621: mapinfoEvent, 15: mapinfoNormal } } };
    startCapture({ db, getState: () => state, target });
    const fire = (path: string, body: any, postBody?: any) => listeners.get("game.response")!({ detail: { path, body, postBody } } as any);
    fire("/kcsapi/api_req_map/start", { ...mapStart15, api_maparea_id: 62, api_mapinfo_no: 1 }, { api_deck_id: "1" });
    fire("/kcsapi/api_port/port", {});
    fire("/kcsapi/api_req_map/start", mapStart15, { api_deck_id: "1" });
    await new Promise((r) => setTimeout(r, 50));
    const sorties = await db.listSorties();
    expect(sorties.map((s) => s.gauge)).toEqual([
      { gaugeNum: 2, gaugeType: 2, nowHp: 1200, maxHp: 1800, state: 2, rank: 3, cleared: 0, defeatCount: 0 },
      { gaugeNum: null, gaugeType: null, nowHp: null, maxHp: null, state: null, rank: null, cleared: 1, defeatCount: 1 },
    ]);
    stopCapture();
  });

  test("fleetSnapshot guards missing state", () => {
    expect(fleetSnapshot(undefined, 1, false)).toBeNull();
    expect(fleetSnapshot({}, 2, true)).toBeNull();
  });

  test("fleetSnapshot records fuel / ammo in ship order", () => {
    const state = {
      info: {
        fleets: [{ api_ship: [10, -1, 11] }],
        ships: { 10: { api_ship_id: 1, api_fuel: 12, api_bull: 20 }, 11: { api_ship_id: 2, api_fuel: 30 } },
        equips: {},
      },
      const: { $ships: { 1: { api_id: 1, api_fuel_max: 15, api_bull_max: 20 }, 2: { api_id: 2, api_fuel_max: 40 } }, $equips: {} },
    };
    const snap = fleetSnapshot(state, 1, false);
    expect(snap?.ships.map((s) => s.masterId)).toEqual([1, 2]);
    expect(snap?.supply).toEqual([{ fuel: 12, fuelMax: 15, ammo: 20, ammoMax: 20 }, null]);
  });
});
