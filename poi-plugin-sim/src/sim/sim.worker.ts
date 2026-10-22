/// <reference lib="webworker" />
import type { SortieSummary } from "@sim-core";
import init, { simulateBattle, simulateSortie } from "@sim-core";
import { estimateFromObservations } from "../estimate/infer";
import type { InferOptions, PriorTable } from "../estimate/infer";
import type { EstimateResult, Observation } from "../estimate/types";
import { runJobs, runSortieJob } from "./runner";
import type { Job, SortieJob } from "./runner";

export type WorkerRequest =
  | { type: "run"; wasm: Uint8Array; jobs: Job[]; chunk: number }
  | { type: "runSortie"; wasm: Uint8Array; job: SortieJob; chunk: number }
  /** 敵艦の隠しステータス推定 (src/estimate/infer.ts)。progress は署名単位。 */
  | { type: "estimate"; wasm: Uint8Array; observations: Observation[]; priors: PriorTable; options: InferOptions };
export type WorkerResponse =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; results: ReturnType<typeof runJobs> }
  | { type: "sortieDone"; summary: SortieSummary }
  | { type: "estimateDone"; results: EstimateResult[] }
  | { type: "error"; message: string };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    await init({ module_or_path: msg.wasm });
    if (msg.type === "estimate") {
      let last = 0;
      const results = estimateFromObservations(msg.observations, msg.priors, {
        ...msg.options,
        // 署名は数千個になりうるので 1% 刻みで送る
        onProgress: (done, total) => {
          if (done === total || done - last >= total / 100) {
            last = done;
            post({ type: "progress", done, total });
          }
        },
      });
      post({ type: "estimateDone", results });
      return;
    }
    if (msg.type === "runSortie") {
      const summary = runSortieJob((i, n, seed) => simulateSortie(i, n, seed), msg.job, {
        chunk: msg.chunk,
        onProgress: (done, total) => post({ type: "progress", done, total }),
      });
      post({ type: "sortieDone", summary });
      return;
    }
    const results = runJobs((input, n, seed) => simulateBattle(input, n, seed), msg.jobs, {
      chunk: msg.chunk,
      onProgress: (done, total) => post({ type: "progress", done, total }),
    });
    post({ type: "done", results });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
