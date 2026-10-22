import { STORAGE_PREFIX } from "../fleet";
import type { KeyValueStorage } from "../fleet";
import { defaultStorage, keysWithPrefix } from "../fleet/storage";
import { getSettings } from "../app/settings";
import type { FitEntry } from "@shared/sim/fit";
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
}

const CACHE_PREFIX = `${STORAGE_PREFIX}cache:`;
const DEFAULT_TTL = 10 * 60 * 1000;

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

  constructor(private opts: DataApiOptions) {
    this.storage = opts.storage ?? defaultStorage();
    this.ttl = opts.ttlMs ?? DEFAULT_TTL;
    this.now = opts.now ?? Date.now;
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

  private get<T>(path: string, fresh = false): Promise<Loaded<T>> {
    const key = `${this.opts.baseUrl().replace(/\/+$/, "")}${path}`;
    const cached = this.readEntry(key);
    if (!fresh && cached && this.now() - cached.t < this.ttl) {
      return Promise.resolve({ data: cached.data as T, stale: false });
    }
    const running = this.inflight.get(key);
    if (running) return running as Promise<Loaded<T>>;

    const p = (async (): Promise<Loaded<T>> => {
      try {
        let res: Response;
        try {
          res = await (this.opts.fetch ?? globalThis.fetch)(key);
        } catch (e) {
          throw new DataApiError("offline", `データサーバに接続できません (${(e as Error).message})`);
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
        if (cached && (err.kind === "offline" || (err.status ?? 0) >= 500)) {
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
  /** 出典は API の既定ポリシー: 観測 (poi-observed) が minObserved 件以上なら観測、でなければ KCNav (API.md §2)。 */
  enemyComps(map: string, node: string, minObserved?: number) {
    const q = minObserved === undefined ? "" : `?minObserved=${minObserved}`;
    return this.get<EnemyCompsResponse>(
      `/api/v1/maps/${encodeURIComponent(map)}/nodes/${encodeURIComponent(node)}/enemy-comps${q}`
    );
  }
  async abyssalShips() {
    const r = await this.get<{ ships: ApiShip[] }>("/api/v1/ships?abyssal=1");
    return { data: r.data.ships, stale: r.stale };
  }
  ship(id: number) {
    return this.get<ShipDetail>(`/api/v1/ships/${id}`);
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
  async abyssalEquipments() {
    const r = await this.get<{ equipments: ApiEquipment[] }>("/api/v1/equipments?abyssal=1");
    return { data: r.data.equipments, stale: r.stale };
  }
}

let shared: DataApi | undefined;
/** 設定の API ベース URL を毎回参照する共有クライアント。 */
export const getDataApi = (): DataApi =>
  (shared ??= new DataApi({ baseUrl: () => getSettings().apiBase }));
