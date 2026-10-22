/**
 * dev サーバを起動し、headless Chromium で各タブのスクリーンショットを docs/screenshots/ に保存する。
 * `bun run screenshots`。ブラウザは playwright のキャッシュにある chromium_headless_shell を使う
 * (CHROMIUM_PATH で上書き可)。
 */
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(import.meta.dir, "../../docs/screenshots");
const PORT = 5199;
const URL = `http://localhost:${PORT}/`;

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

const server = Bun.spawn(["bun", "dev/server.ts", "--port", String(PORT)], {
  cwd: resolve(import.meta.dir, ".."),
  stdout: "pipe",
  stderr: "pipe",
});
const ready = (async () => {
  const dec = new TextDecoder();
  for await (const chunk of server.stdout as any) {
    if (dec.decode(chunk).includes("Local:")) return;
  }
  throw new Error("dev server exited");
})();
await ready;

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.error("[console.error]", m.text().slice(0, 300)));

const shot = async (name: string, opts: { fullPage?: boolean } = {}) => {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: opts.fullPage ?? false });
  console.log("saved", `${name}.png`);
};
const tab = (label: string) => page.getByRole("tab", { name: label, exact: true }).click();

try {
  await page.goto(URL);
  await page.evaluate(async () => {
    localStorage.clear();
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name!); q.onsuccess = q.onerror = q.onblocked = () => r(null); })));
  });
  await page.reload();
  await page.getByText("プリセットがありません").waitFor();
  await shot("00-fleet-empty");

  // poi の第1艦隊を取り込む → 編集画面
  await page.getByTitle("第1艦隊").click();
  await page.getByText("第1艦隊を取り込みました").waitFor();
  await page.waitForTimeout(300);
  console.log("body margin:", await page.evaluate(() => getComputedStyle(document.body).margin));
  await shot("01-fleet-editor");
  await shot("01b-fleet-editor-full", { fullPage: true });

  await page.waitForTimeout(3700); // トースト消滅待ち

  // 艦ピッカー
  await page.getByLabel("1番艦").click();
  await page.getByPlaceholder("名前・読みで検索").fill("やまと");
  await page.waitForTimeout(150);
  await shot("02-fleet-ship-picker");
  await page.keyboard.press("Escape");

  // 装備ピッカー
  await page.getByLabel("#1 装備").first().click();
  await page.getByPlaceholder("名前・読みで検索").fill("46");
  await page.waitForTimeout(150);
  await shot("03-fleet-equip-picker");
  await page.keyboard.press("Escape");

  // 入出力モーダル (DeckBuilder 書き出し)
  await page.getByRole("button", { name: "入出力" }).click();
  await page.getByRole("tab", { name: "デッキビルダー" }).click();
  await page.waitForTimeout(150);
  await shot("04-fleet-io-deckbuilder");
  await page.keyboard.press("Escape");

  // 観測ログ: 戦闘を流し込んでから表示
  await page.evaluate(async () => {
    // dev/main.tsx が公開する開発用の口
    const { capture: cap, captureFixtures: fx, fleet: fleetMod, sampleState: state } = Reflect.get(window, "__kcsimDev");
    const db = new cap.ObservationDb();
    const ships = fleetMod.importFromPoi(state, 0).ships;
    let t = Date.now() - 3600_000;
    const session = new cap.CaptureSession({
      sink: db,
      getFleet: () => ({ deckId: 1, ships }),
      resolveNode: (_a: number, _m: number, cell: number) => ({ 1: "Start", 5: "B" } as any)[cell],
      now: () => (t += 60_000),
    });
    for (const [map, area] of [[2, 1], [4, 5]]) {
      await session.handle("/kcsapi/api_req_map/start", { ...fx.mapStart, api_maparea_id: area, api_mapinfo_no: map }, { api_deck_id: "1" });
      await session.handle("/kcsapi/api_req_map/next", { ...fx.mapNext, api_maparea_id: area, api_mapinfo_no: map }, {});
      await session.handle("/kcsapi/api_req_sortie/battle", fx.dayBattle, {});
      await session.handle("/kcsapi/api_req_sortie/battleresult", { ...fx.battleResult, api_win_rank: map === 2 ? "S" : "B" });
      await session.handle("/kcsapi/api_req_battle_midnight/battle", fx.midnightBattle, {});
    }
    await db.close();
  });
  await tab("観測ログ");
  await page.getByText("昼戦").first().waitFor();
  await page.waitForTimeout(200);
  await shot("05-log-list");
  await page.locator("tbody tr").first().click();
  await page.getByText("攻撃イベント").waitFor();
  await page.waitForTimeout(300);
  await shot("06-log-detail");
  await page.keyboard.press("Escape");

  // データ API (server が localhost:8787 で動いている場合のみ)
  const apiUp = await fetch("http://127.0.0.1:8787/api/v1/health").then((r) => r.ok, () => false);
  if (apiUp) {
    await tab("海域");
    await page.locator("select").nth(1).selectOption("1-5");
    await page.getByRole("button", { name: "ノード D" }).waitFor();
    await page.getByRole("button", { name: "ノード D" }).click();
    await page.waitForTimeout(300);
    await shot("09-map-routing");
    await page.getByRole("button", { name: "ノード J" }).click();
    await page.getByText("試行").first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    await shot("10-map-enemy-comps", { fullPage: true });

    await tab("敵艦データ");
    await page.getByPlaceholder("名前・ID で検索").fill("駆逐イ級");
    await page.getByRole("button", { name: /駆逐イ級/ }).first().click();
    await page.getByText("隠しステータス推定").waitFor();
    await page.waitForTimeout(300);
    await shot("11-enemy-detail", { fullPage: true });
  } else {
    console.warn("server not running on :8787; skipping map/enemy screenshots");
  }

  if (apiUp) {
    // 出撃シミュレーション: 対潜編成 (五十鈴改二 + 駆逐3) で 1-5
    await tab("艦隊編成");
    await page.getByTitle("第3艦隊").click();
    await page.getByText("第3艦隊を取り込みました").waitFor();
    await tab("シミュレーション");
    await page.getByRole("tab", { name: "出撃", exact: true }).click();
    await page.getByText("出撃設定", { exact: true }).waitFor();
    await page.waitForFunction(() => document.body.innerText.includes("1-5"));
    await page.locator("select").first().selectOption({ label: "第3艦隊 (4隻)" });
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "実行", exact: true }).click();
    await page.getByText("ボス到達率").waitFor({ timeout: 180000 });
    await page.waitForTimeout(700);
    const t = await page.locator("main").innerText();
    console.log("---- sortie numbers ----\n" + t.slice(t.indexOf("ボス到達率")).split("\n").slice(0, 120).join(" | "));
    await shot("15-sim-sortie", { fullPage: true });
  }

  await tab("設定");
  await page.waitForTimeout(200);
  await shot("07-settings");

  if (apiUp) {
    await tab("シミュレーション");
    await page.getByText("戦闘設定", { exact: true }).waitFor();
    // 1-5 / J / 全編成 / 10k 戦 (既定値)。ノード選択が読み込まれるのを待つ
    await page.waitForFunction(() => [...document.querySelectorAll("select")].some((s) => s.value === "J"));
    await page.getByRole("button", { name: "実行", exact: true }).click();
    await page.getByText("勝敗判定", { exact: true }).waitFor({ timeout: 120000 });
    await page.waitForTimeout(500);
    const text = await page.locator("main").innerText();
    console.log("---- sim numbers ----\n" + text.split("\n").slice(0, 60).join(" | "));
    await shot("12-sim-battle", { fullPage: true });
  }
  // 狭いプラグインウィンドウ (800px 幅) の確認
  await page.setViewportSize({ width: 800, height: 900 });
  await tab("艦隊編成");
  await page.waitForTimeout(400);
  await shot("17-narrow-fleet");
  if (apiUp) {
    await tab("海域");
    await page.getByRole("button", { name: "ノード D" }).click();
    await page.waitForTimeout(1200);
    await shot("18-narrow-map");
  }
} finally {
  await browser.close();
  server.kill();
}
