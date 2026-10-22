declare module "*.wasm?bytes" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "*?worker" {
  const WorkerCtor: new () => Worker;
  export default WorkerCtor;
}

declare const __dirname: string | undefined;
/** vite serve のときだけ define される (開発用の静的バンドルの場所) */
declare const __DEV_BUNDLE_BASE__: string | undefined;
