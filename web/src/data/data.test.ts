import { describe, expect, test } from "bun:test";
import { DataApi, DataApiError } from "./api";
import { MemoryStorage } from "../fleet/storage";
import { describePredicate, describeRule, countUncertain } from "./routing";

describe("describePredicate", () => {
  test("count / speed / los / equipShips", () => {
    expect(describePredicate({ m: "count", types: ["BB_CLASS"], gte: 2 })).toBe("戦艦級 ≥ 2");
    expect(describePredicate({ m: "count", types: ["BATTLESHIP"], maxSpeed: "slow", gte: 1 })).toBe("低速以下の戦艦(航戦除く) ≥ 1");
    expect(describePredicate({ m: "speed", gte: "fastPlus" })).toBe("速力 ≥ 高速+");
    expect(describePredicate({ m: "los", cn: 4, gte: 66 })).toBe("索敵(Cn4) ≥ 66");
    expect(describePredicate({ m: "equipShips", equip: { group: "DRUM" }, gte: 4 })).toBe("ドラム缶装備艦 ≥ 4");
    expect(describePredicate({ m: "ships", gte: 2, lt: 5 })).toBe("艦数 ≥ 2 < 5");
    expect(describePredicate({ m: "onlyTypes", types: ["DE"] })).toBe("海防艦のみ");
    expect(describePredicate({ m: "visited", node: "N" })).toBe("N 通過済み");
    expect(describePredicate({ m: "difficulty", in: [3, 4] })).toBe("難易度 ∈ {乙, 甲}");
  });
  test("all / any / not nesting", () => {
    expect(
      describePredicate({
        any: [
          { m: "count", types: ["SS_CLASS"], gte: 1 },
          { all: [{ m: "count", types: ["CL"], gte: 1 }, { m: "count", types: ["DD"], gte: 2 }] },
        ],
      })
    ).toBe("潜水系 ≥ 1 または (軽巡 ≥ 1 かつ 駆逐艦 ≥ 2)");
    expect(describePredicate({ not: { m: "ships", eq: 1 } })).toBe("(艦数 = 1) ではない");
  });
});

describe("describeRule", () => {
  test("fixed / random / los / select", () => {
    expect(describeRule({ to: "C" })).toMatchObject({ condition: null, action: "→ C", targets: ["C"] });
    const r = describeRule({
      when: { m: "ships", eq: 1 },
      uncertain: true,
      random: [{ to: "E", p: 0.35 }, { to: "J", p: 0.65 }],
    });
    expect(r.action).toBe("ランダム: E 35% / J 65%");
    expect(r.uncertain).toBe(true);
    const l = describeRule({
      los: { cn: 4, thresholds: [{ min: 66, to: "C2" }, { min: 60, to: "D" }], below: "D", interpolate: true },
    });
    expect(l.action).toBe("索敵(Cn4) ≥ 66 → C2 / ≥ 60 → D / 未満 → D (線形補間)");
    expect(l.targets).toEqual(["C2", "D"]);
    expect(describeRule({ select: ["D", "J"] }).action).toBe("プレイヤー選択: D / J");
  });
  test("nested rules collect targets and uncertainty", () => {
    const v = describeRule({
      when: { m: "ships", gte: 5 },
      rules: [
        { when: { m: "count", types: ["SS_CLASS"], gte: 1 }, to: "F" },
        { uncertain: true, random: [{ to: "E", p: 0.5 }, { to: "F", p: 0.5 }] },
      ],
    });
    expect(v.children).toHaveLength(2);
    expect(v.targets).toEqual(["F", "E"]);
    expect(countUncertain([v])).toBe(1);
  });
});

describe("DataApi cache", () => {
  const mk = (responses: (() => Response | Promise<Response>)[]) => {
    let t = 0;
    const calls: string[] = [];
    const storage = new MemoryStorage();
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return (responses.shift() ?? (() => new Response("{}")))();
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const api = new DataApi({
      baseUrl: () => "http://x/", fetch: fetchFn, storage, ttlMs: 1000, now: () => t,
      sleep: async (ms) => void waits.push(ms),
    });
    return { api, calls, storage, waits, advance: (ms: number) => (t += ms) };
  };
  const json = (o: unknown) => () => new Response(JSON.stringify(o));

  test("caches within ttl, refetches after, persists to storage", async () => {
    const { api, calls, advance, storage } = mk([json({ maps: [1] }), json({ maps: [2] })]);
    expect((await api.boot()).data).toEqual({ maps: [1] } as never);
    await api.boot();
    expect(calls).toEqual(["http://x/api/v1/views/boot"]);
    expect(storage.getItem("kcsim:cache:http://x/api/v1/views/boot")).not.toBeNull();
    advance(2000);
    expect((await api.boot()).data).toEqual({ maps: [2] } as never);
    expect(calls).toHaveLength(2);
  });

  test("quests are cached for a day regardless of the default ttl", async () => {
    const { api, calls, advance } = mk([json({ sources: [], quests: [] }), json({ sources: [], quests: [] })]);
    await api.quests();
    advance(23 * 60 * 60 * 1000);
    await api.quests();
    expect(calls).toEqual(["http://x/api/v1/quests"]);
    advance(2 * 60 * 60 * 1000);
    await api.quests();
    expect(calls).toHaveLength(2);
  });

  test("dedupes in-flight requests", async () => {
    const { api, calls } = mk([json({ maps: [] })]);
    await Promise.all([api.boot(), api.boot()]);
    expect(calls).toHaveLength(1);
  });

  test("offline: stale cache is returned flagged, otherwise a typed error", async () => {
    const { api, advance } = mk([
      json({ maps: [1] }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await api.boot();
    advance(5000);
    const r = await api.boot();
    expect(r).toMatchObject({ stale: true, data: { maps: [1] } });
    const fresh = mk([() => { throw new TypeError("fetch failed"); }]);
    await expect(fresh.api.boot()).rejects.toMatchObject({ kind: "offline" });
  });

  test("404 is not masked by stale cache; http error kind", async () => {
    const { api, advance } = mk([json({ detail: 1 }), () => new Response("{}", { status: 404 })]);
    await api.mapView("1-5");
    advance(5000);
    await expect(api.mapView("1-5")).rejects.toMatchObject({ kind: "http", status: 404 });
    const bad = mk([() => new Response("not json")]);
    await expect(bad.api.boot()).rejects.toBeInstanceOf(DataApiError);
  });

  test("view URLs: map view with minObserved, enemy ship by id", async () => {
    const { api, calls } = mk([]);
    await api.mapView("7-5", 30);
    await api.mapView("7-5");
    await api.enemyShip(1502);
    expect(calls).toEqual(["http://x/api/v1/views/map/7-5?minObserved=30", "http://x/api/v1/views/map/7-5", "http://x/api/v1/views/enemy/1502"]);
  });

  test("enemy view: the first ship's detail comes from the list response, not another request", async () => {
    const first = { detail: { ship: { id: 1501 }, estimates: [], best: {} }, estimates: { source: "estimator:server", updatedAt: null, estimates: [] } };
    const { api, calls, advance } = mk([json({ ships: [{ id: 1501 }], estimates: first.estimates, firstShip: first }), json({ second: true })]);
    await api.enemyView();
    expect((await api.enemyShip(1501)).data).toEqual(first as never);
    expect(calls).toEqual(["http://x/api/v1/views/enemy"]);
    // the primed entry expires like any other
    advance(2000);
    expect((await api.enemyShip(1501)).data).toEqual({ second: true } as never);
  });

  test("clearCache empties memory and storage", async () => {
    const { api, calls, storage } = mk([json({ maps: [1] }), json({ maps: [1] })]);
    await api.boot();
    api.clearCache();
    expect(storage.length).toBe(0);
    await api.boot();
    expect(calls).toHaveLength(2);
  });

  const limited = (retryAfter?: string) => () =>
    new Response("error code: 1015", { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });

  test("429: waits Retry-After (capped at 10 s, default 2 s) and retries", async () => {
    const { api, calls, waits } = mk([limited("4"), limited("60"), limited(), json({ maps: [1] })]);
    expect((await api.boot()).data).toEqual({ maps: [1] } as never);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([4000, 10_000, 2000]);
  });

  test("429 after 3 retries: an http error, or the stale cache when there is one", async () => {
    const { api, advance } = mk([json({ maps: [1] }), limited("1"), limited("1"), limited("1"), limited("1"), limited("1"), limited("1"), limited("1"), limited("1")]);
    await api.boot();
    advance(5000);
    expect(await api.boot()).toMatchObject({ stale: true, data: { maps: [1] } });
    const fresh = mk([limited("1"), limited("1"), limited("1"), limited("1")]);
    await expect(fresh.api.boot()).rejects.toMatchObject({ kind: "http", status: 429 });
  });
});
