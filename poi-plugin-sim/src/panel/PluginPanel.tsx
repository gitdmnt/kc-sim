import React, { useMemo, useState } from "react";
import type { PoiState } from "@shared/embed/protocol";
import { buildCatalog } from "@web/fleet/catalog";
import { Tabs, ToastProvider } from "@web/ui";
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

// macOS のプラグインウィンドウはタイトルバーが無く、左上の信号ボタン (閉じる/最小化/拡大) がタブに重なるので避ける
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

/**
 * プラグインのビュー。シミュレータ本体はサーバの Web UI を iframe で開き (WebFrame)、観測ログと送信設定は
 * キャプチャと同じ場所 (このプラグインの IndexedDB / localStorage) にあるのでここで描く。
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
          <Tabs tabs={TABS} value={tab} onChange={setTab} className={IS_MAC ? "shrink-0 pl-20 pr-3" : "shrink-0 px-3"} />
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
