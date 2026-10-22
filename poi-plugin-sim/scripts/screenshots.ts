/**
 * プラグインのビューのスクリーンショット (docs/screenshots/)。`bun run screenshots`。
 * Web UI (web/ の vite) とプラグインの開発用ページ (dev/) を起動し、headless Chromium で
 * 埋め込んだシミュレータ (poi の state が postMessage で届いたこと = 「poi 接続中」)、観測ログ、送信設定を撮る。
 * ブラウザは playwright のキャッシュにある chromium_headless_shell を使う (CHROMIUM_PATH で上書き可)。
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(import.meta.dir, "../../docs/screenshots");
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

const startVite = async (cwd: string, port: number) => {
  const proc = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], { cwd, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; !(await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)); i++) {
    if (i > 300) throw new Error(`vite in ${cwd} did not start`);
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.error("[console.error]", m.text().slice(0, 300)));

const shot = async (name: string) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("saved", join(OUT, `${name}.png`));
};
const tab = (label: string) => page.getByRole("tab", { name: label, exact: true }).click();

try {
  await page.goto(`http://localhost:${PLUGIN_PORT}/?server=${encodeURIComponent(`http://localhost:${WEB_PORT}/`)}`);
  await page.evaluate(async () => {
    localStorage.clear();
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name!); q.onsuccess = q.onerror = q.onblocked = () => r(null); })));
  });
  await page.reload();

  // 埋め込んだ Web UI に poi の state (開発用ページではサンプル) が届くと「poi 接続中」になる
  const web = page.frameLocator("iframe[title=kc-sim]");
  await web.getByText("poi 接続中").waitFor({ timeout: 30_000 });
  await web.getByTitle("第1艦隊").click();
  await web.getByText("第1艦隊を取り込みました").waitFor();
  await page.waitForTimeout(300);
  await shot("19-plugin-embedded");

  // 観測ログ: 戦闘を流し込んでから表示
  await page.evaluate(async () => {
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
  await page.locator("tbody tr").first().click();
  await page.getByText("攻撃イベント").waitFor();
  await page.waitForTimeout(300);
  await shot("06-log-detail");
  await page.keyboard.press("Escape");

  await tab("送信設定");
  await page.getByText("最終成功").waitFor();
  await page.waitForTimeout(300);
  await shot("08-plugin-upload");
} finally {
  await browser.close();
  servers.forEach((s) => s.kill());
}
