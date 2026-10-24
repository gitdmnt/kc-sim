/**
 * 任務タブのスクリーンショット (docs/screenshots/17-quests.png, 1024×600) と、1280×800・1200×710・1024×600 で
 * ページも main もスクロールしないことの確認。`bun scripts/screenshot-quests.ts`
 * 任務データは /api (中継先 127.0.0.1:8787、KCSIM_API で上書き) の GET /api/v1/quests: ローカル D1 に
 * `cd server && bun run ingest:quests` 済みであること。poi の代わりの state は同梱サンプルに、マスター全体
 * (@kancolle/data の api_start2) と、選んだ任務の前提の途中を遂行中にした例の任務状態 (デモ用) を足したもの。
 */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startDevServer } from "./devServer";
import sample from "../src/sampleState.json";
import type { PoiQuests } from "@shared/embed/protocol";
import type { QuestsResponse } from "@shared/quest/types";
import { buildQuestGraph, resolvePrerequisites } from "@shared/quest/tree";

const OUT = resolve(import.meta.dir, "../../docs/screenshots/17-quests.png");
const PORT = 5213;
const API = process.env.KCSIM_API ?? "http://127.0.0.1:8787";
/** A88 最精鋭甲型駆逐艦、集結せよ！ (前提 40 件余り、艦娘・装備の条件つき) */
const TARGET = Number(process.env.QUEST ?? 193);

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

const data = (await (await fetch(`${API}/api/v1/quests`)).json()) as QuestsResponse;
const graph = buildQuestGraph(data.quests);
const tree = resolvePrerequisites(graph, TARGET);
console.log(`quests ${data.quests.length}, edges ${data.quests.reduce((n, q) => n + q.pre.length, 0)}; ${TARGET}: ${tree.order.length - 1} prerequisites`);

// デモの任務状態: 前提の 2/3 あたりの単発任務を遂行中 (50%)、その次を受注可にする。周期任務が前提にあれば poi の進捗カウンタ付きで遂行中
const chain = tree.order.slice(0, -1);
const mid = chain[Math.floor(chain.length * 0.66)]!;
const next = chain.find((id) => id !== mid && tree.depth.get(id)! >= tree.depth.get(mid)!) ?? mid;
const periodic = chain.find((id) => /^[A-G][dwmq]\d/.test(graph.byId.get(id)?.code ?? ""));
const quests: PoiQuests = {
  list: [{ id: mid, state: 2, type: 4, progress: 1 }, { id: next, state: 1, type: 4, progress: 0 }],
  active: [{ id: mid, state: 2, type: 4, progress: 1 }],
  records: {},
};
if (periodic) {
  quests.list!.push({ id: periodic, state: 2, type: 2, progress: 0 });
  quests.active.push({ id: periodic, state: 2, type: 2, progress: 0 });
  quests.records[periodic] = [{ key: "battle_boss_win", description: "ボス勝利", count: 2, required: 5 }];
}
const start2 = (await Bun.file(resolve(import.meta.dir, "../node_modules/@kancolle/data/api/api_start2.json")).json()) as {
  api_mst_ship: { api_id: number }[];
  api_mst_slotitem: { api_id: number }[];
};
const byId = <T extends { api_id: number }>(l: T[]) => Object.fromEntries(l.map((x) => [x.api_id, x]));
const devState = {
  ...sample,
  const: { ...sample.const, $ships: { ...byId(start2.api_mst_ship), ...sample.const.$ships }, $equips: { ...byId(start2.api_mst_slotitem), ...sample.const.$equips } },
  quests,
};

const server = await startDevServer(PORT, API);
const browser = await chromium.launch({ executablePath: findChromium() });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.route("**/__dev/state.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(devState) }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate((id) => {
    localStorage.clear();
    localStorage.setItem("kcsim:tab", "quests");
    localStorage.setItem("kcsim:quest", String(id));
  }, TARGET);
  await page.reload();
  await page.getByRole("list", { name: "前提任務" }).waitFor({ timeout: 30_000 });
  const rows = await page.getByRole("list", { name: "前提任務" }).getByRole("listitem").count();
  const needs = await page.locator("section", { has: page.getByRole("heading", { name: "必要なもの" }) }).innerText();
  console.log(`tree rows ${rows}\n---- 必要なもの ----\n${needs.split("\n").slice(0, 30).join(" | ")}`);

  // ページ・main がスクロールせず、3 枚のカードが画面内に収まる (中身はカードの中でスクロール)
  for (const [w, h] of [[1280, 800], [1200, 710], [1024, 600]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    const [sh, ih, mainSh, mainCh, bottom] = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const cards = [...main.querySelectorAll("section")].map((s) => s.getBoundingClientRect().bottom);
      return [document.scrollingElement!.scrollHeight, innerHeight, main.scrollHeight, main.clientHeight, Math.max(...cards)];
    });
    console.log(`${w}x${h}: page ${sh} <= ${ih}, main ${mainSh} <= ${mainCh}, cards end at ${Math.round(bottom)}`);
    if (sh > ih || mainSh > mainCh || bottom > ih) throw new Error(`${w}x${h}: scrolls or overflows`);
  }
  await page.screenshot({ path: OUT });
  console.log("saved", OUT);
} finally {
  await browser.close();
  server.kill();
}
