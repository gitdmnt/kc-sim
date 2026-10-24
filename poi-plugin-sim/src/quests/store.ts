/**
 * 単発任務の進捗カウンタの保存 (IndexedDB `kcsim-quests`、提督ごとに 1 行)。資源の推移 (resources/store.ts) と同じく
 * 観測ログの DB とは分ける。poi のメインウィンドウ (数える側) とプラグインウィンドウ (表示する側) は同じオリジンなので
 * 同じ DB を見る。書き込みの通知は BroadcastChannel で別ウィンドウにも届ける。
 */
import type { GoalCount } from "@shared/quest/progress";

/** 任務 id -> サブ目標 key -> 数 */
export type QuestCounts = Record<string, Record<string, GoalCount>>;

export interface QuestProgressStore {
  load(admiral: string): Promise<QuestCounts>;
  save(admiral: string, counts: QuestCounts): Promise<void>;
  close?(): Promise<void>;
}

const DB_NAME = "kcsim-quests";
const DB_VERSION = 1;
const PROGRESS = "progress";

const req = <T>(r: IDBRequest<T>): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  return promise;
};

export class QuestProgressDb implements QuestProgressStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private factory: IDBFactory = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const r = this.factory.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(PROGRESS, { keyPath: "admiral" });
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

  async load(admiral: string): Promise<QuestCounts> {
    const db = await this.open();
    const row = await req(db.transaction(PROGRESS).objectStore(PROGRESS).get(admiral));
    return (row as { quests?: QuestCounts } | undefined)?.quests ?? {};
  }

  async save(admiral: string, quests: QuestCounts): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(PROGRESS, "readwrite");
    tx.objectStore(PROGRESS).put({ admiral, quests, updatedAt: Date.now() });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    return promise;
  }
}

/** 別ウィンドウへの「進捗が変わった」通知の名前 (内容は提督 ID) */
export const PROGRESS_CHANNEL = "kcsim-quest-progress";
