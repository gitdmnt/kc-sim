import type { BunPlugin } from "bun";
import { dirname, join, resolve } from "node:path";

const SIM_CORE_PKG = resolve(import.meta.dir, "../../sim-core/pkg");

/**
 * `foo.wasm?bytes` を Uint8Array として読み込む (vite.config.ts の wasm-bytes と同じ規約)。
 * 開発サーバは同一オリジンから配るので base64 埋め込みでなく fetch でもよいが、
 * コアのコードを poi 向けビルドと共通にするため同じ形にしている。
 */
export const wasmBytes: BunPlugin = {
  name: "wasm-bytes",
  setup(build) {
    build.onResolve({ filter: /\.wasm\?bytes$/ }, (args) => {
      const file = args.path.slice(0, -"?bytes".length);
      const path = file.startsWith("@sim-core/")
        ? join(SIM_CORE_PKG, file.slice("@sim-core/".length))
        : resolve(dirname(args.importer), file);
      return { path, namespace: "wasm-bytes" };
    });
    build.onLoad({ filter: /.*/, namespace: "wasm-bytes" }, async (args) => {
      const b64 = Buffer.from(await Bun.file(args.path).arrayBuffer()).toString("base64");
      return {
        loader: "js",
        contents: `const bin = atob(${JSON.stringify(b64)});
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
export default bytes;`,
      };
    });
  },
};
