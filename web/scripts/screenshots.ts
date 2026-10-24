/**
 * Web UI の開発サーバ (vite) を起動し、headless Chromium で各画面のスクリーンショットを撮る。
 * `bun run screenshots`。出力は SHOTS_DIR (既定 docs/screenshots)、ファイル名の頭に SHOTS_PREFIX を付ける。
 * docs に置いているのは 23-web-sortie (ブラウザで開いた 出撃、1024×600) だけで、他は確認用。
 * データ API は vite が KCSIM_API (既定 127.0.0.1:8787) に中継し、落ちていれば静的バンドル (server/dist/maps) を使う。
 * ブラウザは playwright のキャッシュにある chromium_headless_shell を使う (CHROMIUM_PATH で上書き可)。
 * 枠: 左のバーは シミュ / 任務 / 設定 (資源はプラグインだけ)、シミュの上のタブは 出撃 / 海域 / 敵艦 / 計算設定
 * (観測ログ・送信設定はプラグインだけ) であること。
 * 出撃タブはページも main (タブの中身) もスクロールしないことを 1280×800・1200×710・1024×600 で確かめる。
 * 実行ボタン: 自動の結果が今の入力のものなら押せず (理由は title)、自動オフではクリックで結果が出ることも確かめる。
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
// 「出撃」は上のタブ列とモード切り替えの両方にある。枠のタブ列が先
const tab = (label: string) => page.getByRole("tab", { name: label, exact: true }).first().click();
/** 枠のタブの名前: 左のバー (縦) と上の行 (文書で最初の横のタブ列。画面の中の切り替えはその後) */
const chromeTabs = () =>
  page.evaluate(() => {
    const names = (list: Element | null) => [...(list?.querySelectorAll(":scope > [role=tab]") ?? [])].map((el) => el.textContent);
    return {
      bar: names(document.querySelector("[role=tablist][aria-orientation=vertical]")),
      top: names(document.querySelector("[role=tablist]:not([aria-orientation])")),
    };
  });

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
/** 表示中の結果が今の入力・回数のもの (実行ボタンが計算済みで、その理由を title に出す) */
const DONE = "span[title^='この入力の']";
const waitDone = () => page.waitForSelector(DONE, { timeout: 180_000 });
const run = page.getByRole("button", { name: /^実行/ });

const checkNoScroll = async (label: string) => {
  const [sh, ih, mainSh, mainCh] = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    return [document.scrollingElement!.scrollHeight, innerHeight, main.scrollHeight, main.clientHeight];
  });
  console.log(`${label}: page ${sh} <= ${ih}, main ${mainSh} <= ${mainCh}`);
  if (sh > ih || mainSh > mainCh) throw new Error(`${label}: scrolls`);
};

try {
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByText("1番艦を追加").waitFor();
  const tabs = await chromeTabs();
  console.log("chrome:", JSON.stringify(tabs));
  if (tabs.bar.join() !== "シミュレーション,任務,設定" || tabs.top.join() !== "出撃,海域,敵艦,計算設定") throw new Error(`unexpected chrome: ${JSON.stringify(tabs)}`);
  await shot("00-workspace-empty");

  // poi の第1艦隊 (6 隻) を取り込み、海域を選ぶ → 自動で計算される
  await page.getByTitle("第1艦隊").first().click();
  await waitResult("");
  let prev = await meta(page);
  await page.getByLabel("海域").selectOption(MAP);
  await waitResult(prev);
  console.log("auto:", await meta(page));
  // 自動の結果がこの入力・この回数のものなら、実行し直しても同じ結果なので押せず、理由を title に出す
  await waitDone();
  if (await run.isEnabled()) throw new Error("実行 is enabled although the shown result is current");
  const kpi = await page.locator("[data-results]").first().innerText();
  console.log("---- sortie ----\n" + kpi.split("\n").slice(0, 24).join(" | "));
  await checkNoScroll("1280x800");
  await shot("workspace-1280");
  // ブラウザで開いた 出撃 (docs、1024×600)
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.waitForTimeout(400);
  await checkNoScroll("1024x600");
  await shot("23-web-sortie");

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
    await page.getByPlaceholder("検索").fill("駆逐イ級");
    await page.getByRole("button", { name: /駆逐イ級/ }).first().click();
    await page.waitForTimeout(500);
    await shot("11-enemy-detail", { fullPage: true });
  } else {
    console.warn("data API is down; skipping the enemy screenshot");
  }

  await tab("計算設定");
  await page.getByText("サーバの推定値を使う").waitFor();
  await shot("12-sim-settings");
  await tab("設定");
  await page.getByText("データキャッシュ").waitFor();
  await shot("12-settings");
  // 機能を切り替えて戻ると、その機能で最後に開いていた画面 (計算設定)
  await tab("シミュレーション");
  if ((await page.getByRole("tab", { name: "計算設定", exact: true }).getAttribute("aria-selected")) !== "true") throw new Error("シミュ did not return to 計算設定");

  // 自動 (チェックボックス): 保存され、オフの間は入力を変えても計算せず、オンにすると計算する
  await tab("出撃");
  const auto = page.getByRole("checkbox", { name: "自動" });
  await auto.uncheck();
  await page.reload();
  await auto.waitFor();
  if (await auto.isChecked()) throw new Error("自動 was not persisted");
  await page.getByLabel("海域").selectOption({ index: 0 });
  await page.waitForTimeout(1000);
  if (await meta(page)) throw new Error("ran while 自動 is off");
  // 自動がオフなら 実行 のクリックで計算する (クリックがボタンに届き、結果が出る)
  await run.click();
  await waitResult("");
  await waitDone();
  console.log("manual (自動 off):", await meta(page));
  await page.getByLabel("海域").selectOption(MAP);
  await page.waitForTimeout(1000);
  if (await page.$(DONE)) throw new Error("ran while 自動 is off");
  await auto.check();
  await waitDone();
  console.log("自動 persisted; off: 実行 runs, on:", await meta(page));

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
  await shot("workspace-1024");
  // 出撃の条件 (基本・マス・ゲージ・資源) と、HP ゲージ 2 本での結果の資源・ゲージ・損耗タブ (1024×600 で収まる)
  prev = await meta(page);
  await page.getByRole("button", { name: "条件" }).click();
  await page.waitForTimeout(150);
  await shot("conditions-basic-1024");
  await page.getByRole("dialog").getByRole("tab", { name: /^マス/ }).click();
  await page.waitForTimeout(150);
  await shot("conditions-nodes-1024");
  await page.getByRole("dialog").getByRole("tab", { name: /^ゲージ/ }).click();
  await page.getByLabel("ゲージの種別").selectOption("hp");
  await page.getByRole("button", { name: "ゲージを追加" }).click();
  await page.waitForTimeout(150);
  await shot("conditions-gauge-1024");
  await page.getByRole("dialog").getByRole("tab", { name: /^資源/ }).click();
  await page.getByRole("checkbox", { name: /高速修復材を使う/ }).check();
  await page.waitForTimeout(150);
  await shot("conditions-resources-1024");
  await page.keyboard.press("Escape");
  await waitResult(prev);
  for (const [label, name] of [["資源", "resources"], ["ゲージ", "gauge"], ["損耗", "ships"]] as const) {
    await page.locator("[data-results]").getByRole("tab", { name: new RegExp(`^${label}`) }).click();
    await page.waitForTimeout(200);
    await checkNoScroll(`1024x600 results ${name}`);
    await shot(`workspace-1024-${name}`);
  }
  // 遊撃部隊: 7 番艦の枠が出る
  await page.getByLabel("艦隊", { exact: true }).selectOption("striking_force");
  await page.getByText("7番艦を追加").waitFor();
  await checkNoScroll("1024x600 striking force");
  await shot("workspace-1024-striking");
  // 連合艦隊 (随伴) と基地航空隊 (poi の基地を取り込み、1 波目の目標を最初の戦闘マスに)、目標マスも同じ高さで収まる
  await page.getByLabel("艦隊", { exact: true }).selectOption("carrier_task_force");
  await page.getByRole("tab", { name: /^随伴/ }).click();
  // 空の随伴に poi の第2艦隊を入れる (これで連合艦隊として計算される)
  const prevEscort = await meta(page);
  await page.getByTitle("第2艦隊").first().click();
  await waitResult(prevEscort);
  await checkNoScroll("1024x600 escort");
  await shot("workspace-1024-escort");
  await page.getByRole("tab", { name: /^基地/ }).click();
  await page.getByRole("button", { name: "poi から取り込み" }).click();
  await page.getByLabel("第1基地 1波目の目標").selectOption({ index: 1 });
  await page.waitForTimeout(400);
  await checkNoScroll("1024x600 land bases");
  await shot("workspace-1024-lbas");
  await page.getByLabel("目標マス").selectOption({ index: 1 });
  await page.waitForTimeout(600);
  await checkNoScroll("1024x600 target node");
  await shot("workspace-1024-target");
  // 支援艦隊 (決戦支援に 1 隻) と友軍艦隊 (1 隻)、条件の「艦隊」で決戦支援・友軍・基地空襲を有効に
  const addShip = async (n: number) => {
    await page.getByLabel(`${n}番艦を追加`).click();
    await page.getByRole("dialog").getByRole("listbox").getByRole("option").first().click();
  };
  await page.getByRole("tab", { name: /^支援/ }).click();
  await page.getByRole("tab", { name: /^決戦支援/ }).click();
  await addShip(1);
  await page.waitForTimeout(300);
  await checkNoScroll("1024x600 support fleet");
  await shot("workspace-1024-support");
  await page.getByRole("tab", { name: /^友軍/ }).click();
  await addShip(1);
  await page.waitForTimeout(300);
  await checkNoScroll("1024x600 friend fleet");
  await shot("workspace-1024-friend");
  const prevFleets = await meta(page);
  await page.getByRole("button", { name: "条件" }).click();
  await page.getByRole("dialog").getByRole("tab", { name: /^艦隊/ }).click();
  await page.getByRole("checkbox", { name: /^決戦支援/ }).check();
  await page.getByRole("checkbox", { name: /^友軍艦隊/ }).check();
  await page.getByLabel("空襲されるマス").selectOption({ index: 1 });
  await page.waitForTimeout(150);
  await shot("conditions-fleets-1024");
  await page.keyboard.press("Escape");
  await waitResult(prevFleets);
  await checkNoScroll("1024x600 support / friend / raid results");
  await shot("workspace-1024-fleets-results");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await checkNoScroll("1280x800 support / friend / raid results");
  await shot("workspace-1280-fleets-results");
  // 単一戦闘: 支援・友軍・基地空襲 (選んだ編成が空襲)
  const prevBattle = await meta(page);
  await page.getByRole("tab", { name: "単一戦闘", exact: true }).click();
  await page.getByRole("button", { name: "条件" }).click();
  await page.getByRole("checkbox", { name: /基地航空隊を空襲する/ }).check();
  await page.waitForTimeout(150);
  await shot("conditions-battle-fleets");
  await page.keyboard.press("Escape");
  await waitResult(prevBattle);
  await checkNoScroll("1280x800 battle with support / friend / raid");
  await shot("workspace-1280-battle-fleets");

  // 狭いウィンドウ (800px 幅): 1 列に積んでページをスクロールする
  await page.setViewportSize({ width: 800, height: 900 });
  await tab("出撃");
  await page.waitForTimeout(400);
  await shot("17-narrow-workspace");
} finally {
  await browser.close();
  server.kill();
}
