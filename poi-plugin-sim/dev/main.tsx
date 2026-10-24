/**
 * プラグインのビューを poi 無しで動かす開発用ページ (`bun run dev`、http://localhost:5174)。
 *
 * poi のウィンドウモードと同じ形にする: プラグインのコード (この React ツリー・postMessage) はこのページ (= poi の
 * メインウィンドウ) で動き、ビューだけを window.open した子ウィンドウ (= プラグインウィンドウ) に createPortal で描く。
 * 子ウィンドウには poi と同じく `isWindowMode = true` を立てる。`?mode=tab` ならこのページに直接描く (poi のタブ表示)。
 *
 * poi の state は Web UI の同梱サンプル。iframe の Web UI は `?server=` (既定 http://localhost:5173/ = web の `bun run dev`)。
 */
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { importFromPoi } from "@shared/fleet/poiImport";
import sampleState from "@web/sampleState.json";
import * as capture from "../src/capture";
import * as captureFixtures from "../src/capture/fixtures";
import { PluginPanel } from "../src/panel/PluginPanel";
import { ResourceDb } from "../src/resources";
import { seedResourceHistory } from "./resourcesSeed";
import { updatePluginSettings } from "../src/settings";
import styles from "../assets/styles.css?inline";

const params = new URLSearchParams(location.search);
updatePluginSettings({ serverUrl: params.get("server") ?? "http://localhost:5173/" });

// スクリーンショット等のスクリプトがページ内からデータを流し込むための口
Object.assign(window, { __kcsimDev: { capture, captureFixtures, importFromPoi, sampleState, resources: { ResourceDb, seedResourceHistory } } });

const PANEL = (
  <>
    <style>{styles}</style>
    <PluginPanel poiState={sampleState} />
  </>
);

/** poi の plugin-window-wrapper と同じく、空の子ウィンドウを開いてそこへ portal する */
const openPluginWindow = (): HTMLElement | null => {
  const child = window.open("about:blank", "plugin[kcsim]", "width=1440,height=1000");
  if (!child) return null;
  child.document.title = "kcsim plugin window (dev)";
  child.document.body.style.margin = "0";
  Object.assign(child, { isWindowMode: true });
  const mount = child.document.createElement("div");
  child.document.body.appendChild(mount);
  window.addEventListener("beforeunload", () => child.close());
  return mount;
};

// StrictMode は初期化を 2 回走らせるので、最初の 1 回はモジュールの読み込み時に開く
const initialMount = params.get("mode") === "tab" ? null : openPluginWindow();

const WindowMode = () => {
  // ポップアップがブロックされたらボタンで開く
  const [mount, setMount] = useState<HTMLElement | null>(initialMount);
  return (
    <div style={{ color: "#dde6f2", font: "14px system-ui", padding: 16 }}>
      <p>poi のメインウィンドウ役。プラグインのビューは別ウィンドウに portal しています (ウィンドウモード)。</p>
      {!mount && <button onClick={() => setMount(openPluginWindow())}>プラグインウィンドウを開く</button>}
      {mount && createPortal(PANEL, mount)}
    </div>
  );
};
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{params.get("mode") === "tab" ? PANEL : <WindowMode />}</React.StrictMode>
);
