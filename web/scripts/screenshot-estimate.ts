/**
 * パラメータ推定タブのスクリーンショット (docs/screenshots/16-estimate.png)。
 * Web UI の vite 開発サーバ (port 5211) を起動し、/api (中継先 127.0.0.1:8787) の推定値 (GET /api/v1/estimates) を表示する。
 * API が動いていて、サーバが推定済みであること。`bun scripts/screenshot-estimate.ts`
 */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startDevServer } from "./devServer";

const OUT = resolve(import.meta.dir, "../../docs/screenshots/16-estimate.png");
const PORT = 5211;

const findChromium = (): string => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of readdirSync(join(base, d))) {
      const exe = join(base, d, sub, "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error("chromium_headless_shell not found; set CHROMIUM_PATH");
};

const server = await startDevServer(PORT);

const browser = await chromium.launch({ executablePath: findChromium() });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("kcsim:settings", JSON.stringify({ useSampleState: true, useEstimates: true }));
  });
  await page.reload();

  const tab = (label: string) => page.getByRole("tab", { name: label, exact: true }).click();
  await tab("パラメータ推定");
  await page.getByText("事前との差").waitFor({ timeout: 30_000 });
  await page.getByText("最終推定:").waitFor({ timeout: 30_000 });
  // ずれの大きい艦を選ぶ
  await page.getByLabel("並び順").selectOption("shift");
  await page.locator("tbody tr").first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT, fullPage: true });
  console.log("saved", OUT);
} finally {
  await browser.close();
  server.kill();
}
