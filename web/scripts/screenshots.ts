/**
 * Web UI の開発サーバ (vite) を起動し、headless Chromium で各画面のスクリーンショットを撮る。
 * `bun run screenshots`。出力は SHOTS_DIR (既定 docs/screenshots)、ファイル名の頭に SHOTS_PREFIX を付ける。
 * データ API は vite が KCSIM_API (既定 127.0.0.1:8787) に中継し、落ちていれば静的バンドル (server/dist/maps) を使う。
 * ブラウザは playwright のキャッシュにある chromium_headless_shell を使う (CHROMIUM_PATH で上書き可)。
 * 出撃タブはページがスクロールしないこと (scrollHeight <= innerHeight) を 1280×800 と 1200×710 で確かめる。
 */
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { startDevServer } from "./devServer";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(process.env.SHOTS_DIR ?? resolve(import.meta.dir, "../../docs/screenshots"));
const PREFIX = process.env.SHOTS_PREFIX ?? "";
const PORT = 5199;
const URL = `http://localhost:${PORT}/`;
/** 出撃結果を撮る海域 (同梱サンプルの第1艦隊でボスに届く) */
const MAP = process.env.SHOTS_MAP ?? "4-2";

const findChromium = (): string => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell")).sort() : [];
  for (const d of dirs.reverse()) {
    const dir = join(base, d);
    for (const sub of readdirSync(dir)) {
      const exe = join(dir, sub, "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error("chromium_headless_shell not found; set CHROMIUM_PATH");
};

mkdirSync(OUT, { recursive: true });

const server = await startDevServer(PORT, process.env.KCSIM_API);
const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

const shot = async (name: string, opts: { fullPage?: boolean } = {}) => {
  await page.screenshot({ path: join(OUT, `${PREFIX}${name}.png`), fullPage: opts.fullPage ?? false });
  console.log("saved", `${PREFIX}${name}.png`);
};
// 「出撃」はヘッダのタブとモード切り替えの両方にある。ヘッダが先
const tab = (label: string) => page.getByRole("tab", { name: label, exact: true }).first().click();

/** 結果パネルの実行情報 (title = "seed … · 秒") が変わり、進捗バーが消えるまで待つ */
const meta = (p: Page) =>
  p.evaluate(() => {
    const m = document.querySelector("span[title^='seed']");
    return m ? `${m.getAttribute("title")} ${m.textContent}` : "";
  });
const waitResult = async (prev: string) => {
  await page.waitForFunction(
    (p) => {
      const m = document.querySelector("span[title^='seed']");
      return !!m && `${m.getAttribute("title")} ${m.textContent}` !== p && !document.querySelector("[role=progressbar]");
    },
    prev,
    { timeout: 180_000 }
  );
  await page.waitForTimeout(300);
};

const checkNoScroll = async (label: string) => {
  const [sh, ih] = await page.evaluate(() => [document.scrollingElement!.scrollHeight, innerHeight]);
  console.log(`${label}: scrollHeight ${sh} <= innerHeight ${ih}: ${sh <= ih}`);
  if (sh > ih) throw new Error(`${label}: page scrolls`);
};

try {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByText("1番艦を追加").waitFor();
  await shot("00-workspace-empty");

  // poi の第1艦隊 (6 隻) を取り込み、海域を選ぶ → 自動で計算される
  await page.getByTitle("第1艦隊").first().click();
  await waitResult("");
  let prev = await meta(page);
  await page.getByLabel("海域").selectOption(MAP);
  await waitResult(prev);
  console.log("auto:", await meta(page));
  prev = await meta(page);
  await page.getByRole("button", { name: /^実行/ }).click();
  await waitResult(prev);
  console.log("manual:", await meta(page));
  const kpi = await page.locator("[data-results]").first().innerText();
  console.log("---- sortie ----\n" + kpi.split("\n").slice(0, 24).join(" | "));
  await checkNoScroll("1280x800");
  await shot("workspace-1280");

  // poi のプラグインウィンドウ相当 (1200×750 からタブ分を引いた高さ)
  await page.setViewportSize({ width: 1200, height: 710 });
  await page.waitForTimeout(400);
  await checkNoScroll("1200x710");
  await shot("workspace-1200");
  await page.setViewportSize({ width: 1280, height: 800 });

  // 艦ピッカー・装備ピッカー
  await page.getByLabel("1番艦", { exact: true }).click();
  await page.getByPlaceholder("名前・読みで検索").fill("やまと");
  await page.waitForTimeout(150);
  await shot("02-ship-picker");
  await page.keyboard.press("Escape");
  await page.getByLabel("#1 装備").nth(5).click();
  await page.waitForTimeout(150);
  await shot("03-equip-picker");
  await page.keyboard.press("Escape");

  // 艦の詳細・条件・プリセット管理
  await page.getByLabel("1番艦の詳細").click();
  await page.waitForTimeout(150);
  await shot("04-ship-detail");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "条件" }).click();
  await page.waitForTimeout(150);
  await shot("05-conditions");
  await page.keyboard.press("Escape");
  await page.getByLabel("プリセットの管理").click();
  await page.getByRole("button", { name: "入出力" }).click();
  await page.getByRole("tab", { name: "デッキビルダー" }).click();
  await page.waitForTimeout(150);
  await shot("06-io-deckbuilder");
  await page.keyboard.press("Escape");

  // 詳細タブ (経路図)
  await page.getByRole("tab", { name: "経路", exact: true }).click();
  await page.waitForTimeout(200);
  await shot("07-workspace-route");

  // 単一マス戦闘 (ボス)
  prev = await meta(page);
  await page.getByRole("tab", { name: "単一戦闘", exact: true }).click();
  await waitResult(prev);
  await checkNoScroll("battle 1280x800");
  await shot("08-workspace-battle");
  await page.getByRole("tab", { name: "出撃", exact: true }).first().click();

  // 海域タブ
  await tab("海域");
  await page.getByRole("button", { name: "ノード D" }).first().waitFor({ timeout: 20_000 }).catch(() => {});
  if (await page.getByRole("button", { name: "ノード D" }).count()) {
    await page.getByRole("button", { name: "ノード D" }).first().click();
    await page.waitForTimeout(300);
    await shot("09-map-routing");
  }

  const apiUp = await fetch(`${process.env.KCSIM_API ?? "http://127.0.0.1:8787"}/api/v1/health`).then((r) => r.ok, () => false);
  if (apiUp) {
    await tab("敵艦");
    await page.getByPlaceholder("名前・ID で検索").fill("駆逐イ級");
    await page.getByRole("button", { name: /駆逐イ級/ }).first().click();
    await page.waitForTimeout(500);
    await shot("11-enemy-detail", { fullPage: true });
  } else {
    console.warn("data API is down; skipping the enemy screenshot");
  }

  await tab("設定");
  await page.waitForTimeout(200);
  await shot("12-settings");

  // 最悪の高さ: 装備 5 枠の艦 6 隻 (第1艦隊の 1〜4 番艦を並べる)。枠の中だけスクロールし、ページは動かない
  await tab("出撃");
  await page.setViewportSize({ width: 1200, height: 710 });
  await page.evaluate(() => {
    const sel = localStorage.getItem("kcsim:selectedPreset")!;
    const p = JSON.parse(localStorage.getItem(`kcsim:preset:${sel}`)!);
    const ships = [0, 1, 2, 3, 0, 1].map((i) => p.ships[i]);
    localStorage.setItem("kcsim:preset:worst", JSON.stringify({ ...p, id: "worst", name: "5枠×6", ships }));
    localStorage.setItem("kcsim:selectedPreset", "worst");
    localStorage.setItem("kcsim:workspace", JSON.stringify({ ...JSON.parse(localStorage.getItem("kcsim:workspace") ?? "{}"), mode: "sortie" }));
  });
  await page.reload();
  await waitResult("");
  await checkNoScroll("1200x710 six 5-slot ships");
  await shot("workspace-1200-worst");
  // さらに低い画面では艦の枠の中だけスクロールする
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.waitForTimeout(300);
  await checkNoScroll("1024x600 six 5-slot ships");

  // 狭いウィンドウ (800px 幅): 1 列に積んでページをスクロールする
  await page.setViewportSize({ width: 800, height: 900 });
  await tab("出撃");
  await page.waitForTimeout(400);
  await shot("17-narrow-workspace");
} finally {
  await browser.close();
  server.kill();
}
