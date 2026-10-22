/**
 * 直近の推定結果。メモリ (分布つき) と localStorage (分布なし) に持ち、推定タブとシミュレーションで共有する。
 */
import { useSyncExternalStore } from "react";
import { getSettings } from "../app/settings";
import { STORAGE_PREFIX } from "../fleet/presetStore";
import type { EstimateAllResult } from "./estimate";
import type { EstimateResult } from "./types";

/** シミュレーションと送信で推定値を使う最小観測数 */
export const ESTIMATE_MIN_N = 30;

export interface StoredEstimates extends EstimateAllResult {
  /** 推定した時刻 (epoch ms) */
  at: number;
}

const KEY = `${STORAGE_PREFIX}estimates`;
const listeners = new Set<() => void>();

const load = (): StoredEstimates | null => {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return raw ? (JSON.parse(raw) as StoredEstimates) : null;
  } catch {
    return null;
  }
};

let current = load();

export const getEstimates = (): StoredEstimates | null => current;

export const setEstimates = (result: EstimateAllResult | null, at = Date.now()) => {
  current = result && { ...result, at };
  try {
    if (current) {
      // 分布は大きいので保存しない (再推定すると表示される)
      localStorage.setItem(KEY, JSON.stringify({ ...current, results: current.results.map((r) => ({ ...r, density: undefined })) }));
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    // 保存できなくてもメモリ上では使える
  }
  listeners.forEach((l) => l());
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useStoredEstimates = (): StoredEstimates | null => useSyncExternalStore(subscribe, getEstimates, getEstimates);

/** シミュレーションで使われる推定値 (applyEstimates と同じ規則: n ≥ minN のローカル推定は常に優先)。 */
export const usableEstimates = (results: EstimateResult[], minN = ESTIMATE_MIN_N): EstimateResult[] =>
  results.filter((r) => r.n >= minN);

/** 設定「シミュレーションで推定値を使う」が有効なら、使う推定値 (n ≥ 30) と推定時刻。 */
export const estimatesForSimulation = (): { results: EstimateResult[]; at: number } | undefined => {
  const s = getEstimates();
  if (!getSettings().useEstimates || !s) return undefined;
  const results = usableEstimates(s.results);
  return results.length > 0 ? { results, at: s.at } : undefined;
};