import React, { useMemo, useState } from "react";
import { isWebView } from "@shared/embed/protocol";
import type { PoiState, WebView } from "@shared/embed/protocol";
import { FEATURES, useViewNav } from "@web/app/nav";
import { buildCatalog } from "@web/fleet/catalog";
import { AppChrome, ToastProvider } from "@web/ui";
import { resourcesFromPoi } from "../resources";
import { usePluginSettings } from "../settings";
import { LogTab } from "./log/LogTab";
import { ResourcesTab } from "./resources/ResourcesTab";
import { UploadSettings } from "./UploadSettings";
import { WebFrame } from "./WebFrame";

// macOS のプラグインウィンドウはタイトルバーが無く、左上の信号ボタン (閉じる/最小化/拡大) が上の行にかかる。
// AppChrome は上の行をその右から始め、poi の上端 23px の drag 帯の上でもタブだけ no-drag にしてクリックを通す
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

/**
 * プラグインのビュー。枠 (左のバーで シミュ / 任務 / 資源 / 設定、上の行でその中の画面) は Web UI と同じ AppChrome で、
 * ここが描く唯一の枠。Web UI の画面 (出撃・海域・敵艦・計算設定・任務・設定) はサーバの Web UI を iframe で開いて
 * `view` で選び (WebFrame、Web UI は枠を描かない)、観測ログ・送信設定・資源はキャプチャと同じ場所 (このプラグインの
 * IndexedDB / localStorage) にあるのでここで描く。資源の値は Web UI には渡さない。
 */
export const PluginPanel = ({ poiState }: { poiState: PoiState }) => {
  const nav = useViewNav(FEATURES);
  const { view } = nav;
  const { serverUrl } = usePluginSettings();
  // 観測ログの艦名用。master data は poi 側で不変なので const の参照が変わらない限り作り直さない
  const catalog = useMemo(() => buildCatalog(poiState), [poiState.const]);
  // iframe は最後に選んだ Web UI の画面のまま (プラグインの画面を出している間は隠すだけ)
  const [webView, setWebView] = useState<WebView>(isWebView(view) ? view : "sortie");
  if (isWebView(view) && view !== webView) setWebView(view);

  return (
    // .kcsim は CSS のスコープ (postcss-kcsim-scope.mjs が `.kcsim .foo` にする) なので、ユーティリティはその内側に置く
    <div className="kcsim">
      <div className="flex h-screen flex-col">
        <ToastProvider>
          <AppChrome
            features={FEATURES}
            view={view}
            onView={nav.go}
            onFeature={nav.goFeature}
            windowButtons={IS_MAC}
            end={`v${__APP_VERSION__}`}
          >
            {/* iframe は隠すだけで外さない (Web UI の状態と読み込みを保つ) */}
            <div className={isWebView(view) ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <WebFrame serverUrl={serverUrl} poiState={poiState} view={webView} onView={nav.go} onOpenSettings={() => nav.go("upload")} />
            </div>
            {!isWebView(view) && (
              <main className="min-h-0 flex-1 overflow-auto p-4">
                {view === "log" ? (
                  <LogTab catalog={catalog} />
                ) : view === "upload" ? (
                  <UploadSettings />
                ) : (
                  <ResourcesTab currentAdmiral={resourcesFromPoi(poiState).admiral} view={view} />
                )}
              </main>
            )}
          </AppChrome>
        </ToastProvider>
      </div>
    </div>
  );
};
