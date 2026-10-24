/**
 * プラグインのビューのスクリーンショット (docs/screenshots/)。`bun run screenshots`。
 * Web UI (web/ の vite) とプラグインの開発用ページ (dev/) を起動し、headless Chromium で
 * 埋め込んだシミュレータ (poi の state が postMessage で届いたこと = 「poi 接続中」)、観測ログ、資源 (1024x600)、送信設定を撮る。
 * ブラウザは playwright のキャッシュにある chromium_headless_shell を使う (CHROMIUM_PATH で上書き可)。
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// SCREENSHOT_OUT で出力先を変えられる (動作確認で docs を汚さないため)
const OUT = process.env.SCREENSHOT_OUT ?? resolve(import.meta.dir, "../../docs/screenshots");
const WEB_PORT = 5198;
const PLUGIN_PORT = 5197;

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

// web の開発サーバは listen の前に sim-core/pkg を作る (web/vite.config.ts の buildWasm)。cargo の初回ビルドも待つ
const startVite = async (cwd: string, port: number) => {
  const proc = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], { cwd, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; !(await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)); i++) {
    if (proc.exitCode !== null) throw new Error(`vite in ${cwd} exited (${proc.exitCode})`);
    if (i > 3000) throw new Error(`vite in ${cwd} did not start`);
    await Bun.sleep(100);
  }
  return proc;
};

mkdirSync(OUT, { recursive: true });
const servers = [
  await startVite(resolve(import.meta.dir, "../../web"), WEB_PORT),
  await startVite(resolve(import.meta.dir, ".."), PLUGIN_PORT),
];

const browser = await chromium.launch({ executablePath: findChromium() });
// 新しいコンテキストは localStorage / IndexedDB が空。旧プラグイン UI のプリセットを 1 件置いて、移行も通す
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  if (location.port !== "5197" || localStorage.getItem("kcsim:plugin") !== null) return;
  const preset = {
    id: "legacy1", name: "旧プラグインの編成", createdAt: 1, updatedAt: 1, fleetType: "single", formation: "line_ahead",
    ships: [{ masterId: 1, level: 99, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [] }], source: "manual",
  };
  localStorage.setItem("kcsim:preset:legacy1", JSON.stringify(preset));
});
const main = await context.newPage();
for (const p of [main]) {
  p.on("pageerror", (e) => console.error("[pageerror]", e.message));
  p.on("console", (m) => m.type() === "error" && console.error("[console.error]", m.text().slice(0, 300)));
}

// poi のウィンドウモードと同じく、開発用ページ (= メインウィンドウ) が子ウィンドウを開いてビューを portal する
const popupOpened = context.waitForEvent("page");
await main.goto(`http://localhost:${PLUGIN_PORT}/?server=${encodeURIComponent(`http://localhost:${WEB_PORT}/`)}`);
const page = await popupOpened;
await page.setViewportSize({ width: 1440, height: 1000 });
page.on("pageerror", (e) => console.error("[pageerror:plugin window]", e.message));

const shot = async (name: string) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("saved", join(OUT, `${name}.png`));
};
const tab = (label: string) => page.getByRole("tab", { name: label, exact: true }).click();
/** ヘッダ (プラグインのタブ列) とタブの位置。どのビューでも同じであること (ビューの中の切り替えタブは数えない) */
const headerBoxes = () =>
  page.evaluate(() => {
    const list = document.querySelector("[role=tablist]")!;
    return [list, ...list.querySelectorAll("[role=tab]")].map((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].join(",");
    }).join(" ");
  });
/** ページ (プラグインのビュー全体と、タブの中身の main) がスクロールしないこと */
const assertNoPageScroll = async (where: string) => {
  const over = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const main = document.querySelector("main");
    return {
      page: doc.scrollHeight - doc.clientHeight,
      main: main ? main.scrollHeight - main.clientHeight : 0,
      wide: doc.scrollWidth - doc.clientWidth,
    };
  });
  if (over.page > 0 || over.main > 0 || over.wide > 0) throw new Error(`${where} scrolls: ${JSON.stringify(over)}`);
};

try {
  // 埋め込んだ Web UI に poi の state (開発用ページではサンプル) が postMessage で届くと、poi の艦隊の取り込みボタンが有効になる。
  // postMessage の送り元は子ウィンドウでなくメインウィンドウ (= 親の opener) で、実機の poi と同じ経路
  const web = page.frameLocator("iframe[title=kc-sim]");
  const preset = web.locator("select").first();
  await preset.waitFor({ timeout: 30_000 });
  // 旧プラグイン UI のプリセットが移行されている
  await web.locator("option", { hasText: "旧プラグインの編成" }).first().waitFor({ state: "attached", timeout: 10_000 });
  const migrated = await main.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("kcsim:presetsMigrated:")));
  console.log("presets migrated:", migrated);
  // 新規プリセットを作り、空の編成に poi の第1艦隊を取り込む
  await web.getByLabel("プリセットの管理").click();
  await web.getByRole("button", { name: "新規" }).click();
  await web.getByTitle("第1艦隊").waitFor({ state: "visible" });
  if (await web.getByTitle("第1艦隊").isDisabled()) throw new Error("poi の艦隊が届いていない (取り込みボタンが無効)");
  await web.getByTitle("第1艦隊").click();
  await web.getByText("大和改二").first().waitFor({ timeout: 10_000 });
  await web.getByText("突破").first().waitFor();
  // 埋め込んだ Web UI の中でも計算が終わり、結果が出る (実行ボタンは計算済みになり、その理由を title に出す)
  await web.locator("span[title^='この入力の']").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(300);
  await shot("19-plugin-embedded");
  // poi (macOS) がプラグインウィンドウ上端に置く drag 帯 (plugin-window-wrapper.js と同じ)。headless では app-region が
  // 効かないので、タブが no-drag であること (= 帯の上でもクリックが届く) を計算済みスタイルで確かめ、帯の上でタブを押す
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.style.position = "absolute";
    div.style.top = "0";
    div.style.height = "23px";
    div.style.width = "100%";
    div.style.setProperty("-webkit-app-region", "drag");
    div.style.setProperty("pointer-events", "none");
    document.body.appendChild(div);
  });
  const regions = await page.evaluate(() =>
    [...document.querySelectorAll("[role=tablist] [role=tab]")].map((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region"))
  );
  if (regions.length === 0 || regions.some((r) => r !== "no-drag")) throw new Error(`plugin tabs are not no-drag: ${regions}`);
  const logTab = await page.getByRole("tab", { name: "観測ログ", exact: true }).boundingBox();
  await page.mouse.click(logTab!.x + logTab!.width / 2, 10);
  if ((await page.getByRole("tab", { name: "観測ログ", exact: true }).getAttribute("aria-selected")) !== "true") throw new Error("観測ログ tab not clickable within the drag strip");
  await tab("シミュレーション");
  console.log("plugin tabs no-drag:", regions.join(","));
  const header = await headerBoxes();
  // 埋め込んだ Web UI はヘッダを描かない (タブ列は左の縦の 1 本だけ)
  if (await web.locator("header").count()) throw new Error("the embedded web UI draws a header");

  // 観測ログ: 戦闘を流し込んでから表示
  await main.evaluate(async () => {
    // dev/main.tsx が公開する開発用の口
    const { capture: cap, captureFixtures: fx, importFromPoi, sampleState: state } = Reflect.get(window, "__kcsimDev");
    const db = new cap.ObservationDb();
    const ships = importFromPoi(state, 0).ships;
    let t = Date.now() - 3600_000;
    const nodes: Record<number, string> = { 1: "Start", 5: "B" };
    const session = new cap.CaptureSession({
      sink: db,
      getFleet: () => ({ deckId: 1, ships }),
      resolveNode: (_a: number, _m: number, cell: number) => nodes[cell],
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
  if ((await headerBoxes()) !== header) throw new Error(`header moved on 観測ログ: ${header} → ${await headerBoxes()}`);
  await page.locator("tbody tr").first().click();
  await page.getByText("攻撃イベント").waitFor();
  await page.waitForTimeout(300);
  await shot("06-log-detail");
  await page.keyboard.press("Escape");

  // 資源: 記録が無いとき (開発用ページ = poi の外) は空の表示、記録を入れると推移と増減
  await tab("資源");
  await page.getByText("資源の記録がありません").waitFor();
  if ((await headerBoxes()) !== header) throw new Error(`header moved on 資源: ${header} → ${await headerBoxes()}`);
  await main.evaluate(async () => {
    const { resources } = Reflect.get(window, "__kcsimDev");
    const db = new resources.ResourceDb();
    for (const s of resources.seedResourceHistory(Date.now())) await db.add(s);
    await db.close();
  });
  await tab("観測ログ");
  await tab("資源");
  await page.getByRole("img", { name: "燃料・弾薬・鋼材・ボーキ" }).waitFor();
  for (const [width, height] of [[1280, 800], [1200, 710], [1024, 600]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    for (const view of ["増減 (日別)", "増減 (イベント)", "推移"]) {
      await page.getByRole("tab", { name: view, exact: true }).click();
      await assertNoPageScroll(`資源 ${view} at ${width}x${height}`);
    }
  }
  console.log("資源: no page scroll at 1280x800 / 1200x710 / 1024x600");
  // 1024x600 で、推移 (1 月) にポインタを当てた状態と、イベントごとの増減を撮る
  await page.getByRole("tab", { name: "1月", exact: true }).click();
  const chart = (await page.getByRole("img", { name: "燃料・弾薬・鋼材・ボーキ" }).boundingBox())!;
  await page.mouse.move(chart.x + chart.width * 0.7, chart.y + chart.height * 0.5);
  await page.waitForTimeout(200);
  await shot("20-plugin-resources");
  await page.getByRole("tab", { name: "1週", exact: true }).click();
  await page.getByRole("tab", { name: "増減 (イベント)", exact: true }).click();
  await page.waitForTimeout(200);
  await shot("21-plugin-resources-delta");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await tab("送信設定");
  await page.getByText("観測ログを自動送信").waitFor();
  await page.waitForTimeout(300);
  await shot("08-plugin-upload");
  if ((await headerBoxes()) !== header) throw new Error(`header moved on 送信設定: ${header} → ${await headerBoxes()}`);
  console.log("header identical in シミュレーション / 観測ログ / 資源 / 送信設定:", header);
} finally {
  await browser.close();
  servers.forEach((s) => s.kill());
}
