/**
 * 任務タブのスクリーンショット (docs/screenshots/17-quests.png, 1024×600) と、1280×800・1200×710・1024×600 で
 * ページも main もスクロールしないことの確認。続けて、手入力の達成条件を kc-sim プラグインが数えた単発任務の例
 * (docs/screenshots/18-quest-progress.png: COUNTED_QUEST、既定 B182 を遂行中、サブ目標の途中まで数えた状態)。最後に
 * 一覧の絞り込み (単発・出撃 + 検索語) と選択報酬つきの任務 (docs/screenshots/19-quest-filters.png: FILTER_QUEST、既定 B117、
 * 種別のドロップダウンを開いた状態) を 1024×600 で撮る。
 * `bun scripts/screenshot-quests.ts`
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
import { questGoals } from "@shared/quest/progress";

const OUT = resolve(import.meta.dir, "../../docs/screenshots/17-quests.png");
const OUT_COUNTED = resolve(import.meta.dir, "../../docs/screenshots/18-quest-progress.png");
const OUT_FILTERED = resolve(import.meta.dir, "../../docs/screenshots/19-quest-filters.png");
const PORT = 5213;
const API = process.env.KCSIM_API ?? "http://127.0.0.1:8787";
/** A88 最精鋭甲型駆逐艦、集結せよ！ (前提 40 件余り、艦娘・装備の条件つき) */
const TARGET = Number(process.env.QUEST ?? 193);
/** B182 見敵必殺！最精鋭大和型「第一戦隊」抜錨！ (手入力: 4 海域のボス S 勝利) */
const COUNTED = Number(process.env.COUNTED_QUEST ?? 977);
/** B117 最精鋭甲型駆逐艦、突入！敵中突破！ (二回選択報酬、前提の経路あり) */
const FILTER_QUEST = Number(process.env.FILTER_QUEST ?? 884);

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
  let served: unknown = devState;
  await page.route("**/__dev/state.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(served) }));
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

  // 単発任務を遂行中にし、プラグインのカウンタが数えた進捗 (source "kcsim") を例として入れる: 前半のサブ目標は達成済み
  const goals = questGoals(graph.byId.get(COUNTED)?.requirements ?? null);
  if (goals.length === 0) throw new Error(`${COUNTED}: no countable goals (needs an override with mechanical conditions)`);
  const counted: PoiQuests = {
    list: [{ id: COUNTED, state: 2, type: 4, progress: 1 }],
    active: [{ id: COUNTED, state: 2, type: 4, progress: 1 }],
    records: {
      [COUNTED]: goals.map((g, i) => ({
        key: g.key, description: g.description, required: g.required, source: "kcsim",
        count: i < goals.length / 2 ? g.required : 0,
      })),
    },
  };
  served = { ...devState, quests: counted };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate((id) => localStorage.setItem("kcsim:quest", String(id)), COUNTED);
  await page.reload();
  await page.getByText("進捗 (kc-sim):").waitFor({ timeout: 30_000 });
  console.log(`${COUNTED}: ${goals.length} counted goals`);
  await page.screenshot({ path: OUT_COUNTED });
  console.log("saved", OUT_COUNTED);

  // 絞り込み (単発・出撃、検索語つき) と選択報酬の表示。ドロップダウンを開いて件数も写す
  served = devState;
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.evaluate((id) => {
    localStorage.setItem("kcsim:quest", String(id));
    localStorage.setItem("kcsim:questFilter", JSON.stringify({ freq: ["once"], cat: ["B"], status: [] }));
  }, FILTER_QUEST);
  await page.reload();
  await page.getByRole("list", { name: "前提任務" }).waitFor({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "任務を検索" }).fill("最精鋭");
  const listed = await page.getByRole("list", { name: "任務の一覧" }).getByRole("listitem").count();
  const rewardText = await page.getByLabel("報酬", { exact: true }).innerText();
  console.log(`${FILTER_QUEST}: ${listed} listed; 報酬 ${rewardText.replace(/\n/g, " ")}`);
  if ((await page.getByLabel(/^選択報酬/).count()) === 0) throw new Error(`${FILTER_QUEST}: no 選択報酬 shown`);
  await page.getByRole("button", { name: /^種別で絞り込み/ }).click();
  const [sh, ih] = await page.evaluate(() => [document.scrollingElement!.scrollHeight, innerHeight]);
  if (sh > ih) throw new Error(`1024x600 filtered: page scrolls (${sh} > ${ih})`);
  await page.screenshot({ path: OUT_FILTERED });
  console.log("saved", OUT_FILTERED);
} finally {
  await browser.close();
  server.kill();
}
