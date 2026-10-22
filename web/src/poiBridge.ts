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
import type { HostInfo, PoiState, WebMessage } from "@shared/embed/protocol";
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
  /** プラグインのビュー (観測ログ・送信設定)。プラグインは自分のタブ列を隠し、このページのヘッダに並べる */
  host?: HostInfo;
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
  const store = getPresetStore();
  try {
    const data = JSON.parse(json);
    total = Array.isArray(data?.presets) ? data.presets.length : 1;
    imported = store.importJSON(json, { skipExisting: true }).length;
  } catch (e) {
    console.error("[kcsim] presets from the poi plugin could not be imported", e);
    return;
  }
  if (imported > 0) notifyPresetsChanged();
  // localStorage が使えずメモリに置いただけなら persisted: false。プラグインは移行済みにせず、次回また送る
  postToParent({
    src: EMBED_SOURCE,
    v: EMBED_VERSION,
    type: "presets-ack",
    imported,
    skipped: total - imported,
    persisted: store.persistent,
  });
};

/**
 * プラグインからのメッセージか。poi のウィンドウモードでは、プラグインのコードはメインウィンドウで動き、
 * ビューだけがプラグインウィンドウ (= この iframe の親) に portal で描かれる。postMessage の source は
 * 呼び出したスクリプトのウィンドウなので、メインウィンドウ = 親の opener になる。
 */
const fromPlugin = (source: MessageEventSource | null): boolean => {
  const parent = window.parent;
  if (source === parent) return true;
  try {
    return source !== null && source === parent.opener;
  } catch {
    // 親が別オリジンなら opener は読めない
    return false;
  }
};

const onMessage = (e: MessageEvent) => {
  if (!fromPlugin(e.source) || !isAllowedParentOrigin(e.origin, import.meta.env.DEV)) return;
  const env = readEnvelope(e.data);
  if (!env) return;
  if (env.v < EMBED_MIN_VERSION || env.v > EMBED_VERSION) {
    set({ status: "unsupported", state: current.state, pluginVersion: env.v });
    return;
  }
  const msg = parsePluginMessage(e.data);
  if (!msg) return;
  if (msg.type === "host") {
    set({ ...current, host: { views: msg.views, insetLeft: msg.insetLeft } });
    return;
  }
  if (msg.type === "presets") {
    importPresets(msg.json);
    return;
  }
  // const は変わったときだけ届く。前回の参照を使い続けるとカタログを作り直さずに済む
  const master = msg.const ?? current.state?.const;
  if (master === undefined) return;
  set({ status: "connected", state: { info: msg.info, const: master }, host: current.host });
};

/** ヘッダのプラグインのビューのタブ: プラグインにビューの切り替えを頼む (iframe は隠れる)。 */
export const openHostView = (view: string) => postToParent({ src: EMBED_SOURCE, v: EMBED_VERSION, type: "open-view", view });

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
  postToParent({ src: EMBED_SOURCE, v: EMBED_VERSION, type: "ready", hostViews: true });
  setTimeout(() => {
    if (current.status === "waiting") set({ ...current, status: "silent", state: null });
  }, SILENT_AFTER_MS);
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const usePoiConnection = (): PoiConnection => useSyncExternalStore(subscribe, () => current, () => current);
