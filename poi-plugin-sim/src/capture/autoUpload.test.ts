import { describe, expect, test } from "bun:test";
import { BANNED_MESSAGE, backoffDelay, startAutoUpload } from "./autoUpload";
import type { AutoUploadOptions } from "./autoUpload";
import type { SendOutcome } from "./uploadClient";

const MIN = 60_000;

/** 手動で進める時計 + タイマー。 */
const makeClock = () => {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: t + ms, fn });
      return seq;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    count: () => timers.size,
    /** ms 進めて、期限が来たタイマーを順に実行し、非同期の後続処理も流す。 */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      t = end;
    },
  };
};

type Settings = { autoUpload: boolean; apiBase: string };

const setup = (over: Partial<AutoUploadOptions> & { pending?: number; settings?: Partial<Settings> } = {}) => {
  const clock = makeClock();
  const settings: Settings = { autoUpload: true, apiBase: "http://api.test", ...over.settings };
  const listeners = new Set<() => void>();
  const calls: { base: string }[] = [];
  const times: number[] = [];
  const state = {
    pending: over.pending ?? 1,
    fail: false,
    banned: false,
    gate: null as null | Promise<void>,
    /** 次の送信の結果。未指定なら全件送れた */
    outcome: null as null | (() => SendOutcome),
  };
  // uploadClient の代役。送るものが無ければ idle、あれば outcome を返す。
  const client: NonNullable<AutoUploadOptions["client"]> = {
    state: () => (state.banned ? { kind: "banned", clientId: "c" } : { kind: "registered", clientId: "c" }),
    send: async (_db, base) => {
      if (state.pending === 0) return { status: "idle" };
      times.push(clock.now());
      calls.push({ base });
      if (state.gate) await state.gate;
      if (state.fail) throw new Error("offline");
      if (state.outcome) return state.outcome();
      const n = state.pending;
      state.pending = 0;
      return { status: "sent", sent: n, remaining: 0, nextAt: clock.now() + MIN };
    },
  };
  const up = startAutoUpload({
    db: {} as AutoUploadOptions["db"],
    client,
    getSettings: () => settings,
    subscribeSettings: (l) => (listeners.add(l), () => void listeners.delete(l)),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    saveStatus: () => {},
    ...over,
  });
  return { clock, settings, listeners, calls, times, state, up };
};

describe("backoffDelay", () => {
  test("doubles from the base and is capped at 30 min", () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n));
    expect(seq).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
  });
});

describe("debounce", () => {
  test("coalesces a burst of triggers into one upload after the quiet period", async () => {
    const { clock, calls, up } = setup();
    await clock.advance(1); // 起動時の予約を消化しないよう、起動直後の予約を一旦リセット
    calls.length = 0;
    up.trigger();
    await clock.advance(3_000);
    up.onResponse("/kcsapi/api_req_sortie/battleresult");
    await clock.advance(3_000);
    up.onResponse("/kcsapi/api_port/port");
    await clock.advance(4_999);
    expect(calls).toHaveLength(0);
    await clock.advance(1);
    expect(calls).toHaveLength(1);
    up.stop();
  });

  test("only battleresult and port trigger", async () => {
    const { clock, calls, up } = setup({ pending: 0 });
    await clock.advance(10_000);
    up.onResponse("/kcsapi/api_req_sortie/battle");
    up.onResponse("api_req_map/next");
    up.onResponse(undefined);
    expect(clock.count()).toBe(1); // 定期タイマーのみ
    up.onResponse("/kcsapi/api_req_combined_battle/battleresult");
    expect(clock.count()).toBe(2);
    expect(calls).toHaveLength(0);
    up.stop();
  });
});

describe("periodic retry", () => {
  test("re-runs every 5 min while pending, and uploads nothing when empty", async () => {
    const { clock, calls, state, up } = setup();
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);
    state.pending = 2; // 新しい観測が溜まった (イベント無し)
    await clock.advance(5 * MIN);
    expect(calls).toHaveLength(2);
    await clock.advance(5 * MIN);
    expect(calls).toHaveLength(2); // pending 0 なら送らない
    up.stop();
  });
});

describe("backoff on failure", () => {
  test("retries after 30s, 60s, 120s ... and resets on success", async () => {
    const { clock, calls, state, up } = setup();
    state.fail = true;
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);
    expect(up.status().lastError).toBe("offline");
    await clock.advance(29_999);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    expect(calls).toHaveLength(2);
    await clock.advance(59_999);
    expect(calls).toHaveLength(2);
    await clock.advance(1);
    expect(calls).toHaveLength(3);
    state.fail = false;
    await clock.advance(120_000);
    expect(calls).toHaveLength(4);
    expect(up.status().lastError).toBeNull();
    expect(up.status().lastSuccessAt).not.toBeNull();
    up.stop();
  });

  test("delay is capped at 30 min", async () => {
    const { clock, times, state, up } = setup();
    state.fail = true;
    await clock.advance(12 * 60 * MIN);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps.slice(0, 7)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000]);
    expect(gaps.slice(6).every((g) => g === 30 * MIN)).toBe(true);
    up.stop();
  });

  test("a trigger or periodic tick during backoff does not upload early", async () => {
    const { clock, calls, state, up } = setup();
    state.fail = true;
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);
    up.trigger(); // バックオフ (30s) の残りより短いデバウンスでは送らない
    await clock.advance(10_000);
    expect(calls).toHaveLength(1);
    await clock.advance(20_000);
    expect(calls).toHaveLength(2);
    up.stop();
  });

  test("never throws into the caller", async () => {
    const { clock, state, up } = setup();
    state.fail = true;
    await clock.advance(5_000);
    await expect(up.flush()).resolves.toBeUndefined();
    up.stop();
  });
});

describe("single-flight", () => {
  test("overlapping triggers and flushes share one upload, then re-run once", async () => {
    const { clock, calls, state, up } = setup();
    let release!: () => void;
    state.gate = new Promise<void>((r) => (release = r));
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);
    const a = up.flush();
    const b = up.flush();
    await clock.advance(5 * MIN); // 定期 tick も重ならない
    expect(calls).toHaveLength(1);
    state.gate = null;
    release();
    await Promise.all([a, b]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    state.pending = 3; // 実行中に溜まった分
    expect(calls).toHaveLength(1);
    await clock.advance(5_000); // 実行中に来た要求は、送信間隔 (60 秒) が空くまで待つ
    expect(calls).toHaveLength(1);
    await clock.advance(MIN); // その後 1 回だけ走る
    expect(calls).toHaveLength(2);
    up.stop();
  });
});

describe("autoUpload setting", () => {
  test("disabled: nothing is scheduled or uploaded", async () => {
    const { clock, calls, up } = setup({ settings: { autoUpload: false } });
    up.onResponse("/kcsapi/api_port/port");
    up.trigger();
    await up.flush();
    await clock.advance(30 * MIN);
    expect(calls).toHaveLength(0);
    up.stop();
  });

  test("turning it on schedules an upload; turning it off cancels a pending one", async () => {
    const { clock, calls, settings, listeners, up } = setup({ settings: { autoUpload: false } });
    settings.autoUpload = true;
    listeners.forEach((l) => l());
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);

    up.trigger();
    settings.autoUpload = false;
    listeners.forEach((l) => l());
    await clock.advance(30 * MIN);
    expect(calls).toHaveLength(1);
    up.stop();
  });

  test("uses the current apiBase", async () => {
    const { clock, calls, settings, up } = setup();
    settings.apiBase = "http://other.test";
    await clock.advance(5_000);
    expect(calls).toEqual([{ base: "http://other.test" }]);
    up.stop();
  });

  test("changing the apiBase clears the backoff so the new server is tried at once", async () => {
    const { clock, calls, settings, listeners, state, up } = setup();
    state.fail = true;
    await clock.advance(5_000);
    expect(calls).toHaveLength(1); // 次は 30 秒後
    state.fail = false;
    settings.apiBase = "http://other.test";
    listeners.forEach((l) => l());
    await clock.advance(5_000);
    expect(calls.map((c) => c.base)).toEqual(["http://api.test", "http://other.test"]);
    up.stop();
  });
});

describe("rate limit (429)", () => {
  test("is retried exactly at Retry-After and does not count as a failure", async () => {
    const { clock, calls, state, up } = setup();
    state.outcome = () => ({ status: "deferred", until: clock.now() + 47_000, reason: "server" });
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);
    expect(up.status().lastError).toBeNull();
    await clock.advance(46_999);
    expect(calls).toHaveLength(1);
    state.outcome = null;
    await clock.advance(1);
    expect(calls).toHaveLength(2);
    expect(up.status().lastSuccessAt).not.toBeNull();
    up.stop();
  });

  test("a later failure still backs off from the base, not from earlier 429s", async () => {
    const { clock, times, state, up } = setup();
    state.outcome = () => ({ status: "deferred", until: clock.now() + 60_000, reason: "server" });
    await clock.advance(5_000 + 3 * 60_000);
    expect(times).toEqual([5_000, 65_000, 125_000, 185_000]);
    state.outcome = null;
    state.fail = true;
    await clock.advance(60_000);
    expect(times.at(-1)).toBe(245_000);
    await clock.advance(30_000);
    expect(times.at(-1)).toBe(275_000); // 失敗 1 回目のバックオフ 30 秒
    up.stop();
  });

  test("a trigger before the deferred time is pushed out to it", async () => {
    const { clock, calls, state, up } = setup();
    state.outcome = () => ({ status: "deferred", until: clock.now() + 50_000, reason: "limiter" });
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);
    state.outcome = null;
    up.onResponse("/kcsapi/api_req_sortie/battleresult");
    await clock.advance(49_999);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    expect(calls).toHaveLength(2);
    up.stop();
  });
});

describe("200-observation cap", () => {
  test("continues with the remainder as soon as the interval allows", async () => {
    const { clock, times, state, up } = setup();
    let left = 3;
    state.outcome = () => {
      left -= 1;
      if (left === 0) state.pending = 0;
      return { status: "sent", sent: 200, remaining: left > 0 ? 200 * left : 0, nextAt: clock.now() + MIN };
    };
    await clock.advance(5_000 + 2 * MIN);
    expect(times).toEqual([5_000, 65_000, 125_000]);
    await clock.advance(10 * MIN);
    expect(times).toHaveLength(3); // 残りが無ければ定期 tick は送らない (client は idle を返す)
    up.stop();
  });
});

describe("403 (banned)", () => {
  test("stops sending and reports why", async () => {
    const { clock, calls, state, up } = setup();
    state.outcome = () => {
      state.banned = true;
      return { status: "banned" };
    };
    await clock.advance(5_000);
    expect(calls).toHaveLength(1);
    expect(up.status().lastError).toBe(BANNED_MESSAGE);
    up.trigger();
    up.onResponse("/kcsapi/api_port/port");
    await clock.advance(30 * MIN);
    expect(calls).toHaveLength(1);
    up.stop();
  });

  test("a banned client is not started at all", async () => {
    const { clock, calls, up } = setup({ settings: {} , client: { state: () => ({ kind: "banned", clientId: "c" }), send: async () => ({ status: "idle" }) } });
    await clock.advance(30 * MIN);
    expect(calls).toHaveLength(0);
    up.stop();
  });
});

describe("stop", () => {
  test("clears every timer and the settings subscription", async () => {
    const { clock, calls, listeners, up } = setup();
    up.trigger();
    expect(clock.count()).toBe(2);
    up.stop();
    expect(clock.count()).toBe(0);
    expect(listeners.size).toBe(0);
    up.trigger();
    up.onResponse("/kcsapi/api_port/port");
    expect(clock.count()).toBe(0);
    await clock.advance(60 * MIN);
    expect(calls).toHaveLength(0);
  });

  test("stopping during backoff leaves no retry timer", async () => {
    const { clock, state, up } = setup();
    state.fail = true;
    await clock.advance(5_000);
    expect(clock.count()).toBe(2);
    up.stop();
    expect(clock.count()).toBe(0);
  });
});
