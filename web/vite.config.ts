import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const ROOT = path.resolve(__dirname, "..");
// Rust (wasm-pack) のクレート。pkg/ に wasm-pack の出力が生成される。
const SIM_CORE_DIR = path.join(ROOT, "sim-core");
// API に繋がらないときの代替 (静的マップバンドル、server で `bun run export:bundle`)。あれば dist/maps に同梱する
const MAPS_DIR = path.join(ROOT, "server/dist/maps");
// 開発サーバで poi の代わりに使う state (`myState.json` = poi の state のダンプ、無ければ同梱サンプル)
const DEV_STATE = [path.join(__dirname, "myState.json"), path.join(__dirname, "src/sampleState.json")].find((f) => fs.existsSync(f))!;

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
      execSync("wasm-pack build --target web", { cwd: SIM_CORE_DIR, stdio: "inherit" });
    } catch {
      this.error("Failed to build WASM library (is wasm-pack installed?).");
    }
  },
});

/** 開発サーバだけ: 親フレーム (poi) が無いときに読む poi の state (src/poiBridge.ts)。 */
const devState = (): Plugin => ({
  name: "dev-state",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__dev/state.json", (_req, res) => {
      res.setHeader("content-type", "application/json");
      fs.createReadStream(DEV_STATE).pipe(res);
    });
  },
});

// tsconfig の paths と同じ別名。`?url` などのクエリ付きも解決できるよう正規表現で書く。
const alias = [
  { find: /^@sim-core$/, replacement: path.join(SIM_CORE_DIR, "pkg/sim_core.js") },
  { find: /^@sim-core\//, replacement: `${path.join(SIM_CORE_DIR, "pkg")}/` },
  { find: /^@shared\//, replacement: `${path.join(ROOT, "shared")}/` },
];

export default defineConfig({
  plugins: [
    react({ jsxRuntime: "classic" }),
    buildWasm(),
    devState(),
    ...(fs.existsSync(MAPS_DIR) ? viteStaticCopy({ targets: [{ src: MAPS_DIR, dest: "." }] }) : []),
  ],
  resolve: { alias },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // データ API はページと同じオリジンの /api。開発中は wrangler dev (または KCSIM_API) に中継する
    proxy: { "/api": process.env.KCSIM_API ?? "http://127.0.0.1:8787" },
    fs: { allow: [ROOT] },
  },
});
