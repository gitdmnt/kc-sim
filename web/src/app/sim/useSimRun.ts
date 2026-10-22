import { useCallback, useEffect, useRef, useState } from "react";
import type { SimHandle } from "../../sim/client";

/** 1 回分の計算の材料。入力が変わるたびに作り直す (同一性で「結果が古いか」を判定する)。 */
export interface SimRequest<T> {
  start: (count: number, onProgress: (done: number, total: number) => void) => SimHandle<T>;
}

export interface SimResult<T> {
  value: T;
  request: SimRequest<T>;
  count: number;
  ms: number;
}

export interface SimRun<T> {
  result: SimResult<T> | null;
  progress: { done: number; total: number } | null;
  error: string | null;
  /** 表示中の結果が今の入力のものではない (自動実行の待ち・計算中を含む) */
  stale: boolean;
  run: (count: number) => void;
  cancel: () => void;
}

/**
 * 計算の実行・打ち切り・自動実行。`auto` のときは request が変わるたびに `delayMs` 待ってから `autoCount` 回で回し、
 * 進行中の計算は打ち切る。request が null (実行できない) なら何もしない。
 */
export const useSimRun = <T>(
  request: SimRequest<T> | null,
  opts: { auto: boolean; autoCount: number; delayMs: number }
): SimRun<T> => {
  const [result, setResult] = useState<SimResult<T> | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<SimHandle<T> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(request);
  latest.current = request;

  const cancel = useCallback(() => {
    handle.current?.cancel();
    handle.current = null;
    setProgress(null);
  }, []);

  const run = useCallback((count: number) => {
    clearTimeout(timer.current);
    handle.current?.cancel();
    const req = latest.current;
    if (!req) return;
    setError(null);
    setProgress({ done: 0, total: count });
    const t0 = performance.now();
    // 打ち切られた古い計算の進捗・結果は捨てる
    const h = req.start(count, (done, total) => handle.current === h && setProgress({ done, total }));
    handle.current = h;
    h.promise
      .then(
        (value) => handle.current === h && setResult({ value, request: req, count, ms: performance.now() - t0 }),
        (e: Error) => handle.current === h && e.message !== "cancelled" && setError(e.message)
      )
      .finally(() => {
        if (handle.current !== h) return;
        handle.current = null;
        setProgress(null);
      });
  }, []);

  const computed = result?.request === request;
  useEffect(() => {
    if (!opts.auto || !request || computed) return;
    // 入力が変わった時点で古い計算は不要
    if (handle.current) cancel();
    timer.current = setTimeout(() => run(opts.autoCount), opts.delayMs);
    return () => clearTimeout(timer.current);
  }, [request, opts.auto]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => handle.current?.cancel(), []);

  return { result, progress, error, stale: !!result && !computed, run, cancel };
};
