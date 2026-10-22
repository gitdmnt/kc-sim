/**
 * プラグインのビューを poi 無しで動かす開発用ページ (`bun run dev`、http://localhost:5174)。
 * poi の state は Web UI の同梱サンプル。iframe の Web UI は `?server=` (既定 http://localhost:5173/ = web の `bun run dev`)。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { importFromPoi } from "@shared/fleet/poiImport";
import sampleState from "@web/sampleState.json";
import * as capture from "../src/capture";
import * as captureFixtures from "../src/capture/fixtures";
import { PluginPanel } from "../src/panel/PluginPanel";
import { updatePluginSettings } from "../src/settings";
import "../assets/styles.css";

updatePluginSettings({ serverUrl: new URLSearchParams(location.search).get("server") ?? "http://localhost:5173/" });

// スクリーンショット等のスクリプトがページ内からデータを流し込むための口
Object.assign(window, { __kcsimDev: { capture, captureFixtures, importFromPoi, sampleState } });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PluginPanel poiState={sampleState} />
  </React.StrictMode>
);
