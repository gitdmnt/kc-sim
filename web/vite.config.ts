import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import pkg from "./package.json";

const ROOT = path.resolve(__dirname, "..");
// Rust (wasm-pack) のクレート。pkg/ に wasm-pack の出力が生成される。
const SIM_CORE_DIR = path.join(ROOT, "sim-core");
// API に繋がらないときの代替 (静的マップバンドル、server で `bun run export:bundle`)。あれば dist/maps に同梱する
const MAPS_DIR = path.join(ROOT, "server/dist/maps");
// 開発サーバで poi の代わりに使う state (`myState.json` = poi の state のダンプ、無ければ同梱サンプル)
const DEV_STATE = [path.join(__dirname, "myState.json"), path.join(__dirname, "src/sampleState.json")].find((f) => fs.existsSync(f))!;

const WASM_BUILD = "wasm-pack build --target web";
// pkg/ の中身を決めるファイル (sim_core_types.d.ts は lib.rs が include_str! で生成物の型に埋め込む)
const WASM_SOURCES = ["src", "Cargo.toml", "Cargo.lock", "sim_core_types.d.ts"].map((f) => path.join(SIM_CORE_DIR, f));

/**
 * sim-core/pkg を Rust のソースから作る。`vite build` は開始時に、開発サーバは起動時と WASM_SOURCES が変わるたび
 * (編集・git の merge / pull) に作り直す (書き換わった pkg は Vite が見ていて、ページを読み込み直す)。開発サーバは
 * TS を HMR で新しくするので、pkg を作り直さないと新しい TS が古い wasm を呼ぶ (新しい集計の欄を読む runner と、
 * その欄を出さない wasm)。
 */
const buildWasm = (): Plugin => {
  // 既存の sim-core/pkg を使い回したいとき (別の担当が sim-core を編集中など) は SKIP_WASM_BUILD=1 (開発サーバも監視しない)
  const skip = !!process.env.SKIP_WASM_BUILD && fs.existsSync(path.join(SIM_CORE_DIR, "pkg/sim_core_bg.wasm"));
  const buildSync = (fail: (msg: string) => never) => {
    if (skip) return console.log("SKIP_WASM_BUILD: reusing sim-core/pkg");
    console.log("Building Rust WASM library...");
    try {
      execSync(WASM_BUILD, { cwd: SIM_CORE_DIR, stdio: "inherit" });
    } catch {
      fail("Failed to build WASM library (is wasm-pack installed? SKIP_WASM_BUILD=1 reuses sim-core/pkg).");
    }
  };
  return {
    name: "build-wasm",
    buildStart() {
      if (this.environment.mode === "build") buildSync((msg) => this.error(msg));
    },
    configureServer(server) {
      buildSync((msg) => {
        throw new Error(msg);
      });
      if (skip) return;
      server.watcher.add(WASM_SOURCES);
      let timer: NodeJS.Timeout | undefined;
      let building = false;
      let again = false;
      const rebuild = () => {
        if (building) {
          again = true;
          return;
        }
        building = true;
        server.config.logger.info("sim-core changed: rebuilding sim-core/pkg...", { timestamp: true });
        const child = spawn(WASM_BUILD, { cwd: SIM_CORE_DIR, shell: true, stdio: ["ignore", "inherit", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => {
          stderr += d;
          process.stderr.write(d);
        });
        child.on("close", (code) => {
          building = false;
          // 失敗は古い pkg のまま黙って動き続けないよう、ページに出す (エラーオーバーレイ)
          if (code !== 0) server.environments.client.hot.send({ type: "error", err: { message: `sim-core build failed (${WASM_BUILD})\n${stderr.slice(-4000)}`, stack: "" } });
          else server.config.logger.info("sim-core/pkg rebuilt", { timestamp: true });
          if (again) {
            again = false;
            rebuild();
          }
        });
      };
      server.watcher.on("all", (_event, file) => {
        if (!WASM_SOURCES.some((s) => file === s || file.startsWith(s + path.sep))) return;
        clearTimeout(timer);
        timer = setTimeout(rebuild, 300);
      });
    },
  };
};

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
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
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
