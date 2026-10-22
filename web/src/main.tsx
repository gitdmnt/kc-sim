import React from "react";
import { createRoot } from "react-dom/client";
import { KcsimApp } from "./KcsimApp";
import { startPoiBridge } from "./poiBridge";
import "./styles.css";

void startPoiBridge();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <KcsimApp />
  </React.StrictMode>
);
