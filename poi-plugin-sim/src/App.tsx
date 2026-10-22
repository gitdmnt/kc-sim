import React, { useMemo } from "react";
import { connect } from "react-redux";
/* @ts-ignore */
import styles from "../assets/styles.css?inline";
import sampleState from "../dev/sampleState.json";
import { AppProvider } from "./app/context";
import { Shell } from "./app/Shell";
import { useSettings } from "./app/settings";
import { buildCatalog } from "./fleet/catalog";
import { ToastProvider } from "./ui";

interface PoiProps {
  poiInfo: any;
  poiConst: any;
}

const App = ({ poiInfo, poiConst }: PoiProps) => {
  const { useSampleState } = useSettings();
  const state = useMemo(
    () => (useSampleState ? sampleState : { info: poiInfo, const: poiConst }),
    [useSampleState, poiInfo, poiConst]
  );
  // master data は poi 側で不変なので const の参照が変わらない限り作り直さない
  const catalog = useMemo(() => buildCatalog(state), [state.const]);
  const value = useMemo(() => ({ state, catalog }), [state, catalog]);

  return (
    // スタイルは .kcsim 配下に閉じ込めてあり、<style> はこのコンポーネントが
    // マウントされている間だけ存在する (アンマウントで poi 本体に残らない)。
    <div className="kcsim">
      <style>{styles}</style>
      <AppProvider value={value}>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </AppProvider>
    </div>
  );
};

// poi の state 全体ではなく info / const だけ購読して再描画を減らす
// (mapState の戻り値は浅く比較されるので、スライスをそのまま props にする)
const ConnectedApp = connect((state: any): PoiProps => ({
  poiInfo: state?.info,
  poiConst: state?.const,
}))(App);

// poi will render this component in the plugin panel
export class reactClass extends React.Component {
  render() {
    return <ConnectedApp />;
  }
}
