import { useCallback, useState } from "react";
import type { NightPolicy } from "@sim-core";
import { STORAGE_PREFIX } from "../../fleet";

export type SimMode = "sortie" | "battle";
/** 単一マス戦闘で選べる戦闘種別 (エンジンは空襲なども持つ) */
export type OfferedKind = "day" | "dayNight" | "nightOnly";

/** 作業台の選択と条件 (localStorage)。分岐・フラグ・ゲージなど海域ごとの設定は保存しない。 */
export interface WorkspacePrefs {
  /** 保存形式の版。既定値を変えたときの移行の判別に使う */
  version: number;
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

/** 2: 実行回数の既定が 100,000 から 10,000 になった */
const PREFS_VERSION = 2;

export const DEFAULT_PREFS: WorkspacePrefs = {
  version: PREFS_VERSION,
  map: "1-5",
  difficulty: null,
  mode: "sortie",
  node: null,
  auto: true,
  count: 10_000,
  seed: 12345,
  night: "bossOnly",
  onHeavy: true,
  allowDamecon: true,
  onModerate: false,
  applyFit: true,
  battleKind: "day",
};

const KEY = `${STORAGE_PREFIX}workspace`;

export const loadPrefs = (): WorkspacePrefs => {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? JSON.parse(raw) : {};
    // 旧い既定 (100,000) のまま保存されていた回数だけ新しい既定にする。版つきで保存したあとの選択は保つ
    if (stored.version === undefined && stored.count === 100_000) delete stored.count;
    return { ...DEFAULT_PREFS, ...stored, version: PREFS_VERSION };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const usePrefs = () => {
  const [prefs, setPrefs] = useState(loadPrefs);
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
