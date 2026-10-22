import React, { useMemo } from "react";
import sampleState from "../dev/sampleState.json";
import { AppProvider } from "./app/context";
import { Shell } from "./app/Shell";
import { useSettings } from "./app/settings";
import { buildCatalog } from "./fleet/catalog";
import { ToastProvider } from "./ui";

/** poi の redux state のうち UI が読む部分 (`info` = 母港、`const` = マスター) */
export interface PoiState {
  info: unknown;
  const: unknown;
}

/**
 * UI コアのルート。poi にも開発サーバにも依存しない (host は src/host.ts で注入する)。
 * スタイルは .kcsim 配下に閉じてあり、CSS の読み込みはエントリ側が行う。
 */
export const KcsimApp = ({ poiState }: { poiState: PoiState }) => {
  const { useSampleState } = useSettings();
  const state = useMemo(() => (useSampleState ? sampleState : poiState), [useSampleState, poiState]);
  // master data は poi 側で不変なので const の参照が変わらない限り作り直さない
  const catalog = useMemo(() => buildCatalog(state), [state.const]);
  const value = useMemo(() => ({ state, catalog }), [state, catalog]);

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
