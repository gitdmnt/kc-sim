/** IndexedDB 保存 (DB `kcsim`)。薄い Promise ラッパのみで依存なし。 */
import type { ObservationSink } from "./session";
import type { BattleResultInfo, CapturedBattle, StoredEvent } from "./types";

const DB_NAME = "kcsim";
const DB_VERSION = 1;
const BATTLES = "battles";
const EVENTS = "events";

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
}

export class ObservationDb implements ObservationSink {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private factory: IDBFactory = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const r = this.factory.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        const battles = db.createObjectStore(BATTLES, { keyPath: "id" });
        battles.createIndex("map", "map.map");
        battles.createIndex("mapNode", ["map.map", "map.node"]);
        battles.createIndex("enemyMasterIds", "enemyMasterIds", { multiEntry: true });
        battles.createIndex("pending", "pending");
        const events = db.createObjectStore(EVENTS, { keyPath: "key", autoIncrement: true });
        events.createIndex("battleId", "battleId");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.dbPromise;
  }

  async close() {
    if (!this.dbPromise) return;
    (await this.dbPromise).close();
    this.dbPromise = null;
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

  /** 未送信の戦闘数 */
  async countPending(): Promise<number> {
    const db = await this.open();
    return req(db.transaction(BATTLES).objectStore(BATTLES).index("pending").count(1));
  }

  /** 全ての戦闘とイベントを削除する。 */
  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([BATTLES, EVENTS], "readwrite");
    tx.objectStore(BATTLES).clear();
    tx.objectStore(EVENTS).clear();
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
    const tx = db.transaction([BATTLES, EVENTS]);
    const [battles, events] = await Promise.all([
      req(tx.objectStore(BATTLES).getAll()),
      req(tx.objectStore(EVENTS).getAll()),
    ]);
    return JSON.stringify({ format: "kcsim-observations", version: 1, battles, events });
  }

  /**
   * 未送信の戦闘を `${apiBase}/api/v1/observations` に送る (docs/API.md §3)。
   * 2xx なら送信済みにする。map が null の戦闘 (演習等) は送らず、送信済み扱いにする。
   * 失敗時は例外 (未送信のまま)。戻り値は送信した件数。
   */
  async uploadPending(apiBase: string, opts: UploadOptions): Promise<number> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const url = `${apiBase.replace(/\/+$/, "")}${opts.path ?? "/api/v1/observations"}`;
    const batchSize = Math.min(opts.batchSize ?? 100, 500);
    const db = await this.open();
    const all: CapturedBattle[] = await req(
      db.transaction(BATTLES).objectStore(BATTLES).index("pending").getAll(1)
    );
    const markSent = async (list: CapturedBattle[]) => {
      const tx = db.transaction(BATTLES, "readwrite");
      for (const b of list) tx.objectStore(BATTLES).put({ ...b, pending: 0 });
      await done(tx);
    };
    await markSent(all.filter((b) => !b.map));
    const pending = all.filter((b) => b.map);

    let sent = 0;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const observations = [];
      for (const b of batch) {
        observations.push({
          clientObsId: b.id,
          observedAt: new Date(b.capturedAt).toISOString(),
          map: b.map!.map,
          node: b.map!.node,
          difficulty: b.map!.difficulty ?? 0,
          kind: "battle",
          fleet: b.fleet,
          enemy: b.enemy,
          raw: {
            path: b.path,
            visitId: b.visitId,
            raw: b.raw,
            result: b.result,
            events: await this.listEvents(b.id),
          },
        });
      }
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: opts.clientId, observations }),
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      await markSent(batch);
      sent += batch.length;
    }
    return sent;
  }
}
