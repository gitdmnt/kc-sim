import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";
import pkg from "./package.json";

// ビルド成果物の出力先 (poi のプラグインディレクトリとして使う)。
const DIST_DIR = path.resolve(__dirname, "../poi-plugin-sim-build");
const ROOT = path.resolve(__dirname, "..");

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
          viteStaticCopy({
            targets: [
              { src: "index.es", dest: "." },
              { src: "package.build.json", dest: ".", rename: "package.json" },
              { src: "README.md", dest: "." },
              { src: "LICENSE.md", dest: "." },
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
