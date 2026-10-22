/** wasm のバイト列 (vite.config.ts / dev/plugins.ts の wasm-bytes プラグインが解決する) */
declare module "*.wasm?bytes" {
  const bytes: Uint8Array;
  export default bytes;
}

/** CSS をテキストで読む (vite の `?inline`。poi エントリだけが使う) */
declare module "*.css?inline" {
  const css: string;
  export default css;
}

/** poi (CommonJS で読まれる) ではバンドルの置き場所。それ以外では未定義 */
declare const __dirname: string | undefined;

/** ビルド時に置換される。開発サーバでは true、poi 向けビルドでは false */
interface ImportMetaEnv {
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
