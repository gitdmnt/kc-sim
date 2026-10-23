/** IndexedDB 保存 (DB `kcsim`)。薄い Promise ラッパのみで依存なし。 */
import type { ObservationSink } from "./session";
import type { BattleResultInfo, CapturedBattle, CapturedSortie, StoredEvent } from "@shared/capture/types";

const DB_NAME = "kcsim";
/** 2: sorties ストアを追加 */
const DB_VERSION = 2;
const BATTLES = "battles";
const EVENTS = "events";
const SORTIES = "sorties";

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export interface ListBattlesQuery {
  /** "1-1" 形式 */
  map?: string;
  node?: string;
  limit?: number;
}

/** サーバが 1 リクエストで受け付ける観測数の上限 (docs/API.md §3) */
export const MAX_OBSERVATIONS_PER_REQUEST = 100;

/** fetch のうち使う部分 (typeof fetch は Bun で preconnect を要求するので、関数だけを求める) */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * サーバの本文の上限は 256 KiB (超えると 413、Workers Free の CPU 予算に収めるため)。余裕を見て 1 リクエストの
 * JSON をこの大きさ未満にする。戦闘 60 件ほど。
 */
export const MAX_REQUEST_BYTES = 250_000;
/** 観測 1 件の JSON の上限 (サーバは超えたものを too_large で拒否する)。 */
export const MAX_OBSERVATION_BYTES = 64 * 1024;
const REQUEST_OVERHEAD = `{"observations":[]}`.length;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export interface UploadOptions {
  fetch?: FetchFn;
  /** `POST /api/v1/clients` で発行されたトークン (Authorization: Bearer) */
  token: string;
  /** 既定 `/api/v1/observations` */
  path?: string;
  /** 出撃中レコードの放置判定に使う現在時刻 (テスト用) */
  now?: () => number;
}

export interface UploadBatch {
  /** 今回のリクエストで送った件数 */
  sent: number;
  /** まだ未送信で残っている件数 */
  remaining: number;
}

/** 非 2xx の応答。`retryAfterMs` は Retry-After (秒) を読んだもの。無い・読めなければ null。 */
export class UploadHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly retryAfterMs: number | null = null
  ) {
    super(`Upload failed: ${status} ${statusText}`);
    this.name = "UploadHttpError";
  }
}

/** Retry-After ヘッダ (秒数) をミリ秒にする。HTTP 日付形式は使わない。 */
export const parseRetryAfter = (value: string | null | undefined): number | null => {
  if (value == null || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return null;
  return Math.ceil(Number(value) * 1000);
};

export class ObservationDb implements ObservationSink {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private factory: IDBFactory = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const r = this.factory.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (ev) => {
        const db = r.result;
        if (ev.oldVersion < 1) {
          const battles = db.createObjectStore(BATTLES, { keyPath: "id" });
          battles.createIndex("map", "map.map");
          battles.createIndex("mapNode", ["map.map", "map.node"]);
          battles.createIndex("enemyMasterIds", "enemyMasterIds", { multiEntry: true });
          battles.createIndex("pending", "pending");
          const events = db.createObjectStore(EVENTS, { keyPath: "key", autoIncrement: true });
          events.createIndex("battleId", "battleId");
        }
        if (ev.oldVersion < 2) {
          const sorties = db.createObjectStore(SORTIES, { keyPath: "id" });
          sorties.createIndex("pending", "pending");
          sorties.createIndex("map", "map");
        }
      };
      r.onsuccess = () => {
        // 別ウィンドウ (メイン / プラグイン) が新しい版で開くとき、古い接続が upgrade を塞がないように閉じる
        r.result.onversionchange = () => {
          r.result.close();
          this.dbPromise = null;
        };
        resolve(r.result);
      };
      r.onerror = () => reject(r.error);
    });
    return this.dbPromise;
  }

  async close() {
    if (!this.dbPromise) return;
    (await this.dbPromise).close();
    this.dbPromise = null;
  }

  async saveSortie(sortie: CapturedSortie): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(SORTIES, "readwrite");
    tx.objectStore(SORTIES).put(sortie);
    await done(tx);
  }

  async listSorties(map?: string): Promise<CapturedSortie[]> {
    const db = await this.open();
    const store = db.transaction(SORTIES).objectStore(SORTIES);
    const all: CapturedSortie[] = await req(map === undefined ? store.getAll() : store.index("map").getAll(map));
    return all.sort((a, b) => a.startedAt - b.startedAt);
  }

  async saveBattle(battle: CapturedBattle, events: StoredEvent[]): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([BATTLES, EVENTS], "readwrite");
    tx.objectStore(BATTLES).put(battle);
    const store = tx.objectStore(EVENTS);
    for (const e of events) store.add(e);
    await done(tx);
  }

  async saveResult(battleId: string, result: BattleResultInfo): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(BATTLES, "readwrite");
    const store = tx.objectStore(BATTLES);
    const battle: CapturedBattle | undefined = await req(store.get(battleId));
    if (battle) store.put({ ...battle, result, pending: 1 });
    await done(tx);
  }

  async listBattles(query: ListBattlesQuery = {}): Promise<CapturedBattle[]> {
    const db = await this.open();
    const store = db.transaction(BATTLES).objectStore(BATTLES);
    let all: CapturedBattle[];
    if (query.map !== undefined && query.node !== undefined) {
      all = await req(store.index("mapNode").getAll([query.map, query.node]));
    } else if (query.map !== undefined) {
      all = await req(store.index("map").getAll(query.map));
    } else {
      all = await req(store.getAll());
    }
    all.sort((a, b) => a.capturedAt - b.capturedAt);
    return query.limit ? all.slice(-query.limit) : all;
  }

  /** 指定の敵艦 (masterId) を含む戦闘の数。 */
  async countObservations(enemyMasterId: number): Promise<number> {
    const db = await this.open();
    const store = db.transaction(BATTLES).objectStore(BATTLES);
    return req(store.index("enemyMasterIds").count(enemyMasterId));
  }

  async countBattles(): Promise<number> {
    const db = await this.open();
    return req(db.transaction(BATTLES).objectStore(BATTLES).count());
  }

  /** 未送信の観測数 (戦闘 + 送信できる出撃) */
  async countPending(now: number = Date.now()): Promise<number> {
    const db = await this.open();
    const tx = db.transaction([BATTLES, SORTIES]);
    const [battles, sorties] = await Promise.all([
      req(tx.objectStore(BATTLES).index("pending").count(1)),
      req(tx.objectStore(SORTIES).index("pending").getAll(1)) as Promise<CapturedSortie[]>,
    ]);
    return battles + sorties.filter((s) => uploadableSortie(s, now)).length;
  }

  /** 全ての戦闘・イベント・出撃を削除する。 */
  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([BATTLES, EVENTS, SORTIES], "readwrite");
    tx.objectStore(BATTLES).clear();
    tx.objectStore(EVENTS).clear();
    tx.objectStore(SORTIES).clear();
    await done(tx);
  }

  async listEvents(battleId: string): Promise<StoredEvent[]> {
    const db = await this.open();
    const store = db.transaction(EVENTS).objectStore(EVENTS);
    const events: StoredEvent[] = await req(store.index("battleId").getAll(battleId));
    return events.sort((a, b) => a.seq - b.seq);
  }

  async exportJSON(): Promise<string> {
    const db = await this.open();
    const tx = db.transaction([BATTLES, EVENTS, SORTIES]);
    const [battles, events, sorties] = await Promise.all([
      req(tx.objectStore(BATTLES).getAll()),
      req(tx.objectStore(EVENTS).getAll()),
      req(tx.objectStore(SORTIES).getAll()),
    ]);
    return JSON.stringify({ format: "kcsim-observations", version: 3, battles, events, sorties });
  }

  /**
   * 未送信の戦闘と終わった出撃を、1 回の POST で `${apiBase}/api/v1/observations` に送る (docs/API.md §3)。
   * 1 リクエストは最大 MAX_OBSERVATIONS_PER_REQUEST 件かつ JSON が MAX_REQUEST_BYTES 未満になるまで古い順に詰める。
   * 戦闘が先。2xx なら送った分を送信済みにする (サーバは受け取って溜め、検証は後で行う)。map が null の戦闘
   * (演習等) は送らず、送信済み扱いにする。MAX_OBSERVATION_BYTES を超える 1 件はサーバが拒否するので捨てる (送信済み扱い)。
   * 出撃中の出撃は送らない。STALE_SORTIE_MS 以上更新の無い出撃は endKind "unknown" で送る。
   * 送るものが無ければ POST しない。非 2xx は UploadHttpError、通信失敗はその例外 (どちらも未送信のまま)。
   * 送信間隔 (1 トークン 60 秒に 1 回) は呼び出し側 (uploadClient) が守る。
   */
  async uploadPending(apiBase: string, opts: UploadOptions): Promise<UploadBatch> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const url = `${apiBase.replace(/\/+$/, "")}${opts.path ?? "/api/v1/observations"}`;
    const now = (opts.now ?? Date.now)();
    const db = await this.open();
    const read = db.transaction([BATTLES, SORTIES]);
    const [all, openOrDone] = await Promise.all([
      req(read.objectStore(BATTLES).index("pending").getAll(1)) as Promise<CapturedBattle[]>,
      req(read.objectStore(SORTIES).index("pending").getAll(1)) as Promise<CapturedSortie[]>,
    ]);
    const markSent = async (battles: CapturedBattle[], sorties: CapturedSortie[]) => {
      const tx = db.transaction([BATTLES, SORTIES], "readwrite");
      for (const b of battles) tx.objectStore(BATTLES).put({ ...b, pending: 0 });
      for (const s of sorties) tx.objectStore(SORTIES).put({ ...s, pending: 0 });
      await done(tx);
    };
    await markSent(all.filter((b) => !b.map), []);
    const pending: ({ kind: "battle"; b: CapturedBattle } | { kind: "sortie"; s: CapturedSortie })[] = [
      ...all.filter((b) => b.map).sort((x, y) => x.capturedAt - y.capturedAt).map((b) => ({ kind: "battle" as const, b })),
      ...openOrDone.filter((s) => uploadableSortie(s, now)).sort((x, y) => x.startedAt - y.startedAt)
        .map((s) => ({ kind: "sortie" as const, s: s.endKind ? s : { ...s, endKind: "unknown" as const } })),
    ];
    const bodies: string[] = [];
    const batch: typeof pending = [];
    const dropped: typeof pending = [];
    let bytes = REQUEST_OVERHEAD;
    for (const p of pending) {
      if (batch.length >= MAX_OBSERVATIONS_PER_REQUEST) break;
      const json = JSON.stringify(p.kind === "battle" ? this.battleObservation(p.b) : sortieObservation(p.s));
      const size = utf8Bytes(json) + 1; // 区切りの ","
      if (size - 1 > MAX_OBSERVATION_BYTES) {
        console.warn(`[kcsim] observation too large to upload (${size} bytes), dropped`);
        dropped.push(p);
      } else if (bytes + size > MAX_REQUEST_BYTES) {
        break;
      } else {
        bytes += size;
        batch.push(p);
        bodies.push(json);
      }
    }
    const sentOf = (items: typeof pending) => [
      items.flatMap((p) => (p.kind === "battle" ? [p.b] : [])),
      items.flatMap((p) => (p.kind === "sortie" ? [p.s] : [])),
    ] as const;
    if (dropped.length > 0) await markSent(...sentOf(dropped));
    if (batch.length === 0) return { sent: 0, remaining: 0 };

    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
      body: `{"observations":[${bodies.join(",")}]}`,
    });
    if (!res.ok) throw new UploadHttpError(res.status, res.statusText, parseRetryAfter(res.headers?.get("Retry-After")));
    await markSent(...sentOf(batch));
    return { sent: batch.length, remaining: pending.length - batch.length - dropped.length };
  }

  private battleObservation(b: CapturedBattle) {
    const map = b.map!;
    return {
      clientObsId: b.id,
      observedAt: new Date(b.capturedAt).toISOString(),
      map: map.map,
      node: map.node,
      cell: map.cellId,
      ...(map.layout ? { layout: map.layout } : {}),
      difficulty: map.difficulty ?? defaultDifficulty(map.area),
      kind: "battle",
      fleet: b.fleet,
      // サーバは受け取った生のパケット (raw.raw) から敵編成も攻撃イベントも導き直す。enemy / events は送らない。
      raw: {
        path: b.path,
        visitId: b.visitId,
        sortieId: map.sortieId ?? null,
        raw: b.raw,
        result: b.result,
      },
    };
  }
}

/** 通常海域 (1-7) は難易度 0。イベント海域で難易度が分からなければ null (サーバは編成集計に使わない)。 */
const defaultDifficulty = (area: number): number | null => (area < 10 ? 0 : null);

/** これ以上更新の無い出撃中レコードは、終わりを取り逃したものとして送る。 */
export const STALE_SORTIE_MS = 6 * 60 * 60 * 1000;

const uploadableSortie = (s: CapturedSortie, now: number): boolean =>
  s.cells.length > 0 && (s.endKind !== null || now - s.updatedAt >= STALE_SORTIE_MS);

/** 出撃 1 件 = kind "sortie" の観測 1 件 (docs/API.md §3)。 */
export const sortieObservation = (s: CapturedSortie) => ({
  clientObsId: s.id,
  observedAt: new Date(s.startedAt).toISOString(),
  map: s.map,
  ...(s.cellData ? { layout: s.cellData.map((c) => c.no) } : {}),
  difficulty: s.difficulty ?? defaultDifficulty(s.area),
  kind: "sortie",
  fleet: s.fleet,
  sortie: {
    deckId: s.deckId,
    fleetSize: s.fleetSize ?? s.fleet?.ships.length ?? null,
    escortSize: s.escortSize ?? s.fleet?.escort?.length ?? 0,
    gauge: s.gauge ?? null,
    combined: s.combined,
    endKind: s.endKind ?? "unknown",
    endedAt: s.endedAt === null ? null : new Date(s.endedAt).toISOString(),
    cells: s.cells.map((c) => ({
      no: c.no, from: c.from, colorNo: c.colorNo, eventId: c.eventId, eventKind: c.eventKind,
      bossCellNo: c.bossCellNo, next: c.next, selectCells: c.selectCells, battles: c.battles,
      ...(c.result ? { result: c.result } : {}),
    })),
    cellData: s.cellData,
    features: s.features,
  },
  // 地図の生のパケット。サーバが cells / cellData をここから導き直す。
  ...(s.packets?.length ? { raw: { packets: s.packets } } : {}),
});
