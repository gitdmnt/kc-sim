import React, { useState, useEffect } from "react";
import { getFleets } from "./utils/poiAPIWrapper";
import "../assets/styles.css";
import { BattleSim } from "./BattleSim";
import init from "../sim-core/pkg/sim_core";
import { connect } from "react-redux";
import { DebugMenu } from "./DebugMenu";

/* @ts-ignore */
import * as kcdb from "@kancolle/data";

const App = ({ state }: { state: any }) => {
  const [wasmInitialized, setWasmInitialized] = useState(false);

  console.error(state);

  const fleets = getFleets(state);

  useEffect(() => {
    // WASMモジュールを初期化
    init()
      .then(() => {
        setWasmInitialized(true);
        console.log("WASM module initialized.");
      })
      .catch(console.error);
  }, []); // このeffectはコンポーネントのマウント時に一度だけ実行

  // WASMの初期化が完了するまでローディング表示などを行う
  if (!wasmInitialized) {
    return <div>Loading WebAssembly module...</div>;
  }

  return (
    <div className="bg-gray-100 p-4 min-h-dvh flex flex-col gap-4">
      <DebugMenu />
      <BattleSim friend={fleets} stage={""} />
    </div>
  );
};

const ConnectedApp = connect((state: any) => ({ state }))(App);

// poi will render this component in the plugin panel
export class reactClass extends React.Component {
  render() {
    return <ConnectedApp />;
  }
}
