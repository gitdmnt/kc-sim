/**
 * UI 監査: 各タブを 1440px / 800px 幅で開き、console の error/warning と横スクロール (はみ出し) を検出して
 * /tmp/kcsim-audit/*.png に保存する。`bun scripts/audit.ts [--offline]` (data API 稼働前提、--offline は API を無効化)
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const OUT = "/tmp/kcsim-audit";
const PORT = 5233;
const offline = process.argv.includes("--offline");
mkdirSync(OUT, { recursive: true });

const findChromium = (): string => {
  const base = join(homedir(), "Library/Caches/ms-playwright");
  for (const d of readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell")).sort().reverse())
    for (const sub of readdirSync(join(base, d))) {
      const exe = join(base, d, sub, "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
  throw new Error("no chromium");
};

const server = Bun.spawn(["bun", "dev/server.ts", "--port", String(PORT)], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit" });
{
  const dec = new TextDecoder();
  for await (const c of server.stdout as any) if (dec.decode(c).includes("Local:")) break;
}
const browser = await chromium.launch({ executablePath: findChromium() });
const problems: string[] = [];
try {
  for (const width of [1440, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    let where = "";
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !(offline && /Failed to load resource|ERR_/.test(m.text())) && problems.push(`[${width} ${where}] console.${m.type()}: ${m.text().slice(0, 200)}`));
    page.on("pageerror", (e) => problems.push(`[${width} ${where}] pageerror: ${e.message.slice(0, 200)}`));
    await page.goto(`http://localhost:${PORT}/`);
    await page.evaluate(async (off) => {
      localStorage.clear();
      if (off) localStorage.setItem("kcsim:settings", JSON.stringify({ apiBase: "http://127.0.0.1:9" }));
    }, offline);
    await page.reload();
    const tabs = ["艦隊編成", "海域", "敵艦データ", "シミュレーション", "パラメータ推定", "観測ログ", "設定"];
    // 先に第1/3艦隊を取り込んでおく
    for (const t of tabs) {
      where = t;
      await page.getByRole("tab", { name: t, exact: true }).click();
      if (t === "艦隊編成") {
        await page.getByTitle("第3艦隊").click();
        await page.getByTitle("第1艦隊").click();
      }
      await page.waitForTimeout(1800);
      const over = await page.evaluate(() => {
        const bad: string[] = [];
        const w = document.documentElement.clientWidth;
        document.querySelectorAll(".kcsim *").forEach((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.right > w + 1 && !(el as HTMLElement).closest("svg,.overflow-auto,.overflow-x-auto,.overflow-scroll,[role=listbox]")) bad.push(`${el.tagName}.${String((el as HTMLElement).className).slice(0, 40)} right=${Math.round(r.right)}`);
        });
        return { scrollW: document.documentElement.scrollWidth, w, bad: bad.slice(0, 4) };
      });
      if (over.scrollW > over.w + 1 || over.bad.length) problems.push(`[${width} ${t}] overflow scrollW=${over.scrollW} > ${over.w}: ${over.bad.join(" | ")}`);
      await page.screenshot({ path: join(OUT, `${offline ? "off-" : ""}${width}-${t}.png`), fullPage: true });
    }
    if (width === 1440 && !offline) {
      // タブ間の遷移
      where = "flows";
      const expect = (cond: boolean, msg: string) => cond || problems.push(`[flow] ${msg}`);
      await page.getByRole("tab", { name: "海域", exact: true }).click();
      await page.getByRole("button", { name: "ノード F" }).click();
      await page.getByRole("button", { name: "このノードでシミュレーション" }).click();
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => [...document.querySelectorAll("select")].some((s) => s.value === "F")), "海域→シミュレーション: ノード F が選択されない");
      await page.getByRole("tab", { name: "艦隊編成", exact: true }).click();
      await page.getByRole("button", { name: "出撃シミュ", exact: true }).click();
      await page.getByText("出撃設定", { exact: true }).waitFor({ timeout: 5000 }).catch(() => expect(false, "艦隊編成→出撃シミュ: 出撃タブに遷移しない"));
      await page.getByRole("tab", { name: "敵艦データ", exact: true }).click();
      await page.getByPlaceholder("名前・ID で検索").fill("駆逐ロ級");
      await page.getByRole("button", { name: /駆逐ロ級/ }).first().click();
      await page.getByRole("button", { name: "推定の詳細を見る" }).click();
      await page.waitForTimeout(1500);
      expect(await page.getByRole("tab", { name: "パラメータ推定", exact: true }).getAttribute("aria-selected") === "true", "敵艦データ→推定: タブが切り替わらない");
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(problems.length ? problems.join("\n") : "no problems detected");
