// Quest sources -> merged rows -> GET /quests (inputs shaped like KC3Kai quests_meta.json, kc3-translations jp/quests.json
// and kcwiki-quest-data data.json, trimmed to a few real entries).
import { expect, test } from "bun:test";
import { kc3QuestMeta, kc3QuestTranslations, kcwikiQuestData, mergeQuests } from "../src/quests";
import { harness } from "./helpers";

const kc3Meta = kc3QuestMeta.parse({
  "101": { unlock: [102] },
  "102": { unlock: [103], rewardConsumables: [1, 0, 0, 0] },
  "107": { unlock: [] },
  "274": { unlock: [153] },
  "EoF&RemarksOfDataFormat": { foo: 1 },
});
const kc3Jp = kc3QuestTranslations.parse({
  "101": { code: "A1", name: "はじめての「編成」！", desc: "２隻以上の艦で構成される「艦隊」を編成せよ！", memo: "[獲]駆逐艦白雪" },
  "102": { code: "A2", name: "「駆逐隊」を編成せよ！", desc: "駆逐艦４隻以上で構成される「駆逐隊」を編成せよ！" },
  "153": { code: "B71", name: "改装軽巡出撃", desc: "x" },
  eof: {},
});
const kcwiki = kcwikiQuestData.parse([
  { game_id: 102, wiki_id: "A02", name: "kcwiki name", detail: "line1<br>line2", prerequisite: [101], requirements: { category: "fleet", groups: [{ ship: "駆逐", amount: 4 }] } },
  { game_id: 113, wiki_id: "A13", name: "kcwiki only", detail: "d", prerequisite: [107, 9999], requirements: { category: "simple", subcategory: "ship", times: 1 } },
  { game_id: 153, wiki_id: "B71", name: "n", detail: "d", prerequisite: [274, 111] },
]);

test("merge unions KC3 unlock edges and kcwiki prerequisites, with their sources", () => {
  const { quests, stats } = mergeQuests({ kc3Meta, kc3Jp, kcwiki });
  const by = new Map(quests.map((q) => [q.id, q]));
  expect(quests.map((q) => q.id)).toEqual([101, 102, 103, 107, 113, 153, 274]);
  // 102: KC3 (101 unlocks 102) and kcwiki agree
  expect(by.get(102)!.pre).toEqual([{ id: 101, src: ["kc3", "kcwiki"] }]);
  // 103 exists only as an unlock target
  expect(by.get(103)).toEqual({ id: 103, code: null, name: null, detail: null, memo: null, pre: [{ id: 102, src: ["kc3"] }], requirements: null });
  // 153: KC3 has 274, kcwiki adds 111 (not a known quest: kept as dangling)
  expect(by.get(153)!.pre).toEqual([{ id: 111, src: ["kcwiki"] }, { id: 274, src: ["kc3", "kcwiki"] }]);
  expect(by.get(113)!.pre.map((p) => p.id)).toEqual([107, 9999]);
  // text: kc3-translations first, kcwiki as fallback (with <br> turned into newlines)
  expect(by.get(101)).toMatchObject({ code: "A1", name: "はじめての「編成」！", memo: "[獲]駆逐艦白雪" });
  expect(by.get(102)!.name).toBe("「駆逐隊」を編成せよ！");
  expect(by.get(113)).toMatchObject({ code: "A13", name: "kcwiki only", detail: "d" });
  expect(by.get(102)!.requirements).toEqual({ category: "fleet", groups: [{ ship: "駆逐", amount: 4 }] });
  expect(stats).toEqual({ quests: 7, edges: 6, kc3Edges: 3, kcwikiEdges: 5, bothEdges: 2, withRequirements: 2, danglingEdges: 2 });
});

test("kcwiki text fallback turns <br> into newlines; malformed kcwiki entries are rejected", () => {
  const { quests } = mergeQuests({ kc3Meta: {}, kc3Jp: {}, kcwiki });
  expect(quests.find((q) => q.id === 102)!.detail).toBe("line1\nline2");
  expect(kcwikiQuestData.safeParse([{ game_id: "x" }]).success).toBe(false);
});

test("GET /quests serves every row with its sources", async () => {
  const h = harness();
  const { quests } = mergeQuests({ kc3Meta, kc3Jp, kcwiki });
  for (const q of quests) {
    await h.db.prepare("INSERT INTO quests (id, code, name, detail, memo, pre, requirements) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(q.id, q.code, q.name, q.detail, q.memo, JSON.stringify(q.pre), q.requirements && JSON.stringify(q.requirements)).run();
  }
  await h.db.prepare("INSERT INTO sources (key, name, url, licence, revision, fetched_at) VALUES ('kc3kai-quests-meta', 'x', 'u', 'MIT', 'abc', '2026-10-24T00:00:00Z')").run();
  const r = await h.call<{ sources: unknown[]; quests: unknown[] }>("GET", "/api/v1/quests");
  expect(r.status).toBe(200);
  expect(r.json.quests).toEqual(quests);
  expect(r.json.sources).toEqual([{ key: "kc3kai-quests-meta", revision: "abc", fetchedAt: "2026-10-24T00:00:00Z" }]);
});
