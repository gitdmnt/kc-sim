import { build as viteBuild, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import tsconfigPaths from "vite-tsconfig-paths";

// ビルド成果物の出力先 (poi のプラグインディレクトリとして使う)。
const DIST_DIR = path.resolve(__dirname, "../poi-plugin-sim-build");
// Rust (wasm-pack) のクレート。pkg/ に wasm-pack の出力が生成される。
const SIM_CORE_DIR = path.resolve(__dirname, "../sim-core");

/**
 * `foo.wasm?bytes` を、wasm のバイト列を base64 で埋め込んだ Uint8Array として読み込む。
 * poi (Electron, file://) では相対 URL の fetch が使えないため、wasm を JS に同梱する。
 */
const wasmBytes = (): Plugin => ({
  name: "wasm-bytes",
  enforce: "pre",
  resolveId(source, importer) {
    const [file, query] = source.split("?");
    if (query !== "bytes" || !file.endsWith(".wasm")) return null;
    const resolved = file.startsWith("@sim-core/")
      ? path.join(SIM_CORE_DIR, "pkg", file.slice("@sim-core/".length))
      : path.resolve(path.dirname(importer ?? __dirname), file);
    return `\0wasm-bytes:${resolved}`;
  },
  load(id) {
    if (!id.startsWith("\0wasm-bytes:")) return null;
    const file = id.slice("\0wasm-bytes:".length);
    this.addWatchFile(file);
    const base64 = fs.readFileSync(file).toString("base64");
    return `const b64 = ${JSON.stringify(base64)};
const bin = atob(b64);
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
export default bytes;`;
  },
});

/**
 * Worker を `views/sim.worker.js` (単独の IIFE) として出力する。poi の CSP は blob:/data: の Worker を
 * 禁止するため、インライン化せず file:// から読み込む (src/sim/client.ts 参照)。
 */
const emitSimWorker = (): Plugin => ({
  name: "emit-sim-worker",
  apply: "build",
  async closeBundle() {
    await viteBuild({
      configFile: false,
      logLevel: "warn",
      plugins: [stripDefaultWasmUrl(), tsconfigPaths()],
      build: {
        outDir: path.join(DIST_DIR, "views"),
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: path.resolve(__dirname, "src/sim/sim.worker.ts"),
          formats: ["iife"],
          name: "kcsimWorker",
          fileName: () => "sim.worker.js",
        },
      },
    });
  },
});

/**
 * wasm-bindgen の生成 JS は既定の読み込み先 `new URL('sim_core_bg.wasm', import.meta.url)` を持ち、
 * vite がそれを base64 のデータ URL として丸ごと埋め込んでしまう。このプロジェクトでは常に
 * `init({ module_or_path: bytes })` でバイト列を渡す (poi の CSP で fetch/相対 URL が使えない) ので、
 * 既定の読み込み先を潰して二重の埋め込み (約 0.5MB) を避ける。
 */
const stripDefaultWasmUrl = (): Plugin => ({
  name: "strip-default-wasm-url",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/sim_core.js")) return null;
    const re = /new URL\((['"])sim_core_bg\.wasm\1, import\.meta\.url\)/;
    if (!re.test(code)) return null;
    return { code: code.replace(re, 'undefined /* wasm bytes must be passed to init() */'), map: null };
  },
});

const buildWasm = (): Plugin => ({
  name: "build-wasm",
  apply: "build",
  buildStart() {
    // 既存の sim-core/pkg を使い回したいとき (別の担当が sim-core を編集中など) は SKIP_WASM_BUILD=1
    if (process.env.SKIP_WASM_BUILD && fs.existsSync(path.join(SIM_CORE_DIR, "pkg/sim_core_bg.wasm"))) {
      console.log("SKIP_WASM_BUILD: reusing sim-core/pkg");
      return;
    }
    console.log("Building Rust WASM library...");
    try {
      execSync("wasm-pack build --target web", {
        cwd: SIM_CORE_DIR,
        stdio: "inherit",
      });
    } catch (e) {
      this.error("Failed to build WASM library (is wasm-pack installed?).");
    }
  },
});

// vite は poi 向けのビルド専用。開発サーバは bun (dev/server.ts)。
export default defineConfig({
  plugins: [
    wasmBytes(),
    stripDefaultWasmUrl(),
    tsconfigPaths(),
    react({ jsxRuntime: "classic" }),
    buildWasm(),
    emitSimWorker(),
    viteStaticCopy({
      targets: [
        { src: "index.es", dest: "." },
        { src: "package.build.json", dest: ".", rename: "package.json" },
        { src: "README.md", dest: "." },
        // API に繋がらないときの代替 (静的マップバンドル)。server で export:bundle 済みなら同梱する
        ...(fs.existsSync(path.resolve(__dirname, "../server/dist/maps"))
          ? [{ src: "../server/dist/maps", dest: "." }]
          : []),
        { src: "LICENSE.md", dest: "." },
        { src: "i18n", dest: "." },
      ],
    }),
  ],
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, "src/poi/index.tsx"),
      formats: ["cjs"],
      fileName: () => "views/index.js",
    },
    rollupOptions: {
      // poi が提供する React を使う
      external: ["react", "react-dom"],
      output: {
        globals: { react: "React", "react-dom": "ReactDOM" },
      },
    },
  },
});
