import React, { useCallback, useEffect, useRef, useState } from "react";
import { EMBED_VERSION, serverOrigin } from "@shared/embed/protocol";
import type { PoiState, WebView } from "@shared/embed/protocol";
import { PresetStore } from "@web/fleet/presetStore";
import { Button, EmptyState } from "@web/ui";
import { STORAGE_PREFIX } from "../settings";
import { EmbedBridge } from "./bridge";

/** poi の state の変化をまとめて送る間隔 */
const COALESCE_MS = 250;

/**
 * 外部のページ (サーバの Web UI) を埋め込んでよいウィンドウか。poi のメインウィンドウは nodeIntegration と
 * nodeIntegrationInSubFrames が有効で、そこに置いた iframe にも Node.js が入りうる (タブ表示ではビューがメインウィンドウに
 * 描かれる)。ウィンドウモードのプラグインウィンドウは nodeIntegration: false で、poi が `window.isWindowMode = true` を
 * 立てる。その印があり、かつ Node.js が見えないウィンドウだけを許し、分からないウィンドウは拒む。
 */
const canEmbedIn = (w: Window): boolean => {
  const g = w as Window & { isWindowMode?: unknown; require?: unknown; process?: { versions?: { node?: unknown } } };
  const hasNode = typeof g.require === "function" || typeof g.process?.versions?.node === "string";
  return g.isWindowMode === true && !hasNode;
};

/** 旧 UI (プラグイン内) のプリセット。無ければ null */
const legacyPresetsJson = (): string | null => {
  const store = new PresetStore();
  return store.list().length > 0 ? store.exportJSON() : null;
};

interface Props {
  serverUrl: string;
  poiState: PoiState;
  /** iframe に出す画面 (プラグインの枠で選んだもの) */
  view: WebView;
  /** Web UI が自分で画面を移った */
  onView: (v: WebView) => void;
  onOpenSettings: () => void;
}

/**
 * Web UI を iframe で開き、poi の state と出す画面を postMessage で渡す。送り先は iframe のオリジンに固定し、
 * 受け取るのはその iframe から・そのオリジンのメッセージだけ。
 */
export const WebFrame = ({ serverUrl, poiState, view, onView, onOpenSettings }: Props) => {
  const origin = serverOrigin(serverUrl);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<EmbedBridge | null>(null);
  const [host, setHost] = useState<Window | null>(null);
  const [webVersion, setWebVersion] = useState<number | null>(null);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  // ウィンドウモードでは DOM はプラグインウィンドウ (別の window) にあり、message もそちらに届く
  const hostRef = useCallback((el: HTMLDivElement | null) => setHost(el?.ownerDocument.defaultView ?? null), []);
  const embeddable = host !== null && origin !== null && canEmbedIn(host);

  useEffect(() => {
    if (!embeddable || !host || !origin) return;
    const presetsKey = `${STORAGE_PREFIX}presetsMigrated:${origin}`;
    const bridge = new EmbedBridge({
      post: (m) => frameRef.current?.contentWindow?.postMessage(m, origin),
      presetsJson: legacyPresetsJson,
      presetsDone: () => localStorage.getItem(presetsKey) !== null,
      markPresetsDone: () => localStorage.setItem(presetsKey, String(Date.now())),
      onWebVersion: setWebVersion,
      onView: (v) => onViewRef.current(v),
    });
    bridgeRef.current = bridge;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow || e.origin !== origin) return;
      bridge.onMessage(e.data);
    };
    host.addEventListener("message", onMessage);
    return () => {
      host.removeEventListener("message", onMessage);
      bridgeRef.current = null;
    };
  }, [embeddable, host, origin]);

  // 作り直した bridge にも今の画面を渡す (ready 前は bridge が覚えておく)
  useEffect(() => bridgeRef.current?.setView(view), [view, embeddable, host, origin]);

  // 最新の state を間引いて渡す (ready 前は bridge が覚えておく)
  const latest = useRef(poiState);
  latest.current = poiState;
  useEffect(() => {
    const t = setTimeout(() => bridgeRef.current?.update(latest.current), bridgeRef.current ? COALESCE_MS : 0);
    return () => clearTimeout(t);
  }, [poiState, embeddable, host, origin]);

  return (
    <div ref={hostRef} className="flex min-h-0 flex-1 flex-col">
      {origin === null ? (
        <EmptyState className="py-16" title="サーバ URL が正しくありません" action={<Button onClick={onOpenSettings}>送信設定を開く</Button>} />
      ) : host !== null && !canEmbedIn(host) ? (
        <EmptyState className="py-16" title="ウィンドウモードが必要です" />
      ) : (
        <>
          {webVersion !== null && webVersion > EMBED_VERSION && (
            <div
              className="bg-warn-600/15 px-4 py-1 text-xs text-warn-400"
              title={`Web UI v${webVersion} / プラグイン v${EMBED_VERSION}`}
            >
              プラグインの更新があります
            </div>
          )}
          {embeddable && (
            <iframe
              key={origin}
              ref={frameRef}
              src={serverUrl.trim()}
              title="kc-sim"
              className="min-h-0 w-full flex-1 border-0"
              sandbox="allow-scripts allow-same-origin"
              allow="clipboard-write"
              referrerPolicy="no-referrer"
            />
          )}
        </>
      )}
    </div>
  );
};
