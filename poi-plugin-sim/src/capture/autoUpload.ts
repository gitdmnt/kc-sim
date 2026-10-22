/**
 * 観測の自動送信。poi のメインウィンドウ (キャプチャと同じコンテキスト) で動く。
 * game.response の購読は capture/plugin.ts の既存リスナーが行い、path を `onResponse` に渡す。
 *
 * - battleresult と帰投 (api_port/port) のあとに、デバウンスして送信する (uploadClient: トークン登録・60 秒に 1 回・1 回 100 件・256 KiB まで)。
 *   間隔の間に溜まった分は次の送信でまとめて送る。保留が残っていれば間隔が空き次第続きを送る。
 * - 保留が残っている限り、一定間隔で再試行する。
 * - 429 は Retry-After の時刻に再試行する (失敗として数えない)。403 (拒否) は送信を止める。
 * - 失敗 (オフライン / 5xx) は指数バックオフ (上限あり)。poi には例外を投げず、キャプチャも止めない。
 * - 送信は常に 1 本だけ (single-flight)。
 *
 * 状態表示 (最終成功時刻・直近のエラー) はプラグインウィンドウから読むため localStorage に書く。
 * 保留数は IndexedDB が両ウィンドウで共有なので UI 側で直接数える。
 */
import { STORAGE_PREFIX, getUploadSettings, subscribePluginSettings } from "../settings";
import type { ObservationDb } from "./db";
import { isResultPath } from "./session";
import { getUploadClient } from "./uploadClient";
import type { UploadClient } from "./uploadClient";

export const DEBOUNCE_MS = 5_000;
export const PERIODIC_MS = 5 * 60_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
export const BANNED_MESSAGE = "サーバに拒否されました (403)。送信を停止しました";

/** `failures` 回連続で失敗したあとの待ち時間。 */
export const backoffDelay = (
  failures: number,
  base = BACKOFF_BASE_MS,
  max = BACKOFF_MAX_MS
): number => Math.min(max, base * 2 ** Math.max(0, failures - 1));

export interface AutoUploadStatus {
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

const STATUS_KEY = `${STORAGE_PREFIX}autoUploadStatus`;
const EMPTY_STATUS: AutoUploadStatus = { lastSuccessAt: null, lastError: null, lastErrorAt: null };

export const AUTO_UPLOAD_STATUS_KEY = STATUS_KEY;

export const readAutoUploadStatus = (): AutoUploadStatus => {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STATUS_KEY) : null;
    return { ...EMPTY_STATUS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...EMPTY_STATUS };
  }
};

const writeAutoUploadStatus = (s: AutoUploadStatus) => {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても送信は続ける
  }
};

export interface AutoUploadOptions {
  db: Pick<ObservationDb, "uploadPending" | "countPending">;
  /** 既定は localStorage を共有する uploadClient (手動送信と同じ間隔・トークン) */
  client?: Pick<UploadClient, "send" | "state">;
  getSettings?: () => { autoUpload: boolean; apiBase: string };
  subscribeSettings?: (listener: () => void) => () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  saveStatus?: (s: AutoUploadStatus) => void;
  debounceMs?: number;
  periodicMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface AutoUploader {
  /** デバウンス付きで送信を予約する。無効設定なら何もしない。 */
  trigger(): void;
  /** デバウンスを待たずに今送る。実行中ならそれに合流する。例外は投げない。 */
  flush(): Promise<void>;
  /** game.response の path を渡す。battleresult と帰投のときだけ送信を予約する。例外は投げない。 */
  onResponse(path: unknown): void;
  /** タイマーと設定の購読を全て解除する。 */
  stop(): void;
  status(): AutoUploadStatus;
}

const isUploadTrigger = (rawPath: string): boolean => {
  const path = rawPath.replace(/^\/?kcsapi\//, "");
  return isResultPath(path) || path === "api_port/port";
};

export const startAutoUpload = (opts: AutoUploadOptions): AutoUploader => {
  const readSettings = opts.getSettings ?? getUploadSettings;
  const subscribe = opts.subscribeSettings ?? subscribePluginSettings;
  const client = opts.client ?? getUploadClient();
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]));
  const saveStatus = opts.saveStatus ?? writeAutoUploadStatus;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const periodicMs = opts.periodicMs ?? PERIODIC_MS;

  let stopped = false;
  let debounceTimer: unknown = null;
  let periodicTimer: unknown = null;
  let inflight: Promise<void> | null = null;
  let rerun = false;
  let failures = 0;
  let blockedUntil = 0;
  let status: AutoUploadStatus = opts.saveStatus ? { ...EMPTY_STATUS } : readAutoUploadStatus();
  let lastApiBase = readSettings().apiBase;

  const enabled = () => {
    const s = readSettings();
    return s.autoUpload && s.apiBase !== "" && client.state(s.apiBase).kind !== "banned";
  };

  const setStatus = (patch: Partial<AutoUploadStatus>) => {
    status = { ...status, ...patch };
    try {
      saveStatus(status);
    } catch {
      // ignore
    }
  };

  const clearDebounce = () => {
    if (debounceTimer !== null) clearTimer(debounceTimer);
    debounceTimer = null;
  };

  const schedule = (delay: number) => {
    clearDebounce();
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      void run();
    }, delay);
  };

  const trigger = () => {
    if (stopped || !enabled()) return;
    schedule(Math.max(debounceMs, blockedUntil - now()));
  };

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inflight) {
      rerun = true;
      return inflight;
    }
    if (!enabled()) return Promise.resolve();
    const { apiBase } = readSettings();
    inflight = (async () => {
      try {
        const out = await client.send(opts.db, apiBase);
        if (out.status === "sent") {
          failures = 0;
          blockedUntil = out.nextAt;
          setStatus({ lastSuccessAt: now(), lastError: null, lastErrorAt: null });
          // 1 回に入りきらなかった分は次に送れるようになった時点で続ける
          if (out.remaining > 0 && !stopped) schedule(Math.max(0, out.nextAt - now()));
        } else if (out.status === "deferred") {
          // 429 や自分の送信間隔。失敗ではないのでバックオフしない。
          blockedUntil = out.until;
          if (!stopped) schedule(Math.max(0, out.until - now()));
        } else if (out.status === "banned") {
          clearDebounce();
          setStatus({ lastError: BANNED_MESSAGE, lastErrorAt: now() });
        }
      } catch (e) {
        failures += 1;
        const wait = backoffDelay(failures, opts.backoffBaseMs, opts.backoffMaxMs);
        blockedUntil = now() + wait;
        setStatus({ lastError: e instanceof Error ? e.message : String(e), lastErrorAt: now() });
        rerun = false;
        if (!stopped) schedule(wait);
      }
    })()
      .catch((e) => console.error("[kcsim] auto upload failed", e))
      .finally(() => {
        inflight = null;
        if (rerun) {
          rerun = false;
          trigger();
        }
      });
    return inflight;
  };

  const tickPeriodic = () => {
    periodicTimer = setTimer(tickPeriodic, periodicMs);
    if (enabled() && now() >= blockedUntil) void run();
  };
  periodicTimer = setTimer(tickPeriodic, periodicMs);

  const onResponse = (path: unknown) => {
    try {
      if (typeof path === "string" && isUploadTrigger(path)) trigger();
    } catch (err) {
      console.error("[kcsim] auto upload trigger failed", err);
    }
  };

  const unsubscribe = subscribe(() => {
    if (stopped) return;
    const s = readSettings();
    if (!enabled()) {
      clearDebounce();
      return;
    }
    if (s.apiBase !== lastApiBase) {
      lastApiBase = s.apiBase;
      failures = 0;
      blockedUntil = 0;
    }
    trigger();
  });

  // 前回までの未送信分
  trigger();

  return {
    trigger,
    onResponse,
    flush: () => run(),
    stop: () => {
      stopped = true;
      clearDebounce();
      if (periodicTimer !== null) clearTimer(periodicTimer);
      periodicTimer = null;
      unsubscribe();
    },
    status: () => status,
  };
};
