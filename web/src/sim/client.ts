import type { SortieSummary } from "@sim-core";
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
      w = worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
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
    w.onerror = (e) => reject(new Error(e.message || "Worker を起動できません"));
    w.postMessage(request);
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

/** Worker は呼び出しごとに作り、wasm は Worker 側で読み込む (sim.worker.ts)。 */
export const runInWorker = (jobs: Job[], onProgress: (done: number, total: number) => void, chunk = 10_000): SimHandle =>
  start({ type: "run", jobs, chunk }, (m) => (m.type === "done" ? m.results : undefined), onProgress);

export const runSortieInWorker = (
  job: SortieJob,
  onProgress: (done: number, total: number) => void,
  chunk = 2_000
): SimHandle<SortieSummary> =>
  start({ type: "runSortie", job, chunk }, (m) => (m.type === "sortieDone" ? m.summary : undefined), onProgress);
