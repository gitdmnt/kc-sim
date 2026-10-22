import { useSyncExternalStore } from "react";
import { STORAGE_PREFIX } from "../fleet";

export interface Settings {
  apiBase: string;
  /** 静的マップバンドルの場所 (URL)。空ならプラグイン同梱の maps/ */
  bundleBase: string;
  /** poi の state の代わりに同梱サンプルを使う */
  useSampleState: boolean;
  /** 観測データ送信用の匿名クライアント ID。初回に生成して保存する */
  clientId: string;
  /** シミュレーションで推定タブの推定値 (n ≥ 30) を API の値より優先して使う */
  useEstimates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: "http://127.0.0.1:8787",
  bundleBase: "",
  useSampleState: false,
  clientId: "",
  useEstimates: false,
};

const KEY = `${STORAGE_PREFIX}settings`;
const listeners = new Set<() => void>();

const read = (): Settings => {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

const newClientId = () =>
  `poi-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;

let current = read();

export const getSettings = () => current;

export const updateSettings = (patch: Partial<Settings>) => {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 保存できなくてもメモリ上では反映する
  }
  listeners.forEach((l) => l());
};

if (!current.clientId) updateSettings({ clientId: newClientId() });

export const resetSettings = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  current = { ...DEFAULT_SETTINGS, clientId: current.clientId };
  listeners.forEach((l) => l());
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useSettings = (): Settings =>
  useSyncExternalStore(subscribe, getSettings, getSettings);
