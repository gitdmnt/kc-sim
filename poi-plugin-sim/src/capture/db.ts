/** IndexedDB 保存 (DB `kcsim`)。薄い Promise ラッパのみで依存なし。 */
import type { ObservationSink } from "./session";
import type { BattleResultInfo, CapturedBattle, CapturedSortie, StoredEvent } from "./types";

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

export interface UploadOptions {
  fetch?: typeof fetch;
  /** settings に永続化したクライアント ID (`poi-<uuid>`) */
  clientId: string;
  /** 既定 `/api/v1/observations` */
  path?: string;
  batchSize?: number;
  /** 出撃中レコードの放置判定に使う現在時刻 (テスト用) */
  now?: () => number;
}

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
    return JSON.stringify({ format: "kcsim-observations", version: 2, battles, events, sorties });
  }

  /**
   * 未送信の戦闘と終わった出撃を `${apiBase}/api/v1/observations` に送る (docs/API.md §3)。戦闘が先。
   * 2xx なら送信済みにする。map が null の戦闘 (演習等) は送らず、送信済み扱いにする。
   * 出撃中の出撃は送らない。STALE_SORTIE_MS 以上更新の無い出撃は endKind "unknown" で送る。
   * 失敗時は例外 (未送信のまま)。戻り値は送信した件数。
   */
  async uploadPending(apiBase: string, opts: UploadOptions): Promise<number> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const url = `${apiBase.replace(/\/+$/, "")}${opts.path ?? "/api/v1/observations"}`;
    const batchSize = Math.min(opts.batchSize ?? 100, 500);
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

    let sent = 0;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const observations = [];
      for (const p of batch) observations.push(p.kind === "battle" ? await this.battleObservation(p.b) : sortieObservation(p.s));
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: opts.clientId, observations }),
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      await markSent(
        batch.flatMap((p) => (p.kind === "battle" ? [p.b] : [])),
        batch.flatMap((p) => (p.kind === "sortie" ? [p.s] : []))
      );
      sent += batch.length;
    }
    return sent;
  }

  private async battleObservation(b: CapturedBattle) {
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
      enemy: b.enemy,
      raw: {
        path: b.path,
        visitId: b.visitId,
        sortieId: map.sortieId ?? null,
        raw: b.raw,
        result: b.result,
        events: await this.listEvents(b.id),
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
    combined: s.combined,
    endKind: s.endKind ?? "unknown",
    endedAt: s.endedAt === null ? null : new Date(s.endedAt).toISOString(),
    cells: s.cells.map((c) => ({
      no: c.no, from: c.from, colorNo: c.colorNo, eventId: c.eventId, eventKind: c.eventKind,
      bossCellNo: c.bossCellNo, next: c.next, selectCells: c.selectCells, battles: c.battles,
    })),
    cellData: s.cellData,
    features: s.features,
  },
});
