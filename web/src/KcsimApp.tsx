import React, { useMemo } from "react";
import sampleState from "./sampleState.json";
import { AppProvider } from "./app/context";
import { Shell } from "./app/Shell";
import { useSettings } from "./app/settings";
import { buildCatalog } from "./fleet/catalog";
import { usePoiConnection } from "./poiBridge";
import { ToastProvider } from "./ui";

/**
 * UI のルート。poi の state は poi プラグインから postMessage で届く (src/poiBridge.ts)。
 * 普通のブラウザで開いたときは poi のデータ無し (設定で同梱サンプルに切り替えられる)。
 */
export const KcsimApp = () => {
  const { useSampleState } = useSettings();
  const poi = usePoiConnection();
  const state = useMemo(() => (useSampleState ? sampleState : poi.state), [useSampleState, poi.state]);
  // master data は poi 側で不変なので const の参照が変わらない限り作り直さない
  const catalog = useMemo(() => buildCatalog(state), [state?.const]);
  const value = useMemo(() => ({ state, catalog, poi }), [state, catalog, poi]);

  return (
    <div className="kcsim">
      <AppProvider value={value}>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </AppProvider>
    </div>
  );
};
