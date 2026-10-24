import { STORAGE_PREFIX } from "../fleet";
import type { KeyValueStorage } from "../fleet";
import { defaultStorage, keysWithPrefix } from "../fleet/storage";
import type { FitEntry } from "@shared/sim/fit";
import type { EventBonusResponse } from "@shared/sim/bonuses";
import type { QuestsResponse } from "@shared/quest/types";
import type {
  ApiEquipment,
  ApiShip,
  EnemyCompsResponse,
  EstimatedStat,
  EstimatesResponse,
  MapDetail,
  MapSummary,
  ShipDetail,
} from "@shared/data/types";

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
/** 任務データ (サーバの取り込みは 1 日 1 回) */
const QUEST_TTL = 24 * 60 * 60 * 1000;
/** 429 を取り直す回数と、Retry-After の上限 (秒) */
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_S = 10;
/** GET /ship-details の 1 リクエストの id 数の上限 (サーバと同じ) */
const SHIP_DETAILS_MAX = 200;

interface Entry {
  t: number;
  data: unknown;
}

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

  private get<T>(path: string, fresh = false, ttl = this.ttl): Promise<Loaded<T>> {
    const key = `${this.opts.baseUrl().replace(/\/+$/, "")}${path}`;
    const cached = this.readEntry(key);
    if (!fresh && cached && this.now() - cached.t < ttl) {
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
        this.writeEntry(key, { t: this.now(), data });
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

  async maps() {
    const r = await this.get<{ maps: MapSummary[] }>("/api/v1/maps");
    return { data: r.data.maps, stale: r.stale };
  }
  map(key: string) {
    return this.get<MapDetail>(`/api/v1/maps/${encodeURIComponent(key)}`);
  }
  /** 海域の全マスの敵編成 (1 リクエスト)。出典は API の既定ポリシー: 観測 (poi-observed) が minObserved 件以上なら観測、でなければ KCNav (API.md §2)。 */
  enemyComps(map: string, minObserved?: number) {
    const q = minObserved === undefined ? "" : `?minObserved=${minObserved}`;
    return this.get<EnemyCompsResponse>(`/api/v1/maps/${encodeURIComponent(map)}/enemy-comps${q}`);
  }
  async abyssalShips() {
    const r = await this.get<{ ships: ApiShip[] }>("/api/v1/ships?abyssal=1");
    return { data: r.data.ships, stale: r.stale };
  }
  ship(id: number) {
    return this.get<ShipDetail>(`/api/v1/ships/${id}`);
  }
  /** 複数の艦の ship() を SHIP_DETAILS_MAX 件ずつ 1 リクエストで。サーバに無い id は結果に入らない。 */
  async shipDetails(ids: number[]) {
    const chunks = Array.from({ length: Math.ceil(ids.length / SHIP_DETAILS_MAX) }, (_, i) => ids.slice(i * SHIP_DETAILS_MAX, (i + 1) * SHIP_DETAILS_MAX));
    const parts = await Promise.all(chunks.map((c) => this.get<{ ships: ShipDetail[] }>(`/api/v1/ship-details?ids=${c.join(",")}`)));
    return { data: parts.flatMap((r) => r.data.ships), stale: parts.some((r) => r.stale) };
  }
  /** サーバの推定値 (docs/API.md)。`density` は shipId 指定のときだけ事前・事後分布を含める。`fresh` はキャッシュを使わず取り直す。 */
  estimates(q: { shipId?: number; stat?: EstimatedStat; minN?: number; density?: boolean } = {}, fresh = false) {
    const p = new URLSearchParams();
    if (q.shipId !== undefined) p.set("shipId", String(q.shipId));
    if (q.stat) p.set("stat", q.stat);
    if (q.minN !== undefined) p.set("minN", String(q.minN));
    if (q.density !== undefined) p.set("density", q.density ? "1" : "0");
    const qs = p.toString();
    return this.get<EstimatesResponse>(`/api/v1/estimates${qs ? `?${qs}` : ""}`, fresh);
  }
  async fitBonuses() {
    const r = await this.get<{ fitBonuses: FitEntry[] }>("/api/v1/fit-bonuses");
    return { data: r.data.fitBonuses, stale: r.stale };
  }
  /** イベント特効と装甲デバフ (docs/API.md)。データの無い海域は HTTP 404 の DataApiError。 */
  eventBonuses(map: string) {
    return this.get<EventBonusResponse>(`/api/v1/maps/${encodeURIComponent(map)}/bonuses`);
  }
  async abyssalEquipments() {
    const r = await this.get<{ equipments: ApiEquipment[] }>("/api/v1/equipments?abyssal=1");
    return { data: r.data.equipments, stale: r.stale };
  }
  /** 任務の一覧 (前提・条件つき、docs/API.md)。サーバは 1 日 1 回取り込むので、キャッシュも 1 日使う。 */
  quests() {
    return this.get<QuestsResponse>("/api/v1/quests", false, QUEST_TTL);
  }
}

let shared: DataApi | undefined;
/** UI の共有クライアント。データ API はページと同じオリジンの /api (server の Worker が両方を配る)。 */
export const getDataApi = (): DataApi => (shared ??= new DataApi({ baseUrl: () => "" }));
