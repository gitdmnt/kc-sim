// 公開 API (docs/ESTIMATOR.md)。useEstimator は sim/client (wasm バイト列・Worker) を読むので UI 専用。
export * from "./types";
export {
  applyEstimates, candidatesFromApi, candidatesFromResults, choosePrior, computeInProcess, ESTIMATOR_SOURCE, estimateAll,
  makeApplyEstimates, pickEstimates, uploadEstimates,
} from "./estimate";
export type {
  ApplyOptions, EstimateAllOptions, EstimateAllResult, EstimateCandidate, EstimateCompute, EstimatorApi, EstimatorDb,
  UploadEstimatesOptions,
} from "./estimate";
export { estimateFromObservations, groupObservations } from "./infer";
export type { EstimateOptions, InferOptions, PriorInput, PriorTable } from "./infer";
export { buildObservations, battleMorale, capturedKind, sortieFuelRates } from "./observe";
export type { CapturedKind, ObserveContext, ObserveResult } from "./observe";
export { canonicalQuery, signature, wasmGrid } from "./forward";
export type { GridFn } from "./forward";
export { axisValues, DEFAULT_GRID, DEFAULT_PRIOR_SD, ShipPosterior, summarize } from "./posterior";
export type { Axis, GridSpec, Marginal, PriorSdTable, Summary } from "./posterior";
export { captureFromRun, syntheticWorld } from "./synthetic";
export type { CaptureOptions, SyntheticRecord } from "./synthetic";
export { ESTIMATE_MIN_N, estimatesForSimulation, getEstimates, setEstimates, usableEstimates, useStoredEstimates } from "./store";
export type { StoredEstimates } from "./store";
export { useEstimator } from "./useEstimator";
export type { EstimatorState } from "./useEstimator";
