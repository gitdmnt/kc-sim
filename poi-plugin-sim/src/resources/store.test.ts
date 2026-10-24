import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "bun:test";
import { startCapture, stopCapture } from "../capture/plugin";
import { ObservationDb } from "../capture/db";
import { ResourceDb } from "./store";
import { onResourceRecorded } from ".";

const V = (fuel: number) => [fuel, 2000, 3000, 4000, 100, 200, 300, 40];

describe("ResourceDb", () => {
  test("add / last / list per admiral, survives reopening (poi restart)", async () => {
    const factory = new IDBFactory();
    const db = new ResourceDb(factory);
    const a = await db.add({ admiral: "1", t: 100, v: V(1), event: "api_port/port" });
    await db.add({ admiral: "1", t: 300, v: V(3), event: "api_req_hokyu/charge", via: ["api_req_mission/result"] });
    await db.add({ admiral: "1", t: 200, v: V(2), event: "api_port/port" });
    await db.add({ admiral: "2", t: 500, v: V(9), event: "api_port/port" });
    expect(a.id).toBeNumber();
    await db.close();

    const reopened = new ResourceDb(factory);
    expect((await reopened.last("1"))?.v[0]).toBe(3);
    expect((await reopened.last("3"))).toBeUndefined();
    expect((await reopened.list("1")).map((s) => s.t)).toEqual([100, 200, 300]);
    expect((await reopened.list("1", 150)).map((s) => s.t)).toEqual([200, 300]);
    expect((await reopened.list("1"))[2].via).toEqual(["api_req_mission/result"]);
    expect(await reopened.admirals()).toEqual([
      { admiral: "2", lastAt: 500 },
      { admiral: "1", lastAt: 300 },
    ]);
  });

  test("apply removes and updates in one transaction", async () => {
    const db = new ResourceDb(new IDBFactory());
    const rows = [];
    for (const t of [1, 2, 3]) rows.push(await db.add({ admiral: "1", t, v: V(t), event: "api_port/port" }));
    await db.apply([rows[0].id!, rows[1].id!], [{ ...rows[2], merged: 2 }]);
    expect(await db.list("1")).toEqual([{ ...rows[2], merged: 2 }]);
  });
});

describe("startCapture records resources from game.response", () => {
  test("reads poi's state after each response, dedupes, attributes and notifies", async () => {
    const resources = new ResourceDb(new IDBFactory());
    const target = new EventTarget();
    const state = { info: { basic: { api_member_id: 12345 }, resources: [] as number[] } };
    const seen: string[] = [];
    const third = Promise.withResolvers<void>();
    const off = onResourceRecorded((s) => {
      seen.push(s.event);
      if (seen.length === 3) third.resolve();
    });
    startCapture({ db: new ObservationDb(new IDBFactory()), getState: () => state, target, autoUpload: false, resources });
    const fire = (path: string, values?: number[], body: unknown = {}) => {
      // poi は redux を更新してから game.response を発火する
      if (values) state.info.resources = values;
      target.dispatchEvent(new CustomEvent("game.response", { detail: { path, body, postBody: {}, time: Date.now() } }));
    };
    try {
      fire("/kcsapi/api_start2/getData");
      fire("/kcsapi/api_port/port", V(1000));
      fire("/kcsapi/api_get_member/deck");
      fire("/kcsapi/api_req_mission/result", undefined, { api_get_material: [100, 0, 0, 0] });
      fire("/kcsapi/api_port/port", V(1100));
      fire("/kcsapi/api_req_hokyu/charge", V(1080));
      // 記録は非同期に順番に処理されるので、3 件目の通知を待つ
      await third.promise;
      const rows = await resources.list("12345");
      expect(rows.map((r) => [r.event, r.v[0], r.via])).toEqual([
        ["api_port/port", 1000, undefined],
        ["api_port/port", 1100, ["api_req_mission/result"]],
        ["api_req_hokyu/charge", 1080, undefined],
      ]);
      expect(seen).toEqual(["api_port/port", "api_port/port", "api_req_hokyu/charge"]);
    } finally {
      off();
      stopCapture();
    }
  });
});
