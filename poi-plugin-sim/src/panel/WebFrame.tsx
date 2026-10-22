import React, { useCallback, useEffect, useRef, useState } from "react";
import { EMBED_VERSION, serverOrigin } from "@shared/embed/protocol";
import type { PoiState } from "@shared/embed/protocol";
import { PresetStore } from "@web/fleet/presetStore";
import { EmptyState } from "@web/ui";
import { STORAGE_PREFIX } from "../settings";
import { EmbedBridge } from "./bridge";

/** poi の state の変化をまとめて送る間隔 */
const COALESCE_MS = 250;

/**
 * Node.js が使えるウィンドウか。poi のメインウィンドウは nodeIntegration と nodeIntegrationInSubFrames が有効で、
 * そこに置いた iframe (= 外部のページ) にも Node.js が入りうる。プラグインをタブ表示にするとビューがメインウィンドウに
 * 描かれるので、その場合は埋め込まない (ウィンドウモードのプラグインウィンドウは nodeIntegration: false)。
 */
const hasNode = (w: Window): boolean => {
  const g = w as Window & { require?: unknown; process?: { versions?: { node?: unknown } } };
  return typeof g.require === "function" || typeof g.process?.versions?.node === "string";
};

/** 旧 UI (プラグイン内) のプリセット。無ければ null */
const legacyPresetsJson = (): string | null => {
  const store = new PresetStore();
  return store.list().length > 0 ? store.exportJSON() : null;
};

/**
 * Web UI を iframe で開き、poi の state を postMessage で渡す。送り先は iframe のオリジンに固定し、
 * 受け取るのはその iframe から・そのオリジンのメッセージだけ。
 */
export const WebFrame = ({ serverUrl, poiState }: { serverUrl: string; poiState: PoiState }) => {
  const origin = serverOrigin(serverUrl);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<EmbedBridge | null>(null);
  const [host, setHost] = useState<Window | null>(null);
  const [webVersion, setWebVersion] = useState<number | null>(null);

  // ウィンドウモードでは DOM はプラグインウィンドウ (別の window) にあり、message もそちらに届く
  const hostRef = useCallback((el: HTMLDivElement | null) => setHost(el?.ownerDocument.defaultView ?? null), []);
  const embeddable = host !== null && origin !== null && !hasNode(host);

  useEffect(() => {
    if (!embeddable || !host || !origin) return;
    const presetsKey = `${STORAGE_PREFIX}presetsMigrated:${origin}`;
    const bridge = new EmbedBridge({
      post: (m) => frameRef.current?.contentWindow?.postMessage(m, origin),
      presetsJson: legacyPresetsJson,
      presetsDone: () => localStorage.getItem(presetsKey) !== null,
      markPresetsDone: () => localStorage.setItem(presetsKey, String(Date.now())),
      onWebVersion: setWebVersion,
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
        <EmptyState className="py-16" title="サーバ URL が正しくありません" description="送信設定タブで https の URL を設定してください。" />
      ) : host !== null && hasNode(host) ? (
        <EmptyState
          className="py-16"
          title="ウィンドウモードで開いてください"
          description="シミュレータは外部のページ (サーバの Web UI) を埋め込みます。poi のタブ表示では埋め込んだページで Node.js が有効になりうるため表示しません。poi の設定 → プラグイン で、このプラグインのウィンドウモードをオンにしてください (観測ログ・送信設定はタブ表示でも使えます)。"
        />
      ) : (
        <>
          {webVersion !== null && webVersion > EMBED_VERSION && (
            <div className="border-b border-warn-600/50 bg-warn-600/10 px-3 py-1 text-xs text-warn-400">
              プラグインの更新があります (Web UI のプロトコル v{webVersion}、プラグイン v{EMBED_VERSION})。
            </div>
          )}
          {embeddable && (
            <iframe
              key={origin}
              ref={frameRef}
              src={serverUrl.trim()}
              title="kc-sim"
              className="min-h-0 w-full flex-1 border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
              allow="clipboard-write"
              referrerPolicy="no-referrer"
            />
          )}
        </>
      )}
    </div>
  );
};
