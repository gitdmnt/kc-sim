import { build } from "esbuild";
import { execSync } from "child_process";
import fs from "fs-extra";
import path from "path";

const DIST_DIR = "../poi-plugin-sim-build";

async function main() {
  console.log("🧹 Cleaning distribution directory...");
  await fs.emptyDir(DIST_DIR);

  // --- Step 1: Build WASM ---
  console.log("🦀 Building Rust WASM library...");
  try {
    execSync("wasm-pack build --target web", {
      cwd: "sim-core",
      stdio: "inherit",
    });
  } catch (e) {
    console.error("❌ Failed to build WASM library.");
    process.exit(1);
  }
  console.log("✅ WASM library built successfully.");

  // --- Step 2: Build React view ---
  console.log("⚛️ Building React component view...");
  await build({
    entryPoints: ["src/App.tsx"],
    bundle: true,
    outfile: path.join(DIST_DIR, "views", "index.js"),
    format: "cjs",
    tsconfig: "tsconfig.json",
    external: ["react"], // poi環境のReactを利用するため外部依存とする
  });
  console.log("✅ React view built successfully.");

  // --- Step 3: Create main entry point (index.es) ---
  console.log("📦 Creating plugin entry point (index.es)...");
  await fs.copy("index.es", path.join(DIST_DIR, "index.es"));
  console.log("✅ Entry point created.");

  // --- Step 4: Copy other necessary files ---
  console.log("🚚 Copying assets and package files...");
  // Copy package.build.json
  await fs.copy("package.build.json", path.join(DIST_DIR, "package.json"));
  // Copy WASM files
  await fs.copy("sim-core/pkg", path.join(DIST_DIR, "lib", "wasm"));
  // Copy README, etc.
  const filesToCopy = ["README.md", "LICENSE.md"];
  for (const file of filesToCopy) {
    if (await fs.pathExists(file)) {
      await fs.copy(file, path.join(DIST_DIR, file));
    }
  }
  // Copy other directories like i18n, assets if they exist
  for (const dir of ["i18n", "assets"]) {
    if (await fs.pathExists(dir)) {
      await fs.copy(dir, path.join(DIST_DIR, dir));
    }
  }
  console.log("✅ Files copied.");

  console.log("\n🎉 Plugin build complete! Output directory: " + DIST_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
