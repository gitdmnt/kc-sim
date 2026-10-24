"use strict";

export const windowMode = true;

export { reactClass } from "./views";
// poi が state.ext[パッケージ名]._ に置く reducer (任務タブ用の「全て」の任務一覧、src/quests/reducer.ts)
export { reducer } from "./views";
import { startCapture, stopCapture } from "./views";

// 戦闘観測はプラグインウィンドウを開かなくても動くよう、ロード時に開始する。
export function pluginDidLoad() {
  try {
    startCapture();
  } catch (e) {
    console.error("[kcsim] failed to start capture", e);
  }
}

export function pluginWillUnload() {
  stopCapture();
}
