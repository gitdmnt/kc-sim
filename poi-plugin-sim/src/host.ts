/**
 * UI コアが動く環境 (poi プラグイン / bun の開発サーバ) ごとに違う部分。
 * エントリ (src/poi/index.tsx, dev/main.tsx) が最初に `setHost` で設定する。
 */
export interface Host {
  /** シミュレーション・推定用の Worker を作る */
  createSimWorker(): Worker;
  /** 静的マップバンドルの既定の置き場 (設定の URL が空のとき)。空文字なら使わない */
  bundleBase: string;
}

let current: Host | undefined;

export const setHost = (h: Host) => {
  current = h;
};

export const getHost = (): Host => {
  if (!current) throw new Error("host が未設定です (エントリで setHost を呼んでください)");
  return current;
};
