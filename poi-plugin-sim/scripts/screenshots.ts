/**
 * プラグインのビューのスクリーンショット (docs/screenshots/)。`bun run screenshots`。
 * Web UI (web/ の vite) とプラグインの開発用ページ (dev/) を起動し、headless Chromium で
 * 埋め込んだシミュレータ (poi の state が postMessage で届いたこと = 「poi 接続中」)、観測ログ、任務、資源、送信設定を
 * 1024x600 で撮る。macOS のプラグインウィンドウを再現する (poi の上端 23px の drag 帯と左上の信号ボタンを重ねて描く)。
 * 確かめること: 枠 (左のバーと上の行の位置) がどの機能・画面でも同じ、信号ボタンの下にタブ・バーの項目が無い、
 * drag 帯にかかるタブは no-drag、プラグインのタブで iframe の画面が変わり Web UI 側の遷移 (海域 →「出撃シミュ」) が
 * プラグインのタブに戻ってくる、埋め込んだ Web UI は枠を描かない、1280x800 / 1200x710 / 1024x600 でページ
 * (プラグインと iframe の中) がスクロールしない。
 * ブラウザは playwright のキャッシュにある chromium_headless_shell を使う (CHROMIUM_PATH で上書き可)。
 * 任務は Web UI の開発サーバが中継するデータ API (KCSIM_API、既定 127.0.0.1:8787) の /api/v1/quests を使う。
 * MAPS_FROM_BUNDLES=1 なら海域のデータ (/api/v1/views/map/*) だけ API を通さず、Web UI の代替の静的バンドル (/maps) を
 * 使わせる (手元の D1 に KCNav の敵編成が無いと出撃の結果が 0% になるため)。
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// SCREENSHOT_OUT で出力先を変えられる (動作確認で docs を汚さないため)
const OUT = process.env.SCREENSHOT_OUT ?? resolve(import.meta.dir, "../../docs/screenshots");
const WEB_PORT = 5198;
const PLUGIN_PORT = 5197;
const SIZES = [[1280, 800], [1200, 710], [1024, 600]] as const;
/** docs の画像の大きさ */
const DOC = { width: 1024, height: 600 };
/** macOS の信号ボタン (閉じる/最小化/拡大) が占める左上の範囲 */
const BUTTONS = { width: 120, height: 42 };
/** 任務タブで選んでおく任務 (A88 最精鋭甲型駆逐艦、集結せよ！: 前提が多い) */
const QUEST = 193;

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
await context.addInitScript(
  ({ quest, webPort }) => {
    // iframe の Web UI (別オリジン): 任務タブで開く任務
    if (location.port === String(webPort)) {
      if (localStorage.getItem("kcsim:quest") === null) localStorage.setItem("kcsim:quest", String(quest));
      return;
    }
    if (location.port !== "5197" || localStorage.getItem("kcsim:plugin") !== null) return;
    const preset = {
      id: "legacy1", name: "旧プラグインの編成", createdAt: 1, updatedAt: 1, fleetType: "single", formation: "line_ahead",
      ships: [{ masterId: 1, level: 99, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [] }], source: "manual",
    };
    localStorage.setItem("kcsim:preset:legacy1", JSON.stringify(preset));
  },
  { quest: QUEST, webPort: WEB_PORT }
);
if (process.env.MAPS_FROM_BUNDLES) await context.route("**/api/v1/views/map/**", (r) => r.abort());
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
/** 枠のタブ (左のバーの機能、上の行の画面) か、画面の中の切り替え */
const tab = (label: string) => page.getByRole("tab", { name: label, exact: true }).first().click();
const isSelected = async (label: string) =>
  (await page.getByRole("tab", { name: label, exact: true }).first().getAttribute("aria-selected")) === "true";
const web = page.frameLocator("iframe[title=kc-sim]");
const webFrame = () => {
  const f = page.frames().find((x) => x.url().startsWith(`http://localhost:${WEB_PORT}/`));
  if (!f) throw new Error("the web UI's iframe is not loaded");
  return f;
};

/** 枠の位置: 左のバーの項目と、上の行の最初の項目 (タブ列か見出し) の位置。どの機能・画面でも同じであること */
const chromeBoxes = () =>
  page.evaluate(() => {
    const bar = document.querySelector("[role=tablist][aria-orientation=vertical]")!;
    const top = document.querySelector("[role=tablist]:not([aria-orientation]), h1")!.getBoundingClientRect();
    const items = [bar, ...bar.querySelectorAll("[role=tab]")].map((el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].join(",");
    });
    // 上の行はタブ列か見出し (縦の位置は高さが違うので比べない。行の高さはバーの位置に出る)
    return `${items.join(" ")} | top x ${top.x}`;
  });

/** 信号ボタンの下に枠のタブ・見出しが無く、drag 帯 (上端 23px) にかかるタブは no-drag */
const assertClearOfWindowButtons = async (where: string) => {
  const bad = await page.evaluate(
    ({ width, height }) =>
      [...document.querySelectorAll("[role=tab], h1")].flatMap((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return [];
        const style = getComputedStyle(el);
        const region = style.getPropertyValue("-webkit-app-region") || style.getPropertyValue("app-region");
        const under = r.left < width && r.top < height;
        const dragged = el.getAttribute("role") === "tab" && r.top < 23 && region !== "no-drag";
        return under || dragged ? [`${el.textContent} at ${Math.round(r.left)},${Math.round(r.top)} (${region})`] : [];
      }),
    BUTTONS
  );
  if (bad.length) throw new Error(`${where}: under the window buttons or not clickable in the drag strip: ${bad.join("; ")}`);
};

/** ページ (プラグインのビュー全体と、プラグインの画面の main。Web UI の画面なら iframe の中の文書と main) がスクロールしないこと */
const assertNoPageScroll = async (where: string, inFrame = false) => {
  const measure = () => {
    const doc = document.scrollingElement!;
    const main = document.querySelector("main");
    return {
      page: doc.scrollHeight - doc.clientHeight,
      main: main ? main.scrollHeight - main.clientHeight : 0,
      wide: doc.scrollWidth - doc.clientWidth,
    };
  };
  for (const [name, over] of [["plugin", await page.evaluate(measure)], ...(inFrame ? [["iframe", await webFrame().evaluate(measure)] as const] : [])] as const) {
    if (over.page > 0 || over.main > 0 || over.wide > 0) throw new Error(`${where} (${name}) scrolls: ${JSON.stringify(over)}`);
  }
};
const atEverySize = async (where: string, inFrame: boolean, check?: () => Promise<void>) => {
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    await assertNoPageScroll(`${where} at ${width}x${height}`, inFrame);
    await check?.();
  }
  console.log(`${where}: no page scroll at ${SIZES.map((s) => s.join("x")).join(" / ")}`);
};

try {
  // 埋め込んだ Web UI に poi の state (開発用ページではサンプル) が postMessage で届くと、poi の艦隊の取り込みボタンが有効になる。
  // postMessage の送り元は子ウィンドウでなくメインウィンドウ (= 親の opener) で、実機の poi と同じ経路
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
  // ボスに届く海域 (同梱サンプルの第1艦隊で) に替え、その結果が出るまで待つ (結果の欄が変わり、計算済みになる)
  const before = await webFrame().evaluate(() => (document.querySelector("[data-results]") as HTMLElement).innerText);
  await web.getByLabel("海域").selectOption("4-2");
  await webFrame().waitForFunction(
    (prev) =>
      (document.querySelector("[data-results]") as HTMLElement).innerText !== prev &&
      !document.querySelector("[role=progressbar]") &&
      !!document.querySelector("span[title^='この入力の']"),
    before,
    { timeout: 120_000 }
  );
  // 埋め込んだ Web UI は枠を描かない (左のバーも上の行もプラグインのもの 1 つだけ)
  if (await web.locator("[role=tablist][aria-orientation=vertical]").count()) throw new Error("the embedded web UI draws its activity bar");
  if (await web.getByRole("img", { name: "艦これ シミュレータ" }).count()) throw new Error("the embedded web UI draws its top row");

  // poi (macOS) のプラグインウィンドウ: 上端 23px の drag 帯 (plugin-window-wrapper.js と同じ) と左上の信号ボタン。
  // headless では app-region が効かないので、タブが no-drag であること (= 帯の上でもクリックが届く) を計算済みスタイルで
  // 確かめ、帯の上でタブを押す。信号ボタンは見た目の再現 (クリックは通す)
  await page.evaluate(({ width, height }) => {
    const strip = document.createElement("div");
    strip.style.cssText = "position:absolute;top:0;left:0;width:100%;height:23px;pointer-events:none;z-index:100";
    strip.style.setProperty("-webkit-app-region", "drag");
    const buttons = document.createElement("div");
    buttons.style.cssText = `position:absolute;top:0;left:0;width:${width}px;height:${height}px;pointer-events:none;z-index:101`;
    ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
      const dot = document.createElement("div");
      dot.style.cssText = `position:absolute;top:8px;left:${14 + i * 20}px;width:12px;height:12px;border-radius:50%;background:${c}`;
      buttons.appendChild(dot);
    });
    document.body.append(strip, buttons);
  }, BUTTONS);
  await page.setViewportSize(DOC);
  await page.waitForTimeout(300);
  const logTab = await page.getByRole("tab", { name: "観測ログ", exact: true }).boundingBox();
  await page.mouse.click(logTab!.x + logTab!.width / 2, 10);
  if (!(await isSelected("観測ログ"))) throw new Error("観測ログ tab not clickable within the drag strip");
  await tab("出撃");
  await assertClearOfWindowButtons("シミュレーション / 出撃");
  await page.waitForTimeout(300);
  await shot("19-plugin-embedded");
  const chrome = await chromeBoxes();
  console.log("chrome:", chrome);
  await atEverySize("シミュレーション / 出撃", true);

  // プラグインのタブで iframe の画面が変わり、Web UI 側の遷移 (海域 →「出撃シミュ」) はプラグインのタブに戻ってくる
  await tab("海域");
  await web.getByRole("button", { name: "出撃シミュ" }).click({ timeout: 30_000 });
  await page.waitForTimeout(300);
  if (!(await isSelected("出撃"))) throw new Error("the web UI's move to 出撃 did not reach the plugin's tabs");
  await web.getByText("突破").first().waitFor();
  await tab("計算設定");
  await web.getByText("サーバの推定値を使う").waitFor();
  console.log("view sync: plugin → iframe (海域, 計算設定), iframe → plugin (出撃シミュ)");

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
  if ((await chromeBoxes()) !== chrome) throw new Error(`chrome moved on 観測ログ: ${chrome} → ${await chromeBoxes()}`);
  await atEverySize("シミュレーション / 観測ログ", false);
  await page.setViewportSize(DOC);
  await page.locator("tbody tr").first().click();
  await page.getByText("攻撃イベント").waitFor();
  await page.waitForTimeout(300);
  await shot("06-log-detail");
  await page.keyboard.press("Escape");

  await tab("送信設定");
  await page.getByText("観測ログを自動送信").waitFor();
  await page.waitForTimeout(300);
  await shot("08-plugin-upload");
  if ((await chromeBoxes()) !== chrome) throw new Error(`chrome moved on 送信設定: ${chrome} → ${await chromeBoxes()}`);

  // 任務 (Web UI の画面、ローカルタブ無し: 上の行は見出し)
  await tab("任務");
  await web.getByRole("list", { name: "前提任務" }).waitFor({ timeout: 30_000 });
  await assertClearOfWindowButtons("任務");
  if ((await chromeBoxes()) !== chrome) throw new Error(`chrome moved on 任務: ${chrome} → ${await chromeBoxes()}`);
  await page.waitForTimeout(300);
  await shot("22-plugin-quests");
  await atEverySize("任務", true);
  await page.setViewportSize(DOC);

  // 資源: 記録が無いとき (開発用ページ = poi の外) は空の表示、記録を入れると推移と増減
  await tab("資源");
  await page.getByText("資源の記録がありません").waitFor();
  await assertClearOfWindowButtons("資源");
  if ((await chromeBoxes()) !== chrome) throw new Error(`chrome moved on 資源: ${chrome} → ${await chromeBoxes()}`);
  await main.evaluate(async () => {
    const { resources } = Reflect.get(window, "__kcsimDev");
    const db = new resources.ResourceDb();
    for (const s of resources.seedResourceHistory(Date.now())) await db.add(s);
    await db.close();
  });
  // 機能を切り替えて戻ると読み直す (最後に開いていた画面 = 推移に戻る)
  await tab("シミュレーション");
  if (!(await isSelected("送信設定"))) throw new Error("シミュ did not return to its last view (送信設定)");
  await tab("資源");
  await page.getByRole("img", { name: "燃料・弾薬・鋼材・ボーキ" }).waitFor();
  await atEverySize("資源", false, async () => {
    for (const view of ["増減 (日別)", "増減 (イベント)", "推移"]) {
      await tab(view);
      await assertNoPageScroll(`資源 ${view}`);
    }
  });
  await page.setViewportSize(DOC);
  await page.waitForTimeout(200);
  // 推移 (1 月) にポインタを当てた状態と、イベントごとの増減を撮る
  await tab("1月");
  const chart = (await page.getByRole("img", { name: "燃料・弾薬・鋼材・ボーキ" }).boundingBox())!;
  await page.mouse.move(chart.x + chart.width * 0.7, chart.y + chart.height * 0.5);
  await page.waitForTimeout(200);
  await shot("20-plugin-resources");
  await tab("1週");
  await tab("増減 (イベント)");
  await page.waitForTimeout(200);
  await shot("21-plugin-resources-delta");

  // 全体の設定 (バーの下端の歯車): Web UI の設定画面
  await tab("設定");
  await web.getByText("データキャッシュ").waitFor();
  if ((await chromeBoxes()) !== chrome) throw new Error(`chrome moved on 設定: ${chrome} → ${await chromeBoxes()}`);
  console.log("chrome identical in シミュ (出撃 / 観測ログ / 送信設定) / 任務 / 資源 / 設定");
} finally {
  await browser.close();
  servers.forEach((s) => s.kill());
}
