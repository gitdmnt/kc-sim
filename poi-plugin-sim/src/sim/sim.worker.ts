/// <reference lib="webworker" />
import type { SortieSummary } from "@sim-core";
import init, { simulateBattle, simulateSortie } from "@sim-core";
import { runJobs, runSortieJob } from "./runner";
import type { Job, SortieJob } from "./runner";

export type WorkerRequest =
  | { type: "run"; wasm: Uint8Array; jobs: Job[]; chunk: number }
  | { type: "runSortie"; wasm: Uint8Array; job: SortieJob; chunk: number };
export type WorkerResponse =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; results: ReturnType<typeof runJobs> }
  | { type: "sortieDone"; summary: SortieSummary }
  | { type: "error"; message: string };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    await init({ module_or_path: msg.wasm });
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
