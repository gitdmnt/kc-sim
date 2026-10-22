import { useSyncExternalStore } from "react";
import { STORAGE_PREFIX } from "../fleet";

export interface Settings {
  apiBase: string;
  /** 静的マップバンドルの場所 (URL)。空ならプラグイン同梱の maps/ */
  bundleBase: string;
  /** poi の state の代わりに同梱サンプルを使う */
  useSampleState: boolean;
  /** シミュレーションでサーバの推定値 (estimator:server の best) を使う */
  useEstimates: boolean;
  /** 観測データを自動でデータ API (D1) に送信する (メインウィンドウの capture/autoUpload が読む) */
  autoUpload: boolean;
  /** 敵編成: 自分たちの観測 (poi-observed) をこの遭遇数以上で KCNav より優先する (API の minObserved) */
  minObserved: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: "http://127.0.0.1:8787",
  bundleBase: "",
  useSampleState: false,
  useEstimates: false,
  autoUpload: true,
  minObserved: 30,
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

let current = read();

export const getSettings = () => current;

const readStored = (): Partial<Settings> => {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

export const updateSettings = (patch: Partial<Settings>) => {
  // メインウィンドウとプラグインウィンドウは localStorage を共有する。古いメモリ上の値で上書きしないよう、保存値を土台にする。
  current = { ...current, ...readStored(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 保存できなくてもメモリ上では反映する
  }
  listeners.forEach((l) => l());
};

export const resetSettings = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  current = { ...DEFAULT_SETTINGS };
  listeners.forEach((l) => l());
};

export const subscribeSettings = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

// もう一方のウィンドウでの変更 (storage イベントは書き込んだ側以外にだけ届く) を取り込む。
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== KEY) return;
    current = read();
    listeners.forEach((l) => l());
  });
}

export const useSettings = (): Settings =>
  useSyncExternalStore(subscribeSettings, getSettings, getSettings);
