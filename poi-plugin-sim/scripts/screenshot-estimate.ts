/**
 * パラメータ推定タブのスクリーンショット (docs/screenshots/16-estimate.png)。
 * dev サーバ (port 5211) を起動し、設定タブの「合成データ投入」で runBattle のログから観測を作ってから推定する。
 * data API (settings の apiBase、既定 http://127.0.0.1:8787) が動いていること。`bun scripts/screenshot-estimate.ts`
 */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

const server = Bun.spawn(["bunx", "vite", "--port", String(PORT), "--strictPort"], {
  cwd: resolve(import.meta.dir, ".."),
  stdout: "pipe",
  stderr: "inherit",
});
const decoder = new TextDecoder();
const reader = server.stdout.getReader();
for (let buf = ""; !buf.includes("Local:"); ) {
  const { value, done } = await reader.read();
  if (done) throw new Error("vite exited");
  buf += decoder.decode(value);
}

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
  await tab("設定");
  await page.getByRole("button", { name: "合成データ投入" }).click();
  await page.getByText(/合成の戦闘 \d+ 件を投入しました/).waitFor({ timeout: 120_000 });
  await page.getByText(/合成の戦闘 \d+ 件を投入しました/).waitFor({ state: "detached", timeout: 30_000 });

  await tab("パラメータ推定");
  await page.getByRole("button", { name: "推定を実行" }).first().click();
  await page.getByText("事前との差").waitFor({ timeout: 120_000 });
  await page.getByText("最終推定:").waitFor({ timeout: 120_000 });
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
