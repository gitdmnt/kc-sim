/** dev/server.ts が poi 向けビルドと同じ PostCSS 設定を使うための型 */
declare module "*/postcss.config.mjs" {
  import type { AcceptedPlugin } from "postcss";
  const config: { plugins: AcceptedPlugin[] };
  export default config;
}
