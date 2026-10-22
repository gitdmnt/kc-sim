import { describe, expect, test } from "bun:test";
import { backoffDelay, startAutoUpload } from "./autoUpload";
import type { AutoUploadOptions } from "./autoUpload";

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

type Settings = { autoUpload: boolean; apiBase: string; clientId: string };

const setup = (over: Partial<AutoUploadOptions> & { pending?: number; settings?: Partial<Settings> } = {}) => {
  const clock = makeClock();
  const settings: Settings = { autoUpload: true, apiBase: "http://api.test", clientId: "poi-x", ...over.settings };
  const listeners = new Set<() => void>();
  const calls: { base: string; clientId: string }[] = [];
  const times: number[] = [];
  const state = { pending: over.pending ?? 1, fail: false, gate: null as null | Promise<void> };
  const db = {
    countPending: async () => state.pending,
    uploadPending: async (base: string, o: { clientId: string }) => {
      times.push(clock.now());
      calls.push({ base, clientId: o.clientId });
      if (state.gate) await state.gate;
      if (state.fail) throw new Error("offline");
      const n = state.pending;
      state.pending = 0;
      return n;
    },
  };
  const up = startAutoUpload({
    db: db as AutoUploadOptions["db"],
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
    await clock.advance(5_000); // 実行中に来た要求の分が 1 回だけ走る
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

  test("uses the current apiBase and clientId", async () => {
    const { clock, calls, settings, up } = setup();
    settings.apiBase = "http://other.test";
    await clock.advance(5_000);
    expect(calls).toEqual([{ base: "http://other.test", clientId: "poi-x" }]);
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
