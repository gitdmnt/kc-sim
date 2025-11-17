import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { viteStaticCopy } from "vite-plugin-static-copy";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { execSync } from "child_process";
import tsconfigPaths from "vite-tsconfig-paths";

const DIST_DIR = "../node_modules/poi-plugin-sim-build";

const devBuildConfig = {
  outDir: "dist-dev",
  emptyOutDir: true,
  sourcemap: true,
  rollupOptions: {
    external: ["react", "react-dom"],
  },
};

export default defineConfig(({ command }) => {
  const isServe = command === "serve";

  if (isServe) {
    console.log("Running vite dev server...");
    return {
      plugins: [tsconfigPaths(), tailwindcss(), react(), wasm()],
      server: {
        open: false,
        watch: {},
      },
    };
  } else {
    console.log("Building for production...");
    return {
      plugins: [
        tailwindcss(),
        react({
          jsxRuntime: "classic",
        }),
        wasm(),
        {
          name: "build-wasm",
          buildStart() {
            console.log("🦀 Building Rust WASM library...");
            try {
              execSync("wasm-pack build --target web", {
                cwd: "sim-core",
                stdio: "inherit",
              });
              console.log("✅ WASM library built successfully.");
            } catch (e) {
              console.error("❌ Failed to build WASM library.");
              process.exit(1);
            }
          },
        },
        viteStaticCopy({
          targets: [
            {
              src: "index.es",
              dest: ".",
            },
            {
              src: "package.build.json",
              dest: ".",
              rename: "package.json",
            },
            {
              src: "sim-core/pkg",
              dest: "lib/wasm",
            },
            {
              src: "README.md",
              dest: ".",
            },
            {
              src: "LICENSE.md",
              dest: ".",
            },
            {
              src: "i18n",
              dest: ".",
            },
            {
              src: "assets",
              dest: ".",
            },
          ],
        }),
      ],
      build: {
        outDir: DIST_DIR,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: path.resolve(__dirname, "src/App.tsx"),
          formats: ["cjs"],
          fileName: () => "views/index.js",
        },
        rollupOptions: {
          external: ["react", "react-dom"],
          globals: {
            react: "React",
            "react-dom": "ReactDOM",
          },
        },
      },
    };
  }
});
