/**
 * 推定タブ用のフック。保存済みの観測 (IndexedDB) と data API から推定し、結果を送信できる。
 * 観測の組み立てはメインスレッド、グリッド計算 (wasm) は sim.worker の中で行う
 * (poi のプラグインウィンドウの CSP はページ内の WebAssembly コンパイルを禁止している)。
 * 結果は store.ts に置くので、タブを離れても残り、シミュレーションからも参照できる。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings } from "../app/settings";
import { getObservationDb } from "../capture";
import { getDataApi } from "../data/api";
import type { MasterData } from "../fleet/types";
import { estimateInWorker } from "../sim/client";
import type { SimHandle } from "../sim/client";
import { estimateAll, uploadEstimates } from "./estimate";
import type { EstimateAllOptions, EstimateCompute, UploadEstimatesOptions } from "./estimate";
import { ESTIMATE_MIN_N, setEstimates, useStoredEstimates } from "./store";
import type { StoredEstimates } from "./store";
import type { EstimateResult } from "./types";

export interface EstimatorState {
  status: "idle" | "running" | "error";
  /** 直近の推定結果 (前回の実行・保存分を含む) */
  result: StoredEstimates | null;
  /** グリッド計算の進捗 (署名単位)。観測の読み込み中は total 0 */
  progress: { done: number; total: number } | null;
  error: Error | null;
}

type RunOptions = Omit<EstimateAllOptions, "master" | "compute" | "onProgress">;

/**
 * `run()` で推定 (実行中の推定は打ち切る)、`cancel()` で中止、`upload()` で `estimator:poi` として送信
 * (n ≥ 30、戻り値は保存行数)。`master` は useApp().catalog.master。
 */
export const useEstimator = (master: MasterData) => {
  const result = useStoredEstimates();
  const [run_, setRun] = useState<Omit<EstimatorState, "result">>({ status: "idle", progress: null, error: null });
  const handle = useRef<SimHandle<EstimateResult[]> | null>(null);
  /** 実行ごとに増える。打ち切られた実行の結果で状態を上書きしないため。 */
  const generation = useRef(0);

  const cancel = useCallback(() => {
    generation.current++;
    handle.current?.cancel();
    handle.current = null;
    setRun((s) => (s.status === "running" ? { ...s, status: "idle", progress: null } : s));
  }, []);
  useEffect(() => cancel, [cancel]);

  const run = useCallback(
    async (opts: RunOptions = {}) => {
      cancel();
      const mine = ++generation.current;
      setRun({ status: "running", progress: { done: 0, total: 0 }, error: null });
      const compute: EstimateCompute = (observations, priors, options, onProgress) => {
        const h = estimateInWorker(observations, priors, options, onProgress);
        if (generation.current === mine) handle.current = h;
        else h.cancel();
        return h.promise;
      };
      try {
        const r = await estimateAll(getObservationDb(), getDataApi(), {
          ...opts,
          master,
          compute,
          onProgress: (done, total) => generation.current === mine && setRun((s) => ({ ...s, progress: { done, total } })),
        });
        if (generation.current !== mine) return null;
        setEstimates(r);
        setRun({ status: "idle", progress: null, error: null });
        return r;
      } catch (e) {
        if (generation.current !== mine) return null;
        setRun({ status: "error", progress: null, error: e instanceof Error ? e : new Error(String(e)) });
        return null;
      } finally {
        if (generation.current === mine) handle.current = null;
      }
    },
    [master, cancel]
  );

  const upload = useCallback(
    (o: UploadEstimatesOptions = {}) => uploadEstimates(getSettings().apiBase, result?.results ?? [], { minN: ESTIMATE_MIN_N, ...o }),
    [result]
  );

  const state: EstimatorState = { ...run_, result };
  return { ...state, run, cancel, upload, clear: () => setEstimates(null) };
};
