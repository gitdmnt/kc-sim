import React, { useState, useEffect } from "react";
import { connect } from "react-redux";
import { createSelector } from "reselect";
import { Fleets } from "./Fleets";
import { getFleets } from "./hooks/getFleets";
import "../assets/styles.css";
import { Fleet } from "./types";
import { BattleSim } from "./BattleSim";
import init from "../sim-core/pkg/sim_core";
import { connectComponent } from "./hooks/connectComponent";

const App = ({ state }: { state: any }) => {
  const [wasmInitialized, setWasmInitialized] = useState(false);

  const fleets = getFleets(state);
  console.log("fleets: ", fleets);

  //   console.log(state.const);

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
      <Fleets fleets={fleets} state={state} />

      <BattleSim friend={fleets[0]} stage={""} />
    </div>
  );
};

const ConnectedApp = connectComponent(App);

// poi will render this component in the plugin panel
export class reactClass extends React.Component {
  render() {
    return <ConnectedApp />;
  }
}
