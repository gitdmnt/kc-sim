/**
 * データ API への観測送信の認証と送信間隔 (docs/API.md §3)。
 *
 * - トークンは `POST /api/v1/clients` で発行され、サーバごとに別。必要になったとき (未送信があるとき) に
 *   登録して localStorage に保存する。API の URL が変わったら捨てて登録し直す。
 * - 送信は 60 秒に 1 回、1 リクエスト 200 件まで。送信しようとした時刻から 60 秒は次を送らない。
 *   429 は Retry-After の時刻まで待つ (失敗ではない)。401 は 1 度だけ再登録して送り直す。403 は停止する。
 * - 状態 (トークン・次に送れる時刻) は localStorage にあるので、メインウィンドウの自動送信と
 *   プラグインウィンドウの手動送信が同じ間隔を共有する。
 */
import { STORAGE_PREFIX } from "../fleet";
import { UploadHttpError, parseRetryAfter } from "./db";
import type { FetchFn, ObservationDb } from "./db";

export const UPLOAD_INTERVAL_MS = 60_000;

export interface Credentials {
  /** 末尾の `/` を除いた登録先 */
  apiBase: string;
  clientId: string;
  token: string;
  /** 403 を受けた。このトークンでは送らない。 */
  banned: boolean;
}

export interface UploadStore {
  credentials(): Credentials | null;
  setCredentials(c: Credentials | null): void;
  /** 次に POST してよい時刻 (epoch ms)。0 = いつでも */
  nextAt(): number;
  setNextAt(t: number): void;
}

const CREDENTIALS_KEY = `${STORAGE_PREFIX}auth`;
const NEXT_AT_KEY = `${STORAGE_PREFIX}uploadNextAt`;
/** もう一方のウィンドウの変更を拾うための storage イベントのキー */
export const UPLOAD_STATE_KEYS: readonly string[] = [CREDENTIALS_KEY, NEXT_AT_KEY];

const isCredentials = (v: unknown): v is Credentials => {
  const c = v as Partial<Credentials> | null;
  return !!c && typeof c.apiBase === "string" && typeof c.clientId === "string" && typeof c.token === "string" && typeof c.banned === "boolean";
};

export const localStorageStore = (): UploadStore => ({
  credentials: () => {
    try {
      const raw = localStorage.getItem(CREDENTIALS_KEY);
      const v: unknown = raw ? JSON.parse(raw) : null;
      return isCredentials(v) ? v : null;
    } catch {
      return null;
    }
  },
  setCredentials: (c) => {
    try {
      if (c) localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(c));
      else localStorage.removeItem(CREDENTIALS_KEY);
    } catch {
      // 保存できなくても今回の送信は続ける
    }
  },
  nextAt: () => {
    try {
      const n = Number(localStorage.getItem(NEXT_AT_KEY));
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  },
  setNextAt: (t) => {
    try {
      localStorage.setItem(NEXT_AT_KEY, String(t));
    } catch {
      // ignore
    }
  },
});

/** テスト用 */
export const memoryStore = (): UploadStore => {
  let creds: Credentials | null = null;
  let nextAt = 0;
  return {
    credentials: () => creds,
    setCredentials: (c) => void (creds = c),
    nextAt: () => nextAt,
    setNextAt: (t) => void (nextAt = t),
  };
};

export type SendOutcome =
  /** 未送信なし (登録も送信もしていない) */
  | { status: "idle" }
  | { status: "sent"; sent: number; remaining: number; nextAt: number }
  /** 送らなかった。`until` (epoch ms) まで待つ。limiter = 自分の 60 秒間隔、server = 429 の Retry-After。 */
  | { status: "deferred"; until: number; reason: "limiter" | "server" }
  /** 403: このクライアントは拒否された。送信を止める。 */
  | { status: "banned" };

export type RegisterOutcome = { status: "registered"; clientId: string } | { status: "deferred"; until: number };

export type RegistrationState = { kind: "none" } | { kind: "registered"; clientId: string } | { kind: "banned"; clientId: string };

export interface UploadClientOptions {
  store?: UploadStore;
  fetch?: FetchFn;
  now?: () => number;
}

export interface UploadClient {
  /** 未送信があれば登録 (未登録・URL 変更時) して 1 リクエスト送る。通信失敗・5xx などは例外。実行中なら合流する。 */
  send(db: Pick<ObservationDb, "uploadPending" | "countPending">, apiBase: string): Promise<SendOutcome>;
  /** 今のトークンを捨てて登録し直す (403 の解除にも使う)。 */
  register(apiBase: string): Promise<RegisterOutcome>;
  /** `apiBase` に対する登録状態。別のサーバのトークンは無いものとして扱う。 */
  state(apiBase: string): RegistrationState;
  /** 次に POST してよい時刻 (epoch ms)。過ぎていれば今すぐ送れる。 */
  nextAt(): number;
}

export const normalizeApiBase = (apiBase: string): string => apiBase.trim().replace(/\/+$/, "");

export const createUploadClient = (opts: UploadClientOptions = {}): UploadClient => {
  const store = opts.store ?? localStorageStore();
  const now = opts.now ?? Date.now;
  const rawFetch: FetchFn = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  let inflight: Promise<SendOutcome> | null = null;

  const credsFor = (base: string): Credentials | null => {
    const c = store.credentials();
    return c && c.apiBase === base ? c : null;
  };

  const register = async (base: string): Promise<Credentials | { until: number }> => {
    const res = await rawFetch(`${base}/api/v1/clients`, { method: "POST" });
    if (res.status === 429) {
      const until = now() + (parseRetryAfter(res.headers?.get("Retry-After")) ?? UPLOAD_INTERVAL_MS);
      store.setNextAt(until);
      return { until };
    }
    if (!res.ok) throw new Error(`Registration failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { clientId?: unknown; token?: unknown } | null;
    if (typeof body?.clientId !== "string" || typeof body.token !== "string" || !body.token) {
      throw new Error("Registration failed: unexpected response");
    }
    const c: Credentials = { apiBase: base, clientId: body.clientId, token: body.token, banned: false };
    store.setCredentials(c);
    return c;
  };

  /** 観測の POST を始めた時点から 60 秒を使い切ったことにする (他のウィンドウとの競合も避ける)。 */
  const gatedFetch: FetchFn = (...a) => {
    store.setNextAt(now() + UPLOAD_INTERVAL_MS);
    return rawFetch(...a);
  };

  const doSend = async (db: Pick<ObservationDb, "uploadPending" | "countPending">, apiBase: string): Promise<SendOutcome> => {
    const base = normalizeApiBase(apiBase);
    let creds = credsFor(base);
    // トークンもその間隔もサーバごと。別のサーバの分は捨てて登録し直す。
    if (!creds && store.credentials()) {
      store.setCredentials(null);
      store.setNextAt(0);
    }
    if (creds?.banned) return { status: "banned" };
    const until = store.nextAt();
    if (until > now()) return { status: "deferred", until, reason: "limiter" };
    if ((await db.countPending(now())) === 0) return { status: "idle" };

    let reregistered = false;
    for (;;) {
      if (!creds) {
        const r = await register(base);
        if ("until" in r) return { status: "deferred", until: r.until, reason: "server" };
        creds = r;
      }
      try {
        const { sent, remaining } = await db.uploadPending(base, { token: creds.token, fetch: gatedFetch, now });
        return { status: "sent", sent, remaining, nextAt: store.nextAt() };
      } catch (e) {
        if (!(e instanceof UploadHttpError)) throw e;
        if (e.status === 401 && !reregistered) {
          reregistered = true;
          store.setCredentials(null);
          creds = null;
          continue;
        }
        if (e.status === 403) {
          store.setCredentials({ ...creds, banned: true });
          return { status: "banned" };
        }
        if (e.status === 429) {
          const until = now() + (e.retryAfterMs ?? UPLOAD_INTERVAL_MS);
          store.setNextAt(until);
          return { status: "deferred", until, reason: "server" };
        }
        throw e;
      }
    }
  };

  return {
    send: (db, apiBase) => {
      inflight ??= doSend(db, apiBase).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    register: async (apiBase) => {
      const base = normalizeApiBase(apiBase);
      store.setCredentials(null);
      const r = await register(base);
      return "until" in r ? { status: "deferred", until: r.until } : { status: "registered", clientId: r.clientId };
    },
    state: (apiBase) => {
      const c = credsFor(normalizeApiBase(apiBase));
      return !c ? { kind: "none" } : c.banned ? { kind: "banned", clientId: c.clientId } : { kind: "registered", clientId: c.clientId };
    },
    nextAt: () => store.nextAt(),
  };
};

let shared: UploadClient | undefined;
/** localStorage を使う共有インスタンス (両ウィンドウで同じ状態を読む)。 */
export const getUploadClient = (): UploadClient => (shared ??= createUploadClient());
