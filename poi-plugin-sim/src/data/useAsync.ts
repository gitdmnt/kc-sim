import { useEffect, useState } from "react";
import type { Loaded } from "./api";

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  stale: boolean;
}

/** `load` が null のときは何も取得しない。deps が変わると再取得する。 */
export const useAsync = <T,>(load: (() => Promise<Loaded<T>>) | null, deps: unknown[]): AsyncState<T> => {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: undefined, loading: !!load, stale: false });
  useEffect(() => {
    if (!load) {
      setState({ data: undefined, error: undefined, loading: false, stale: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    load().then(
      (r) => alive && setState({ data: r.data, error: undefined, loading: false, stale: r.stale }),
      (e) => alive && setState({ data: undefined, error: e as Error, loading: false, stale: false })
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
};
