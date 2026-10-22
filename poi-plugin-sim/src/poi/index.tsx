/**
 * poi プラグインとしてのエントリ (vite build の lib エントリ。poi が `views/index.js` として読む)。
 * poi 固有の部分 (redux の購読、file:// の Worker・同梱バンドル、CSS の注入) だけをここに置き、
 * UI 本体は KcsimApp に任せる。
 */
import React from "react";
import { connect } from "react-redux";
import styles from "../../assets/styles.css?inline";
import { setHost } from "../host";
import { KcsimApp } from "../KcsimApp";
import type { PoiState } from "../KcsimApp";

/** バンドル (views/index.js) の置き場所からの相対パスを file:// URL にする */
const fileUrl = (rel: string): string => {
  const dir = (typeof __dirname === "string" ? __dirname : "").replace(/\\/g, "/");
  if (!dir) throw new Error("プラグインの場所を特定できません (__dirname が未定義)");
  return encodeURI(`file://${dir.startsWith("/") ? "" : "/"}${dir}/${rel}`);
};

setHost({
  // poi のプラグインウィンドウは CSP が `script-src 'self' file://* 'unsafe-inline'` で、blob:/data: の
  // Worker も、ページ内の WebAssembly コンパイル (unsafe-eval 無し) も禁止されている。file:// の Worker
  // なら許可される (実機の poi 12.0.1 で確認)。ファイルは vite.config.ts の emit-sim-worker が出力する。
  createSimWorker: () => new Worker(fileUrl("sim.worker.js")),
  // API に繋がらないときの代替。ビルド時に server/dist/maps を同梱する
  bundleBase: typeof __dirname === "string" ? fileUrl("../maps") : "",
});

const PoiApp = ({ info, const: master }: PoiState) => {
  const poiState = React.useMemo(() => ({ info, const: master }), [info, master]);
  return (
    // <style> はこのコンポーネントがマウントされている間だけ存在する (アンマウントで poi 本体に残らない)
    <>
      <style>{styles}</style>
      <KcsimApp poiState={poiState} />
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
