import React from "react";
import ReactDOM from "react-dom/client";
import { reactClass } from "./App";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import state from "../myState.json";

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
