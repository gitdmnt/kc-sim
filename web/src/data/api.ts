import { STORAGE_PREFIX } from "../fleet";
import type { KeyValueStorage } from "../fleet";
import { defaultStorage, keysWithPrefix } from "../fleet/storage";
import type { FitEntry } from "@shared/sim/fit";
import type { EventBonusResponse } from "@shared/sim/bonuses";
import type { QuestsResponse } from "@shared/quest/types";
import type { ApiEquipment, ApiShip, EnemyCompsResponse, EstimatesResponse, MapDetail, MapSummary, ShipDetail } from "@shared/data/types";

// 画面ごとの応答 (private notes API「Views」)。どれも個別の API の応答をまとめたもの

/** `GET /api/v1/views/boot`: どの画面も使う一覧 (海域・深海装備・装備ボーナス)。 */
export interface BootView {
  dataVersion: number;
  maps: MapSummary[];
  equipments: ApiEquipment[];
  fitBonuses: FitEntry[];
}
/** `GET /api/v1/views/map/{map}`: 1 海域 (出撃・海域タブ)。ships は編成に出る全艦、bonuses はイベント特効 (無い海域は null)。 */
export interface MapView {
  detail: MapDetail;
  enemyComps: EnemyCompsResponse;
  ships: ShipDetail[];
  bonuses: EventBonusResponse | null;
}
/** `GET /api/v1/views/enemy/{id}`: 敵艦タブの 1 隻 (推定は分布つき)。 */
export interface EnemyShipView {
  detail: ShipDetail;
  estimates: EstimatesResponse;
}
/** `GET /api/v1/views/enemy`: 敵艦タブの一覧 (推定は分布なし) と、選ぶ前に出す先頭の艦の EnemyShipView。 */
export interface EnemyView {
  ships: ApiShip[];
  estimates: EstimatesResponse;
  firstShip: EnemyShipView | null;
}

export type DataErrorKind = "offline" | "http" | "parse";

export class DataApiError extends Error {
  constructor(
    public kind: DataErrorKind,
    message: string,
    public status?: number
  ) {
    super(message);
  }
}

/** `stale` は通信に失敗して期限切れキャッシュを返した場合に true。 */
export interface Loaded<T> {
  data: T;
  stale: boolean;
}

export interface DataApiOptions {
  baseUrl: () => string;
  fetch?: typeof fetch;
  storage?: KeyValueStorage;
  ttlMs?: number;
  now?: () => number;
  /** 429 の後の待ち (テストで差し替える) */
  sleep?: (ms: number) => Promise<void>;
}

const CACHE_PREFIX = `${STORAGE_PREFIX}cache:`;
const DEFAULT_TTL = 10 * 60 * 1000;
/** 任務データの版が分からない (boot が取れない) ときのキャッシュ期間 */
const QUEST_TTL = 24 * 60 * 60 * 1000;
/** 429 を取り直す回数と、Retry-After の上限 (秒) */
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_S = 10;

interface Entry {
  t: number;
  data: unknown;
  v?: number;
}

/** 応答の ETag (`"dv<n>"`、圧縮されると `W/"dv<n>"`) から data_version を返す。 */
const etagVersion = (res: Response): number | undefined => {
  const m = /^(?:W\/)?"dv(\d+)"$/.exec(res.headers.get("ETag") ?? "");
  return m ? Number(m[1]) : undefined;
};

export class DataApi {
  private memory = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Loaded<unknown>>>();
  private storage: KeyValueStorage;
  private ttl: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: DataApiOptions) {
    this.storage = opts.storage ?? defaultStorage();
    this.ttl = opts.ttlMs ?? DEFAULT_TTL;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ??
      ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
  }

  private readEntry(key: string): Entry | undefined {
    const mem = this.memory.get(key);
    if (mem) return mem;
    try {
      const raw = this.storage.getItem(CACHE_PREFIX + key);
      if (raw) {
        const entry = JSON.parse(raw) as Entry;
        this.memory.set(key, entry);
        return entry;
      }
    } catch {
      // 壊れたキャッシュは無視
    }
    return undefined;
  }

  private writeEntry(key: string, entry: Entry) {
    this.memory.set(key, entry);
    try {
      this.storage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
    } catch {
      // 容量超過などはメモリキャッシュだけで続行
    }
  }

  /** メモリ・localStorage のキャッシュを全消去する (設定の「キャッシュ消去」から)。 */
  clearCache() {
    this.memory.clear();
    for (const k of keysWithPrefix(this.storage, CACHE_PREFIX)) this.storage.removeItem(k);
  }

  private keyOf(path: string) {
    return `${this.opts.baseUrl().replace(/\/+$/, "")}${path}`;
  }

  private get<T>(path: string, { ttl = this.ttl, version }: { ttl?: number; version?: number } = {}): Promise<Loaded<T>> {
    const key = this.keyOf(path);
    const cached = this.readEntry(key);
    if (cached && (version === undefined ? this.now() - cached.t < ttl : cached.v === version)) {
      return Promise.resolve({ data: cached.data as T, stale: false });
    }
    const running = this.inflight.get(key);
    if (running) return running as Promise<Loaded<T>>;

    const p = (async (): Promise<Loaded<T>> => {
      try {
        const fetchOnce = async () => {
          try {
            return await (this.opts.fetch ?? globalThis.fetch)(key);
          } catch (e) {
            throw new DataApiError("offline", `データサーバに接続できません (${(e as Error).message})`);
          }
        };
        let res = await fetchOnce();
        // Cloudflare のレート制限 (429, error 1015) は数秒で解ける: Retry-After だけ待って取り直す
        for (let i = 0; res.status === 429 && i < RATE_LIMIT_RETRIES; i++) {
          await this.sleep(Math.min(MAX_RETRY_AFTER_S, Number(res.headers.get("Retry-After")) || 2) * 1000);
          res = await fetchOnce();
        }
        if (!res.ok) throw new DataApiError("http", `HTTP ${res.status}`, res.status);
        let data: T;
        try {
          data = (await res.json()) as T;
        } catch {
          throw new DataApiError("parse", "応答を解釈できません");
        }
        this.writeEntry(key, { t: this.now(), data, v: etagVersion(res) });
        return { data, stale: false };
      } catch (e) {
        // 404 など「無い」ことが確定した応答は古いキャッシュで隠さない
        const err = e as DataApiError;
        if (cached && (err.kind === "offline" || err.status === 429 || (err.status ?? 0) >= 500)) {
          return { data: cached.data as T, stale: true };
        }
        throw e;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** 起動時に 1 回: 海域一覧・深海装備・装備ボーナス */
  boot() {
    return this.get<BootView>("/api/v1/views/boot");
  }
  /** 1 海域の一式 (1 リクエスト)。敵編成の出典は API の既定ポリシー: 観測 (poi-observed) が minObserved 件以上なら観測、でなければ KCNav (private notes API §2)。 */
  mapView(key: string, minObserved?: number) {
    const q = minObserved === undefined ? "" : `?minObserved=${minObserved}`;
    return this.get<MapView>(`/api/v1/views/map/${encodeURIComponent(key)}${q}`);
  }
  /** 敵艦タブの一覧。応答に入っている先頭の艦の詳細はキャッシュに入れ、選んだときに取り直さない。 */
  async enemyView() {
    const r = await this.get<EnemyView>("/api/v1/views/enemy");
    const first = r.data.firstShip;
    if (first) {
      const key = this.keyOf(`/api/v1/views/enemy/${first.detail.ship.id}`);
      const had = this.readEntry(key);
      if (!had || this.now() - had.t >= this.ttl) this.writeEntry(key, { t: this.now(), data: first });
    }
    return r;
  }
  /** 敵艦タブで選んだ 1 隻 (詳細と、分布つきのサーバの推定) */
  enemyShip(id: number) {
    return this.get<EnemyShipView>(`/api/v1/views/enemy/${id}`);
  }
  /** 任務の一覧を、boot の dataVersion と同じ版のキャッシュがあればそこから返す。 */
  async quests() {
    const version = await this.boot().then(
      (r) => (r.stale ? undefined : r.data.dataVersion),
      () => undefined
    );
    return this.get<QuestsResponse>("/api/v1/quests", { ttl: QUEST_TTL, version });
  }
}

let shared: DataApi | undefined;
/** UI の共有クライアント。データ API はページと同じオリジンの /api (server の Worker が両方を配る)。 */
export const getDataApi = (): DataApi => (shared ??= new DataApi({ baseUrl: () => "" }));
