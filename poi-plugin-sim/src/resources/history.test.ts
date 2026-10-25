import { describe, expect, test } from "bun:test";
import { DAY, HOUR, ResourceRecorder, affectsLater, normalizeValues, thinSnapshots } from "./history";
import type { ResourceSnapshot, ResourceStore, ThinTier } from "./history";
import { bucketEnd, bucketStart, dayDeltas, deltaBucket, eventDeltas, periodDeltas, snapshotLabel, stepSeries } from "./view";

/** 保存先のメモリ実装 (IndexedDB と同じく id を振り、時刻順に返す) */
class MemoryStore implements ResourceStore {
  rows: ResourceSnapshot[] = [];
  async last(admiral: string) {
    return (await this.list(admiral)).at(-1);
  }
  async add(s: ResourceSnapshot) {
    const row = { ...s, id: Math.max(0, ...this.rows.map((r) => r.id!)) + 1 };
    this.rows.push(row);
    return row;
  }
  async list(admiral: string, from = -Infinity) {
    return this.rows.filter((r) => r.admiral === admiral && r.t >= from).sort((a, b) => a.t - b.t);
  }
  async apply(remove: number[], update: ResourceSnapshot[]) {
    this.rows = this.rows.filter((r) => !remove.includes(r.id!)).map((r) => update.find((u) => u.id === r.id) ?? r);
  }
}

const V = (fuel: number, ammo = 1000, steel = 1000, baux = 1000, items: number[] = [10, 20, 30, 40]) => [fuel, ammo, steel, baux, ...items];

const setup = () => {
  const store = new MemoryStore();
  let t = 1_000_000;
  const recorded: ResourceSnapshot[] = [];
  const recorder = new ResourceRecorder({ store, now: () => t, onRecord: (s) => recorded.push(s) });
  const feed = (path: string, values: number[] | null, body?: unknown, admiral: string | null = "42") => {
    t += 60_000;
    return recorder.observe({ admiral, values: values && normalizeValues(values), path, body, time: t });
  };
  return { store, recorder, recorded, feed, now: () => t };
};

describe("normalizeValues", () => {
  test("8 resources in poi order; missing ones null; needs the 4 main resources", () => {
    expect(normalizeValues([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(normalizeValues([1, 2, 3, 4])).toEqual([1, 2, 3, 4, null, null, null, null]);
    expect(normalizeValues([])).toBeNull();
    expect(normalizeValues([1, 2, null, 4])).toBeNull();
    expect(normalizeValues(undefined)).toBeNull();
    expect(normalizeValues([1, 2, 3, 4, NaN, 6, "7", 8])).toEqual([1, 2, 3, 4, null, 6, null, 8]);
  });
});

describe("ResourceRecorder: dedupe", () => {
  test("records only when the values change", async () => {
    const { store, feed } = setup();
    expect(await feed("/kcsapi/api_port/port", V(100))).not.toBeNull();
    expect(await feed("/kcsapi/api_get_member/deck", V(100))).toBeNull();
    expect(await feed("/kcsapi/api_port/port", V(100))).toBeNull();
    expect(await feed("/kcsapi/api_req_hokyu/charge", V(90))).not.toBeNull();
    // 主要 4 資源以外 (高速修復材) の変化も記録する
    expect(await feed("/kcsapi/api_req_nyukyo/speedchange", V(90, 1000, 1000, 1000, [10, 19, 30, 40]))).not.toBeNull();
    expect(store.rows.map((r) => [r.event, r.v[0], r.v[5]])).toEqual([
      ["api_port/port", 100, 20],
      ["api_req_hokyu/charge", 90, 20],
      ["api_req_nyukyo/speedchange", 90, 19],
    ]);
  });

  test("nothing without an admiral id or before poi has resources", async () => {
    const { store, feed } = setup();
    expect(await feed("api_start2/getData", null)).toBeNull();
    expect(await feed("api_port/port", V(100), undefined, null)).toBeNull();
    expect(store.rows).toHaveLength(0);
  });

  test("dedupes against the stored history after a restart (new recorder, same store)", async () => {
    const { store, feed } = setup();
    await feed("api_port/port", V(100));
    const restarted = new ResourceRecorder({ store });
    expect(await restarted.observe({ admiral: "42", values: normalizeValues(V(100)), path: "api_port/port" })).toBeNull();
    expect(await restarted.observe({ admiral: "42", values: normalizeValues(V(101)), path: "api_port/port" })).not.toBeNull();
    expect(store.rows).toHaveLength(2);
  });

  test("keeps each admiral's history separate", async () => {
    const { store, feed } = setup();
    await feed("api_port/port", V(100), undefined, "1");
    await feed("api_port/port", V(100), undefined, "2");
    await feed("api_port/port", V(100), undefined, "1");
    expect(store.rows.map((r) => r.admiral)).toEqual(["1", "2"]);
  });

  test("processes responses in order even when fired without awaiting", async () => {
    const { store, feed } = setup();
    await Promise.all([feed("api_port/port", V(100)), feed("api_port/port", V(100)), feed("api_req_hokyu/charge", V(80))]);
    expect(store.rows.map((r) => r.v[0])).toEqual([100, 80]);
  });
});

describe("ResourceRecorder: event attribution", () => {
  test("the response that changed the values is the event; earlier deferred APIs are listed in via", async () => {
    const { store, feed } = setup();
    await feed("api_port/port", V(100));
    // 遠征帰投・任務達成は poi の資源を変えず、次の母港でまとめて反映される
    await feed("api_req_mission/result", V(100), { api_get_material: [300, 300, 0, 0] });
    await feed("api_req_quest/clearitemget", V(100), { api_material: [50, 50, 50, 50] });
    await feed("api_port/port", V(450));
    await feed("api_req_kousyou/createitem", V(440));
    expect(store.rows.slice(1).map((r) => [r.event, r.via])).toEqual([
      ["api_port/port", ["api_req_mission/result", "api_req_quest/clearitemget"]],
      ["api_req_kousyou/createitem", undefined],
    ]);
    expect(snapshotLabel(store.rows[1])).toBe("母港 (遠征・任務)");
  });

  test("a full sync without change drops pending via (they moved nothing)", async () => {
    const { store, feed } = setup();
    await feed("api_port/port", V(100));
    await feed("api_req_quest/clearitemget", V(100), {});
    await feed("api_port/port", V(100));
    await feed("api_req_hokyu/charge", V(90));
    expect(store.rows[1].via).toBeUndefined();
  });

  test("map cells count only when they give items", async () => {
    expect(affectsLater("api_req_map/next", { api_itemget: [{ api_id: 1, api_getcount: 50 }] })).toBe(true);
    expect(affectsLater("api_req_map/next", { api_no: 3 })).toBe(false);
    expect(affectsLater("api_req_map/start", { api_itemget_eo_comment: {} })).toBe(true);
    expect(affectsLater("api_get_member/deck", {})).toBe(false);
    const { store, feed } = setup();
    await feed("api_port/port", V(100));
    await feed("api_req_map/next", V(100), { api_no: 2 });
    await feed("api_req_map/next", V(100), { api_itemget: [{}] });
    await feed("api_port/port", V(150));
    expect(store.rows[1].via).toEqual(["api_req_map/next"]);
  });

  test("uses the response time when given", async () => {
    const store = new MemoryStore();
    const recorder = new ResourceRecorder({ store, now: () => 5 });
    await recorder.observe({ admiral: "1", values: normalizeValues(V(1)), path: "api_port/port", time: 1234 });
    await recorder.observe({ admiral: "1", values: normalizeValues(V(2)), path: "api_port/port" });
    expect(store.rows.map((r) => r.t)).toEqual([1234, 5]);
  });
});

const snap = (t: number, fuel: number, extra: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  id: t,
  admiral: "1",
  t,
  v: V(fuel),
  event: "api_port/port",
  ...extra,
});
/** テスト用の日の境目 (UTC)。ローカル時刻に依存しない */
const utcDay = (t: number) => Math.floor(t / DAY) * DAY;

describe("thinSnapshots", () => {
  const NOW = 1000 * DAY;

  test("recent records stay; older ones keep the last per hour, then the last per day", () => {
    const rows = [
      // 100 日前の同じ日に 3 件 → 1 件
      snap(NOW - 100 * DAY, 1),
      snap(NOW - 100 * DAY + 2 * HOUR, 2),
      snap(NOW - 100 * DAY + 5 * HOUR, 3),
      // 30 日前の同じ時に 2 件、次の時に 1 件 → 2 件
      snap(NOW - 30 * DAY, 4),
      snap(NOW - 30 * DAY + 10 * 60_000, 5),
      snap(NOW - 30 * DAY + HOUR, 6),
      // 直近は全件
      snap(NOW - HOUR, 7),
      snap(NOW - HOUR + 1, 8),
      snap(NOW - 1, 9),
    ];
    const { keep, drop, update } = thinSnapshots(rows, NOW, undefined, utcDay);
    expect(keep.map((s) => s.v[0])).toEqual([3, 5, 6, 7, 8, 9]);
    expect(drop.map((s) => s.v[0]).sort()).toEqual([1, 2, 4]);
    expect(keep.map((s) => s.merged ?? 0)).toEqual([2, 1, 0, 0, 0, 0]);
    expect(update.map((s) => s.v[0])).toEqual([3, 5]);
    // 入力は変えない
    expect(rows[2].merged).toBeUndefined();
  });

  test("collapses records left equal to the previous one", () => {
    const rows = [snap(NOW - 50 * DAY, 1), snap(NOW - 49 * DAY, 2), snap(NOW - 49 * DAY + 60_000, 1), snap(NOW - 10, 1, { merged: 3 })];
    const tiers: ThinTier[] = [{ maxAge: DAY, bucket: "all" }, { maxAge: Infinity, bucket: "day" }];
    const { keep, drop } = thinSnapshots(rows, NOW, tiers, utcDay);
    // 49 日前の日は最後の 1 (= 50 日前と同じ値) に畳まれ、それも 50 日前の記録に畳まれる。直近の記録も同じ値なので
    // 前に畳まれ、1 件だけになる (記録は前と違う値しか保存しないので、実際には最新の記録は畳まれない)
    expect(keep.map((s) => [s.t, s.v[0], s.merged])).toEqual([[NOW - 50 * DAY, 1, 2 + 4]]);
    expect(drop).toHaveLength(3);
  });

  test("nothing to do on already thin data", () => {
    const rows = [snap(NOW - 200 * DAY, 1), snap(NOW - 199 * DAY, 2), snap(NOW - 1, 3)];
    const { keep, drop, update } = thinSnapshots(rows, NOW, undefined, utcDay);
    expect(keep).toHaveLength(3);
    expect(drop).toHaveLength(0);
    expect(update).toHaveLength(0);
  });

  test("the recorder thins after its first record and then once per interval", async () => {
    const store = new MemoryStore();
    let t = NOW;
    // 1 時間より古いものは日ごと
    const tiers: ThinTier[] = [{ maxAge: HOUR, bucket: "all" }, { maxAge: Infinity, bucket: "day" }];
    for (const [i, row] of [snap(NOW - 10 * DAY, 1), snap(NOW - 10 * DAY + 1, 2), snap(NOW - 10 * DAY + 2, 3)].entries()) {
      store.rows.push({ ...row, id: i + 1 });
    }
    const recorder = new ResourceRecorder({ store, now: () => t, tiers, thinEvery: DAY });
    await recorder.observe({ admiral: "1", values: normalizeValues(V(10)), path: "api_port/port" });
    expect(store.rows.map((r) => [r.v[0], r.merged])).toEqual([
      [3, 2],
      [10, undefined],
    ]);
    // 間隔内は間引かない
    t += HOUR;
    await recorder.observe({ admiral: "1", values: normalizeValues(V(11)), path: "api_port/port" });
    t += 2 * HOUR;
    await recorder.observe({ admiral: "1", values: normalizeValues(V(12)), path: "api_port/port" });
    expect(store.rows).toHaveLength(4);
    t += DAY;
    await recorder.observe({ admiral: "1", values: normalizeValues(V(13)), path: "api_port/port" });
    // 10/11/12 は同じ日 (NOW の日) で 1 時間より古い → 12 に畳まれる
    expect(store.rows.map((r) => r.v[0])).toEqual([3, 12, 13]);
  });
});

describe("view: deltas and series", () => {
  const rows = [
    snap(10 * DAY + HOUR, 100),
    snap(10 * DAY + 2 * HOUR, 90, { event: "api_req_hokyu/charge" }),
    snap(11 * DAY + HOUR, 400, { via: ["api_req_mission/result"] }),
    snap(11 * DAY + 3 * HOUR, 380, { event: "api_req_kousyou/createitem", merged: 2 }),
    snap(13 * DAY, 500),
  ];

  test("eventDeltas: change from the previous record, newest first, within the range", () => {
    const got = eventDeltas(rows, 10 * DAY + 2 * HOUR, 12 * DAY);
    expect(got.map((r) => [r.label, r.d[0]])).toEqual([
      ["開発 ほか 2 件", -20],
      ["母港 (遠征)", 310],
      ["補給", -10],
    ]);
  });

  test("dayDeltas: last value of the day minus the previous day's last; days without records skipped", () => {
    const got = dayDeltas(rows, 0, 20 * DAY, utcDay);
    expect(got.map((r) => [r.t / DAY, r.d[0], r.v[0]])).toEqual([
      [13, 120, 500],
      [11, 290, 380],
      // 最初の日はその日の最初の記録から
      [10, -10, 90],
    ]);
    expect(dayDeltas(rows, 11 * DAY, 12 * DAY - 1, utcDay).map((r) => r.t / DAY)).toEqual([11]);
  });

  test("periodDeltas: per-bucket change with the records' changes summed by cause", () => {
    const utcHour = (t: number) => t - (t % HOUR);
    const got = periodDeltas(rows, 0, 20 * DAY, utcHour);
    expect(got.map((r) => [(r.t - 10 * DAY) / HOUR, r.d[0], r.by.map((b) => [b.label, b.d[0]])])).toEqual([
      [72, 120, [["母港", 120]]],
      [27, -20, [["開発", -20]]],
      [25, 310, [["母港 (遠征)", 310]]],
      [2, -10, [["補給", -10]]],
      // 最初の記録は前が無いので内訳に出ない
      [1, 0, []],
    ]);
    // 同じ原因は足す
    const day = dayDeltas([snap(0, 10), snap(HOUR, 30), snap(2 * HOUR, 25, { event: "api_req_hokyu/charge" }), snap(3 * HOUR, 45)], 0, DAY, utcDay);
    expect(day[0].by.map((b) => [b.label, b.d[0]])).toEqual([
      ["母港", 40],
      ["補給", -5],
    ]);
    expect(day[0].d[0]).toBe(35);
  });

  test("buckets: hours for the per-event chart up to a week, days otherwise", () => {
    expect([deltaBucket(true, "day"), deltaBucket(true, "week"), deltaBucket(true, "month"), deltaBucket(false, "day")]).toEqual([
      "hour",
      "hour",
      "day",
      "day",
    ]);
    const t = new Date(2026, 9, 24, 15, 42).getTime();
    expect(bucketStart("hour", t)).toBe(new Date(2026, 9, 24, 15).getTime());
    expect(bucketEnd("hour", bucketStart("hour", t))).toBe(new Date(2026, 9, 24, 16).getTime());
    expect(bucketEnd("day", t)).toBe(new Date(2026, 9, 25).getTime());
  });

  test("stepSeries: holds each value until the next record, from the value before the range to the end", () => {
    expect(stepSeries(rows, 0, 11 * DAY, 12 * DAY)).toEqual([
      [
        [11 * DAY, 90],
        [11 * DAY + HOUR, 90],
        [11 * DAY + HOUR, 400],
        [11 * DAY + 3 * HOUR, 400],
        [11 * DAY + 3 * HOUR, 380],
        [12 * DAY, 380],
      ],
    ]);
    const gap = [snap(1, 5), { ...snap(2, 0), v: [1, 1, 1, 1, null, 1, 1, 1] }, snap(3, 6)];
    expect(stepSeries(gap, 4, 0, 4)).toEqual([
      [
        [1, 10],
        [2, 10],
      ],
      [
        [3, 10],
        [4, 10],
      ],
    ]);
  });
});
