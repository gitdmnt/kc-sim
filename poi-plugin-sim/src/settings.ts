/**
 * プラグインの設定: Web UI と送信先のサーバ、自動送信。メインウィンドウ (capture/autoUpload) とプラグインのビューが読む。
 * Web UI 側の設定 (推定値・敵編成の出典など) は Web UI のオリジンの localStorage にあり、ここには無い。
 */
import { useSyncExternalStore } from "react";
import { serverOrigin } from "@shared/embed/protocol";

/** localStorage のキーの接頭辞。送信の登録情報・状態 (capture/) もこの下にある */
export const STORAGE_PREFIX = "kcsim:";

export interface PluginSettings {
  /** Web UI を開き、観測を送るサーバ (server/ の Worker)。https、または手元の http のみ */
  serverUrl: string;
  /** 観測データを自動でサーバに送信する (新規インストールではオフ) */
  autoUpload: boolean;
  /** 送信設定の「送信される内容」のお知らせを閉じた (自動送信がオフの間だけ出す) */
  uploadNoticeClosed: boolean;
}

export const DEFAULT_SERVER_URL = "https://kc-sim.udama.net/";

const DEFAULTS: PluginSettings = { serverUrl: DEFAULT_SERVER_URL, autoUpload: false, uploadNoticeClosed: false };

const KEY = `${STORAGE_PREFIX}plugin`;
/** UI がプラグインにあった頃の設定 (apiBase, autoUpload, …) */
const LEGACY_KEY = `${STORAGE_PREFIX}settings`;
/** UI が Web に移って使われなくなったキー。`:` で終わるものは接頭辞 (データキャッシュ)、他は完全一致 */
const OBSOLETE_KEYS = [
  `${STORAGE_PREFIX}cache:`,
  `${STORAGE_PREFIX}tab`,
  `${STORAGE_PREFIX}map`,
  `${STORAGE_PREFIX}selectedPreset`,
  LEGACY_KEY,
];
/** 旧プラグインの既定の送信先 (手元の wrangler dev)。旧設定に apiBase が無ければこれだった */
const LEGACY_DEFAULT_API = "http://127.0.0.1:8787";
/** 改名前の本番 Worker。同じ D1 を使う今の本番 (DEFAULT_SERVER_URL) に引き継ぐ */
const LEGACY_PROD_ORIGIN = "https://kc-sim-data.lumpoler.workers.dev";
/** capture/uploadClient.ts の CREDENTIALS_KEY (あちらがこのファイルを読むので import すると循環する) */
const CREDENTIALS_KEY = `${STORAGE_PREFIX}auth`;

const listeners = new Set<() => void>();

const parse = (raw: string | null): Record<string, unknown> => {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

const storage = (): Storage | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
};

const fromStored = (v: Record<string, unknown>): PluginSettings => ({
  serverUrl: typeof v.serverUrl === "string" ? v.serverUrl : DEFAULTS.serverUrl,
  autoUpload: typeof v.autoUpload === "boolean" ? v.autoUpload : DEFAULTS.autoUpload,
  uploadNoticeClosed: v.uploadNoticeClosed === true,
});

/**
 * 初回 (`kcsim:plugin` が無いとき) の設定を決め、使われなくなったキーを消す。
 *
 * - 新規インストール (`kcsim:` のキーが 1 つも無い): 既定値 (自動送信オフ、本番サーバ)。
 * - 旧版からの更新で、旧送信先が改名前の本番 (kc-sim-data): 旧 autoUpload を引き継ぎ、登録情報の送信先を新しい本番の
 *   オリジンに書き換える (同じ D1 なので clientId とトークンはそのまま使える)。
 * - それ以外の更新 (旧既定の 127.0.0.1 など、手元にしか送っていなかった): 黙って本番へ送り始めないよう自動送信をオフにする。
 */
export const migrateLegacySettings = (s: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">) => {
  if (s.getItem(KEY) !== null) return;
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null && k.startsWith(STORAGE_PREFIX)) keys.push(k);
  }
  let initial = DEFAULTS;
  if (keys.length > 0) {
    const legacy = parse(s.getItem(LEGACY_KEY));
    const oldOrigin = serverOrigin(typeof legacy.apiBase === "string" ? legacy.apiBase : LEGACY_DEFAULT_API);
    const newOrigin = serverOrigin(DEFAULT_SERVER_URL);
    // 旧版で本番 (改名前か改名後) を送信先にしていた人は、本番への送信に同意済み
    if (oldOrigin === LEGACY_PROD_ORIGIN || oldOrigin === newOrigin) {
      initial = { ...DEFAULTS, autoUpload: typeof legacy.autoUpload === "boolean" ? legacy.autoUpload : true };
      const creds = parse(s.getItem(CREDENTIALS_KEY));
      if (typeof creds.apiBase === "string" && serverOrigin(creds.apiBase) === LEGACY_PROD_ORIGIN && newOrigin) {
        s.setItem(CREDENTIALS_KEY, JSON.stringify({ ...creds, apiBase: newOrigin }));
      }
    } else {
      initial = { ...DEFAULTS, autoUpload: false };
    }
  }
  s.setItem(KEY, JSON.stringify(initial));
  for (const k of keys) {
    if (OBSOLETE_KEYS.some((p) => k === p || (p.endsWith(":") && k.startsWith(p)))) s.removeItem(k);
  }
};

const read = (): PluginSettings => {
  const s = storage();
  if (!s) return { ...DEFAULTS };
  try {
    migrateLegacySettings(s);
  } catch {
    // 保存できなくても既定値で動く
  }
  return fromStored(parse(s.getItem(KEY)));
};

let current = read();

export const getPluginSettings = () => current;

export const updatePluginSettings = (patch: Partial<PluginSettings>) => {
  // メインウィンドウとプラグインのビューは localStorage を共有する。古いメモリ上の値で上書きしないよう、保存値を土台にする。
  current = { ...current, ...fromStored(parse(storage()?.getItem(KEY) ?? null)), ...patch };
  try {
    storage()?.setItem(KEY, JSON.stringify(current));
  } catch {
    // 保存できなくてもメモリ上では反映する
  }
  listeners.forEach((l) => l());
};

export const subscribePluginSettings = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** capture/autoUpload が読む形: 送信先はサーバ URL のオリジン (許可されない URL なら空 = 送らない)。 */
export const getUploadSettings = (): { autoUpload: boolean; apiBase: string } => ({
  autoUpload: current.autoUpload,
  apiBase: serverOrigin(current.serverUrl) ?? "",
});

// もう一方のウィンドウでの変更 (storage イベントは書き込んだ側以外にだけ届く) を取り込む。
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== KEY) return;
    current = read();
    listeners.forEach((l) => l());
  });
}

export const usePluginSettings = (): PluginSettings =>
  useSyncExternalStore(subscribePluginSettings, getPluginSettings, getPluginSettings);
