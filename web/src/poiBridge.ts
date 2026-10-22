/**
 * poi プラグインとの橋渡し (プロトコルは shared/embed/protocol.ts)。
 * プラグインがこのページを iframe に埋め込み、poi の state (info/const の必要部分) を postMessage で送ってくる。
 * 親フレームが無い (普通のブラウザで開いた) ときは poi のデータ無しで動く。
 */
import { useSyncExternalStore } from "react";
import {
  EMBED_MIN_VERSION,
  EMBED_SOURCE,
  EMBED_VERSION,
  isAllowedParentOrigin,
  parsePluginMessage,
  readEnvelope,
} from "@shared/embed/protocol";
import type { PoiState, WebMessage } from "@shared/embed/protocol";
import { getPresetStore, notifyPresetsChanged } from "./app/fleet/presets";

export type PoiStatus =
  /** 親フレームが無い。開発サーバでは state に開発用データ (/__dev/state.json) が入る */
  | "standalone"
  /** プラグインに埋め込まれていて、最初の state を待っている */
  | "waiting"
  | "connected"
  /** 埋め込まれているが state が届かない (古いプラグイン、別のページへの埋め込み) */
  | "silent"
  /** プラグインのプロトコルが対応外 */
  | "unsupported";

export interface PoiConnection {
  status: PoiStatus;
  state: PoiState | null;
  /** status が unsupported のときのプラグイン側の版 */
  pluginVersion?: number;
}

/** 埋め込まれてから state が届くまで待つ時間 */
const SILENT_AFTER_MS = 5_000;

let current: PoiConnection = { status: "standalone", state: null };
const listeners = new Set<() => void>();

const set = (next: PoiConnection) => {
  current = next;
  listeners.forEach((l) => l());
};

const postToParent = (m: WebMessage) => {
  // 親は poi の file:// ウィンドウで、オリジンでは宛先を指定できない。送るのは合図と件数だけ
  window.parent.postMessage(m, "*");
};

const importPresets = (json: string) => {
  let total = 0;
  let imported = 0;
  try {
    const data = JSON.parse(json);
    total = Array.isArray(data?.presets) ? data.presets.length : 1;
    imported = getPresetStore().importJSON(json, { skipExisting: true }).length;
  } catch (e) {
    console.error("[kcsim] presets from the poi plugin could not be imported", e);
    return;
  }
  if (imported > 0) notifyPresetsChanged();
  postToParent({ src: EMBED_SOURCE, v: EMBED_VERSION, type: "presets-ack", imported, skipped: total - imported });
};

const onMessage = (e: MessageEvent) => {
  if (e.source !== window.parent || !isAllowedParentOrigin(e.origin, import.meta.env.DEV)) return;
  const env = readEnvelope(e.data);
  if (!env) return;
  if (env.v < EMBED_MIN_VERSION || env.v > EMBED_VERSION) {
    set({ status: "unsupported", state: current.state, pluginVersion: env.v });
    return;
  }
  const msg = parsePluginMessage(e.data);
  if (!msg) return;
  if (msg.type === "presets") {
    importPresets(msg.json);
    return;
  }
  // const は変わったときだけ届く。前回の参照を使い続けるとカタログを作り直さずに済む
  const master = msg.const ?? current.state?.const;
  if (master === undefined) return;
  set({ status: "connected", state: { info: msg.info, const: master } });
};

/** エントリ (main.tsx) から 1 回だけ呼ぶ。 */
export const startPoiBridge = async (): Promise<void> => {
  if (window.parent === window) {
    if (import.meta.env.DEV) {
      // 開発サーバ: poi の代わりに myState.json / サンプル (vite.config.ts の dev-state)
      const state = (await (await fetch("/__dev/state.json")).json()) as PoiState;
      set({ status: "standalone", state });
    }
    return;
  }
  set({ status: "waiting", state: null });
  window.addEventListener("message", onMessage);
  postToParent({ src: EMBED_SOURCE, v: EMBED_VERSION, type: "ready" });
  setTimeout(() => {
    if (current.status === "waiting") set({ status: "silent", state: null });
  }, SILENT_AFTER_MS);
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const usePoiConnection = (): PoiConnection => useSyncExternalStore(subscribe, () => current, () => current);
