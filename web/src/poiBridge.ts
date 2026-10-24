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
  HOST_NAV_VERSION,
  isAllowedParentOrigin,
  parsePluginMessage,
  readEnvelope,
} from "@shared/embed/protocol";
import type { PoiState, WebMessage, WebView } from "@shared/embed/protocol";
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
  /** プラグインのプロトコルの版 (最後に受け取ったメッセージの。status が unsupported のときは対応外の版) */
  pluginVersion?: number;
  /** プラグインが画面の枠 (左のバー・上のタブ) を描き、`view` で Web UI の画面を選ぶ (v3 以降)。Web UI は枠を描かない */
  hostNav: boolean;
  /** プラグインが選んだ画面 (届くたびに新しいオブジェクト) */
  hostView?: { view: WebView };
}

/** 埋め込まれてから state が届くまで待つ時間 */
const SILENT_AFTER_MS = 5_000;

let current: PoiConnection = { status: "standalone", state: null, hostNav: false };
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
    set({ ...current, status: "unsupported", pluginVersion: env.v, hostNav: false });
    return;
  }
  const msg = parsePluginMessage(e.data);
  if (!msg) return;
  if (msg.type === "presets") {
    importPresets(msg.json);
    return;
  }
  const host = { pluginVersion: msg.v, hostNav: msg.v >= HOST_NAV_VERSION };
  if (msg.type === "view") {
    set({ ...current, ...host, hostView: { view: msg.view } });
    return;
  }
  // const は変わったときだけ届く。前回の参照を使い続けるとカタログを作り直さずに済む
  const master = msg.const ?? current.state?.const;
  if (master === undefined) return;
  set({ ...current, ...host, status: "connected", state: { info: msg.info, const: master, combinedFlag: msg.combinedFlag, quests: msg.quests } });
};

/** Web UI が自分で画面を移った (海域 →「戦闘シミュ」など) ことを、枠を描いているプラグインに知らせる */
export const reportView = (view: WebView) => {
  if (current.hostNav) postToParent({ src: EMBED_SOURCE, v: EMBED_VERSION, type: "view", view });
};

/** エントリ (main.tsx) から 1 回だけ呼ぶ。 */
export const startPoiBridge = async (): Promise<void> => {
  if (window.parent === window) {
    if (import.meta.env.DEV) {
      // 開発サーバ: poi の代わりに myState.json / サンプル (vite.config.ts の dev-state)
      const state = (await (await fetch("/__dev/state.json")).json()) as PoiState;
      set({ ...current, status: "standalone", state });
    }
    return;
  }
  set({ ...current, status: "waiting", state: null });
  window.addEventListener("message", onMessage);
  postToParent({ src: EMBED_SOURCE, v: EMBED_VERSION, type: "ready" });
  setTimeout(() => {
    if (current.status === "waiting") set({ ...current, status: "silent", state: null });
  }, SILENT_AFTER_MS);
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const usePoiConnection = (): PoiConnection => useSyncExternalStore(subscribe, () => current, () => current);
