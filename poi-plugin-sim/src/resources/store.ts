/**
 * 資源の推移の IndexedDB 保存 (DB `kcsim-resources`)。観測ログの DB (`kcsim`) とは分ける: 観測ログの全削除や
 * その版上げに巻き込まない。poi のメインウィンドウとプラグインウィンドウは同じオリジン (file://) なので同じ DB を見る。
 */
import type { ResourceSnapshot, ResourceStore } from "./history";

const DB_NAME = "kcsim-resources";
const DB_VERSION = 1;
const SNAPSHOTS = "snapshots";
/** [admiral, t] の複合インデックス */
const BY_ADMIRAL_TIME = "admiralTime";

const req = <T>(r: IDBRequest<T>): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  return promise;
};

const done = (tx: IDBTransaction): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
  return promise;
};

export class ResourceDb implements ResourceStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private factory: IDBFactory = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const r = this.factory.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const store = r.result.createObjectStore(SNAPSHOTS, { keyPath: "id", autoIncrement: true });
      store.createIndex(BY_ADMIRAL_TIME, ["admiral", "t"]);
    };
    r.onsuccess = () => {
      // 別ウィンドウが新しい版で開くとき、古い接続が upgrade を塞がないように閉じる
      r.result.onversionchange = () => {
        r.result.close();
        this.dbPromise = null;
      };
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
    this.dbPromise = promise;
    return promise;
  }

  async close() {
    if (!this.dbPromise) return;
    (await this.dbPromise).close();
    this.dbPromise = null;
  }

  private async index(mode: IDBTransactionMode = "readonly") {
    const db = await this.open();
    return db.transaction(SNAPSHOTS, mode).objectStore(SNAPSHOTS).index(BY_ADMIRAL_TIME);
  }

  async last(admiral: string): Promise<ResourceSnapshot | undefined> {
    const range = IDBKeyRange.bound([admiral, -Infinity], [admiral, Infinity]);
    const cursor = await req((await this.index()).openCursor(range, "prev"));
    return cursor?.value as ResourceSnapshot | undefined;
  }

  async add(snapshot: ResourceSnapshot): Promise<ResourceSnapshot> {
    const db = await this.open();
    const tx = db.transaction(SNAPSHOTS, "readwrite");
    const committed = done(tx);
    const { id: _, ...row } = snapshot;
    const id = (await req(tx.objectStore(SNAPSHOTS).add(row))) as number;
    await committed;
    return { ...row, id };
  }

  async list(admiral: string, from = -Infinity): Promise<ResourceSnapshot[]> {
    const range = IDBKeyRange.bound([admiral, from], [admiral, Infinity]);
    return req((await this.index()).getAll(range));
  }

  async apply(remove: number[], update: ResourceSnapshot[]): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(SNAPSHOTS, "readwrite");
    const store = tx.objectStore(SNAPSHOTS);
    for (const id of remove) store.delete(id);
    for (const s of update) store.put(s);
    await done(tx);
  }

  /** 記録のある提督 (最新の記録が新しい順) */
  async admirals(): Promise<{ admiral: string; lastAt: number }[]> {
    const index = await this.index();
    const out: { admiral: string; lastAt: number }[] = [];
    // [admiral, t] の降順に辿り、提督ごとにその提督の最初のキーの手前 (= 前の提督の最新) へ飛ぶ
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const r = index.openKeyCursor(null, "prev");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const cursor = r.result;
      if (!cursor) return resolve();
      const [admiral, t] = cursor.key as [string, number];
      out.push({ admiral, lastAt: t });
      cursor.continue([admiral, -Infinity]);
    };
    await promise;
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }
}
