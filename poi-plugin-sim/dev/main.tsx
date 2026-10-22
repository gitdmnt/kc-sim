/**
 * 開発サーバ (dev/server.ts) のブラウザ側エントリ。poi 無しで UI コアを動かす。
 * poi の state は `/state.json` (../myState.json があればそれ、無ければ dev/sampleState.json)。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import * as capture from "../src/capture";
import * as captureFixtures from "../src/capture/fixtures";
import * as fleet from "../src/fleet";
import { setHost } from "../src/host";
import { KcsimApp } from "../src/KcsimApp";
import type { PoiState } from "../src/KcsimApp";
import sampleState from "./sampleState.json";

setHost({
  createSimWorker: () => new Worker("/sim.worker.js", { type: "module" }),
  bundleBase: "/maps",
});

// スクリーンショット等のスクリプトがページ内からデータを流し込むための口
Object.assign(window, { __kcsimDev: { capture, captureFixtures, fleet, sampleState } });

// 変更を検知したら丸ごと再読み込み (CSS も Tailwind のクラス走査ごと作り直すので HMR はしない)
new EventSource("/__reload").addEventListener("reload", () => location.reload());

const poiState = (await (await fetch("/state.json")).json()) as PoiState;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <KcsimApp poiState={poiState} />
  </React.StrictMode>
);
