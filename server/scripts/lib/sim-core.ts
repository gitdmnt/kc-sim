// sim-core in-process under bun (scripts, tests): the forward model the estimator folds into its grids.
// Needs `sim-core/pkg` (`bun run build:wasm`).
import { readFileSync } from "node:fs";
import { hitProbabilityGrid, initSync } from "../../../sim-core/pkg/sim_core";
import type { GridFn } from "../../../shared/estimate/forward";

let ready = false;
/** sim-core's hitProbabilityGrid, instantiating the wasm module on first use. */
export function bunGrid(): GridFn {
  if (!ready) {
    initSync({ module: readFileSync(new URL("../../../sim-core/pkg/sim_core_bg.wasm", import.meta.url)) });
    ready = true;
  }
  return hitProbabilityGrid;
}
