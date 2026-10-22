/** localStorage 互換の最小インターフェース。テストでは MemoryStorage を使う。 */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** localStorage が使えない環境 (テスト、iframe でストレージが拒否されたとき等) ではメモリにフォールバックする。 */
export const defaultStorage = (): KeyValueStorage => {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // アクセス拒否 (privacy 設定、サードパーティのストレージのブロックなど)
  }
  return new MemoryStorage();
};

/** 再読み込み後も残るストレージか (メモリへのフォールバックでないか)。 */
export const isPersistent = (s: KeyValueStorage): boolean => !(s instanceof MemoryStorage);

/** この名前空間に属するキーを列挙する。 */
export const keysWithPrefix = (s: KeyValueStorage, prefix: string): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null && k.startsWith(prefix)) keys.push(k);
  }
  return keys;
};
