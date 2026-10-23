import React, { useMemo, useState } from "react";
import type { PoiState } from "@shared/embed/protocol";
import { buildCatalog } from "@web/fleet/catalog";
import { Tabs, ToastProvider, cx } from "@web/ui";
import type { TabItem } from "@web/ui";
import { usePluginSettings } from "../settings";
import { LogTab } from "./log/LogTab";
import { L } from "./strings";
import { UploadSettings } from "./UploadSettings";
import { WebFrame } from "./WebFrame";

type PanelTab = "sim" | "log" | "upload";

const TABS: TabItem<PanelTab>[] = [
  { id: "sim", label: L.tabs.sim },
  { id: "log", label: L.tabs.log },
  { id: "upload", label: L.tabs.upload },
];

// macOS のプラグインウィンドウはタイトルバーが無く、左上の信号ボタン (閉じる/最小化/拡大) がタブに重なるので避ける。
// poi は上端 23px に -webkit-app-region: drag の帯を置くので、タブだけ no-drag にしてクリックを通す (空きはドラッグできる)
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);
const NO_DRAG_TABS = "[&>[role=tab]]:[-webkit-app-region:no-drag]";

/**
 * プラグインのビュー。シミュレータ本体はサーバの Web UI を iframe で開き (WebFrame)、観測ログと送信設定は
 * キャプチャと同じ場所 (このプラグインの IndexedDB / localStorage) にあるのでここで描く。
 * ヘッダ (ビューのタブ) はどのビューでも同じこの 1 行だけ。埋め込んだ Web UI はヘッダを描かない。
 */
export const PluginPanel = ({ poiState }: { poiState: PoiState }) => {
  const [tab, setTab] = useState<PanelTab>("sim");
  const { serverUrl } = usePluginSettings();
  // 観測ログの艦名用。master data は poi 側で不変なので const の参照が変わらない限り作り直さない
  const catalog = useMemo(() => buildCatalog(poiState), [poiState.const]);

  return (
    // .kcsim は CSS のスコープ (postcss-kcsim-scope.mjs が `.kcsim .foo` にする) なので、ユーティリティはその内側に置く
    <div className="kcsim">
      <div className="flex h-screen flex-col">
        <ToastProvider>
          <div className={cx("flex shrink-0 items-center border-b border-ink-800", IS_MAC ? "pr-3 pl-20" : "px-3")}>
            <Tabs tabs={TABS} value={tab} onChange={setTab} size="sm" className={cx("min-w-0 flex-1", NO_DRAG_TABS)} />
            <span className="shrink-0 pl-3 text-xs text-ink-500 tabular-nums">v{__APP_VERSION__}</span>
          </div>
          {/* iframe は隠すだけで外さない (Web UI の状態と読み込みを保つ) */}
          <div className={tab === "sim" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <WebFrame serverUrl={serverUrl} poiState={poiState} onOpenSettings={() => setTab("upload")} />
          </div>
          {tab !== "sim" && (
            <main className="min-h-0 flex-1 overflow-auto p-4">
              {tab === "log" ? <LogTab catalog={catalog} /> : <UploadSettings />}
            </main>
          )}
        </ToastProvider>
      </div>
    </div>
  );
};
