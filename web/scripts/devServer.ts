import { resolve } from "node:path";

/**
 * Web UI の vite 開発サーバを起動し、応答するまで待つ (スクリーンショット・監査スクリプト用)。
 * `api` は /api の中継先 (vite.config.ts の KCSIM_API。既定 http://127.0.0.1:8787)。
 * 開発サーバは listen の前に sim-core/pkg を作る (vite.config.ts の buildWasm)。新しい作業ツリーでは cargo の初回ビルドを待つ。
 */
export const startDevServer = async (port: number, api?: string) => {
  const server = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "ignore",
    stderr: "inherit",
    env: { ...process.env, ...(api ? { KCSIM_API: api } : {}) },
  });
  const url = `http://localhost:${port}/`;
  for (let i = 0; !(await fetch(url).then((r) => r.ok, () => false)); i++) {
    if (server.exitCode !== null) throw new Error(`vite dev server exited (${server.exitCode})`);
    if (i > 3000) {
      server.kill();
      throw new Error("vite dev server did not start");
    }
    await Bun.sleep(100);
  }
  return server;
};
