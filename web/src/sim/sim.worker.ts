/// <reference lib="webworker" />
import type { SortieSummary } from "@sim-core";
import init, { simulateBattle, simulateSortie } from "@sim-core";
import wasmUrl from "@sim-core/sim_core_bg.wasm?url";
import { runJobs, runSortieJob } from "./runner";
import type { Job, JobResult, SortieJob } from "./runner";

export type WorkerRequest =
  | { type: "run"; jobs: Job[]; chunk: number }
  | { type: "runSortie"; job: SortieJob; chunk: number };
export type WorkerResponse =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; results: JobResult[] }
  | { type: "sortieDone"; summary: SortieSummary }
  | { type: "error"; message: string };

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

// wasm はビルドが dist/assets に置いたファイルをページと同じオリジンから読む
const ready = init({ module_or_path: wasmUrl });

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    await ready;
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
