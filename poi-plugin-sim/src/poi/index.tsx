/**
 * poi プラグインとしてのエントリ (vite build の lib エントリ。poi が `views/index.js` として読む)。
 * redux の購読と CSS の注入だけをここに置き、ビューは PluginPanel に任せる。
 */
import React from "react";
import { connect } from "react-redux";
import type { PoiState } from "@shared/embed/protocol";
import styles from "../../assets/styles.css?inline";
import { PluginPanel } from "../panel/PluginPanel";

const PoiApp = ({ info, const: master }: PoiState) => {
  const poiState = React.useMemo(() => ({ info, const: master }), [info, master]);
  return (
    // <style> はこのコンポーネントがマウントされている間だけ存在する (アンマウントで poi 本体に残らない)
    <>
      <style>{styles}</style>
      <PluginPanel poiState={poiState} />
    </>
  );
};

// poi の state 全体ではなく info / const だけ購読して再描画を減らす
// (mapState の戻り値は浅く比較されるので、スライスを props にする)
const Connected = connect((state: Partial<PoiState> | undefined): PoiState => ({
  info: state?.info,
  const: state?.const,
}))(PoiApp);

// poi はこのコンポーネントをプラグインパネルに描画する
export class reactClass extends React.Component {
  render() {
    return <Connected />;
  }
}

export { startCapture, stopCapture, getCaptureDb } from "../capture";
