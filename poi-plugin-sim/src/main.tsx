/// <reference types="vite/client" />
import React from "react";
import ReactDOM from "react-dom/client";
import { reactClass } from "./App";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";

// poi からダンプした実データ (../myState.json, gitignore 対象) があればそれを使い、
// なければ最小のダミー状態 (../dev/sampleState.json) にフォールバックする。
const dumped = import.meta.glob("../myState.json", {
  eager: true,
  import: "default",
});
const fallback = import.meta.glob("../dev/sampleState.json", {
  eager: true,
  import: "default",
});
const state: any = Object.values(dumped)[0] ?? Object.values(fallback)[0];

// dev ハーネス専用: poi 側と違い body に既定の余白があるので消す
document.body.style.cssText = "margin:0;background:#1c2127";

const App = reactClass;

const reducer = (_state: any, _action: any) => {
  return state;
};

const store = configureStore({ reducer });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>
);
