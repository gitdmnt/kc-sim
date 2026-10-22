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
  /** 観測データを自動でサーバに送信する */
  autoUpload: boolean;
}

export const DEFAULT_SERVER_URL = "https://kc-sim.lumpoler.workers.dev/";

const DEFAULTS: PluginSettings = { serverUrl: DEFAULT_SERVER_URL, autoUpload: true };

const KEY = `${STORAGE_PREFIX}plugin`;
/** UI がプラグインにあった頃の設定 (apiBase, autoUpload, …)。autoUpload だけ引き継ぐ */
const LEGACY_KEY = `${STORAGE_PREFIX}settings`;
/** UI が Web に移って使われなくなったキー (データキャッシュ・選択中のタブ/プリセット) */
const OBSOLETE_PREFIXES = [`${STORAGE_PREFIX}cache:`, `${STORAGE_PREFIX}tab`, `${STORAGE_PREFIX}selectedPreset`, LEGACY_KEY];

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
});

/**
 * 初回: 旧設定の autoUpload (送信をオフにしていた人はオフのまま) を引き継いで保存し、使われなくなったキーを消す。
 * 旧 apiBase は引き継がない (127.0.0.1 や廃止した kc-sim-data の URL を指していることがある)。
 */
const migrate = (s: Storage) => {
  if (s.getItem(KEY) !== null) return;
  const legacy = parse(s.getItem(LEGACY_KEY));
  const initial = { ...DEFAULTS, ...(typeof legacy.autoUpload === "boolean" ? { autoUpload: legacy.autoUpload } : {}) };
  s.setItem(KEY, JSON.stringify(initial));
  const obsolete: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null && OBSOLETE_PREFIXES.some((p) => k === p || (p.endsWith(":") && k.startsWith(p)))) obsolete.push(k);
  }
  obsolete.forEach((k) => s.removeItem(k));
};

const read = (): PluginSettings => {
  const s = storage();
  if (!s) return { ...DEFAULTS };
  try {
    migrate(s);
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
