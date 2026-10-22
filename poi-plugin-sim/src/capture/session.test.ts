import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, test } from "bun:test";
import { ObservationDb } from "./db";
import { battleResult, dayBattle, mapNext, mapStart, midnightBattle } from "./fixtures";
import { CaptureSession, isBattlePath, isResultPath } from "./session";
import type { CapturedFleet } from "./types";
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
      resolveNode: (_a, _m, cell) => (cell === 5 ? "B" : undefined),
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
    await session.handle("/kcsapi/api_port/port", {}, {}); // ignored
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
    expect(all[1].map).toMatchObject({ node: "B", step: 2, cellId: 5 });
    expect(all[1].result).toBeUndefined();
    // night battle shares the visit with the day battle of the same node
    expect(all[2].visitId).toBe(all[1].visitId);
    expect(all[2].visitId).not.toBe(first.visitId);
    expect(calls[0]).toEqual([1, false]);
  });

  test("queries and events", async () => {
    await run();
    expect(await db.listBattles({ map: "1-2", node: "B" })).toHaveLength(2);
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

  test("combined battles request the escort fleet", async () => {
    await session.handle("api_req_map/start", mapStart, { api_deck_id: "1" });
    await session.handle("api_req_combined_battle/battle", dayBattle, {});
    await session.handle("api_req_combined_battle/ec_battle", dayBattle, {});
    expect(calls).toEqual([[1, true], [1, false]]);
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
      bodies.push({ url, body: JSON.parse(init.body) });
      return { ok, status: ok ? 200 : 500, statusText: "x" };
    }) as unknown as typeof fetch;
    const opts = { fetch: fakeFetch, clientId: "poi-test" };

    ok = false;
    await expect(db.uploadPending("https://api.example/", opts)).rejects.toThrow("500");
    ok = true;
    bodies.length = 0;
    expect(await db.uploadPending("https://api.example/", { ...opts, batchSize: 3 })).toBe(4);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].url).toBe("https://api.example/api/v1/observations");
    expect(bodies[0].body.clientId).toBe("poi-test");
    expect(bodies[0].body.observations).toHaveLength(3);
    const o = bodies[0].body.observations[0];
    expect(Object.keys(o).sort()).toEqual(
      ["clientObsId", "difficulty", "enemy", "fleet", "kind", "map", "node", "observedAt", "raw"].sort()
    );
    expect(o).toMatchObject({ map: "1-2", node: "1", difficulty: 3, kind: "battle" });
    expect(new Date(o.observedAt).toISOString()).toBe(o.observedAt);
    expect(o.raw.path).toBe("api_req_sortie/battle");
    expect(o.raw.raw).toEqual(dayBattle);
    expect(o.raw.result).toMatchObject({ rank: "S" });
    expect(o.raw.events.length).toBeGreaterThan(10);
    // battles without a map are never sent but no longer pending
    expect(await db.countPending()).toBe(0);
    expect(await db.uploadPending("https://api.example", opts)).toBe(0);
  });

  test("errors in sink never reject when no handler throws", async () => {
    const errors: unknown[] = [];
    const s = new CaptureSession({
      sink: { saveBattle: async () => { throw new Error("boom"); }, saveResult: async () => {} },
      getFleet: () => null,
      onError: (e) => errors.push(e),
    });
    await s.handle("api_req_sortie/battle", dayBattle);
    await s.handle("api_req_sortie/battle", dayBattle);
    expect(errors).toHaveLength(2);
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
    stopCapture();
    expect(listeners.size).toBe(0);
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
