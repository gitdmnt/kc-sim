import { useCallback, useState } from "react";
import type { NightPolicy } from "@sim-core";
import { STORAGE_PREFIX } from "../../fleet";

export type SimMode = "sortie" | "battle";
/** 単一マス戦闘で選べる戦闘種別 (エンジンは空襲なども持つ) */
export type OfferedKind = "day" | "dayNight" | "nightOnly";

/** 作業台の選択と条件 (localStorage)。分岐・フラグ・ゲージなど海域ごとの設定は保存しない。 */
export interface WorkspacePrefs {
  map: string;
  /** null は海域の最高難易度 */
  difficulty: number | null;
  mode: SimMode;
  /** 単一マス戦闘のノード (null はボス) */
  node: string | null;
  auto: boolean;
  /** 手動実行の回数 */
  count: number;
  seed: number;
  night: NightPolicy;
  onHeavy: boolean;
  allowDamecon: boolean;
  onModerate: boolean;
  applyFit: boolean;
  battleKind: OfferedKind;
}

export const DEFAULT_PREFS: WorkspacePrefs = {
  map: "1-5",
  difficulty: null,
  mode: "sortie",
  node: null,
  auto: true,
  count: 100_000,
  seed: 12345,
  night: "bossOnly",
  onHeavy: true,
  allowDamecon: true,
  onModerate: false,
  applyFit: true,
  battleKind: "day",
};

const KEY = `${STORAGE_PREFIX}workspace`;

const load = (): WorkspacePrefs => {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_PREFS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const usePrefs = () => {
  const [prefs, setPrefs] = useState(load);
  const patch = useCallback((p: Partial<WorkspacePrefs>) => {
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // 保存できなくてもメモリ上では反映する
      }
      return next;
    });
  }, []);
  return [prefs, patch] as const;
};
