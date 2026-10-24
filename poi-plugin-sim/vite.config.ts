import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";
import pkg from "./package.json";
import buildPkg from "./package.build.json";

// ビルド成果物の出力先 = npm に公開するパッケージ (poi のプラグインディレクトリにリンクしても使える)。
// ディレクトリ名は前からのまま (手元の poi が file: でここを指している)。パッケージ名は package.build.json の name。
const DIST_DIR = path.resolve(__dirname, "../poi-plugin-sim-build");
const ROOT = path.resolve(__dirname, "..");

// 公開する package.json: package.build.json に、このパッケージ (package.json) の version を足す。版はここだけで管理する。
const packageJson = (): Plugin => ({
  name: "kcsim-package-json",
  generateBundle() {
    const { name, ...rest } = buildPkg;
    const source = `${JSON.stringify({ name, version: pkg.version, ...rest }, null, 2)}\n`;
    this.emitFile({ type: "asset", fileName: "package.json", source });
  },
});

// tsconfig の paths と同じ別名 (プラグインのビューと枠は Web UI の部品を使う)。web/src のファイルの import は
// ../web/node_modules に解決されるので、React と lucide-react はこのパッケージの 1 組に揃える (2 組あると hooks が壊れる)
const resolve = {
  alias: [
    { find: /^@web\//, replacement: `${path.join(ROOT, "web/src")}/` },
    { find: /^@shared\//, replacement: `${path.join(ROOT, "shared")}/` },
  ],
  dedupe: ["react", "react-dom", "lucide-react"],
};

// `vite` (serve) は dev/ の開発用ページ (poi 無しでビューと iframe の橋渡しを動かす)、`vite build` は poi 向けのビルド。
export default defineConfig(({ command }) => ({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  ...(command === "serve"
    ? {
        root: path.join(__dirname, "dev"),
        plugins: [react({ jsxRuntime: "classic" })],
        resolve,
        css: { postcss: __dirname },
        server: { port: 5174, fs: { allow: [ROOT] } },
      }
    : {
        plugins: [
          react({ jsxRuntime: "classic" }),
          packageJson(),
          viteStaticCopy({
            targets: [
              { src: "index.es", dest: "." },
              // npm のページに出る利用者向けの説明 (この README.md は開発者向け)
              { src: "README.npm.md", dest: ".", rename: "README.md" },
              { src: "LICENSE", dest: "." },
              { src: "THIRD_PARTY_NOTICES", dest: "." },
              { src: "i18n", dest: "." },
            ],
          }),
        ],
        resolve,
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
      }),
}));
