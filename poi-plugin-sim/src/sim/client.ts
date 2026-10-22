import wasmBytes from "@sim-core/sim_core_bg.wasm?bytes";
import type { SortieSummary } from "@sim-core";
import { getHost } from "../host";
import type { InferOptions, PriorTable } from "../estimate/infer";
import type { EstimateResult, Observation } from "../estimate/types";
import type { Job, JobResult, SortieJob } from "./runner";
import type { WorkerResponse } from "./sim.worker";

export interface SimHandle<T = JobResult[]> {
  promise: Promise<T>;
  /** Worker を終了して実行を打ち切る (promise は "cancelled" で reject) */
  cancel: () => void;
}

const start = <T,>(
  request: Record<string, unknown>,
  pick: (m: WorkerResponse) => T | undefined,
  onProgress: (done: number, total: number) => void
): SimHandle<T> => {
  let worker: Worker | undefined;
  let cancelled = false;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<T>(async (resolve, reject) => {
    rejectFn = reject;
    let w: Worker;
    try {
      w = worker = getHost().createSimWorker();
    } catch (e) {
      return reject(e);
    }
    if (cancelled) return reject(new Error("cancelled"));
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.type === "progress") return onProgress(m.done, m.total);
      if (m.type === "error") return reject(new Error(m.message));
      const v = pick(m);
      if (v !== undefined) resolve(v);
    };
    w.onerror = (e) => reject(new Error(e.message || "Worker を起動できません (CSP またはファイルが見つかりません)"));
    w.postMessage({ ...request, wasm: wasmBytes });
  }).finally(() => worker?.terminate());
  return {
    promise,
    cancel: () => {
      cancelled = true;
      worker?.terminate();
      rejectFn(new Error("cancelled"));
    },
  };
};

/** wasm 本体は UI スレッドの JS にだけ埋め込み、Worker にはバイト列を渡す (fetch 不要)。 */
export const runInWorker = (jobs: Job[], onProgress: (done: number, total: number) => void, chunk = 10_000): SimHandle =>
  start({ type: "run", jobs, chunk }, (m) => (m.type === "done" ? m.results : undefined), onProgress);

export const runSortieInWorker = (
  job: SortieJob,
  onProgress: (done: number, total: number) => void,
  chunk = 2_000
): SimHandle<SortieSummary> =>
  start({ type: "runSortie", job, chunk }, (m) => (m.type === "sortieDone" ? m.summary : undefined), onProgress);

/** 敵艦の隠しステータス推定 (src/estimate)。wasm を使うので poi では Worker の中でしか動かせない。 */
export const estimateInWorker = (
  observations: Observation[],
  priors: PriorTable,
  options: InferOptions,
  onProgress: (done: number, total: number) => void = () => {}
): SimHandle<EstimateResult[]> =>
  start({ type: "estimate", observations, priors, options }, (m) => (m.type === "estimateDone" ? m.results : undefined), onProgress);
