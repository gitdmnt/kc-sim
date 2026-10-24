// Quest sources -> merged rows -> GET /quests (inputs shaped like KC3Kai quests_meta.json, kc3-translations jp/quests.json
// and kcwiki-quest-data data.json, trimmed to a few real entries).
import { expect, test } from "bun:test";
import { kc3QuestMeta, kc3QuestTranslations, kcwikiQuestData, mergeQuests } from "../src/quests";
import { QUEST_OVERRIDES_PATH, parseQuestOverrides } from "../src/questOverrides";
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
  expect(by.get(103)).toEqual({
    id: 103, code: null, name: null, detail: null, memo: null, pre: [{ id: 102, src: ["kc3"] }], requirements: null, rewards: null, override: null,
  });
  // 153: KC3 has 274, kcwiki adds 111 (not a known quest: kept as dangling)
  expect(by.get(153)!.pre).toEqual([{ id: 111, src: ["kcwiki"] }, { id: 274, src: ["kc3", "kcwiki"] }]);
  expect(by.get(113)!.pre.map((p) => p.id)).toEqual([107, 9999]);
  // text: kc3-translations first, kcwiki as fallback (with <br> turned into newlines)
  expect(by.get(101)).toMatchObject({ code: "A1", name: "はじめての「編成」！", memo: "[獲]駆逐艦白雪" });
  expect(by.get(102)!.name).toBe("「駆逐隊」を編成せよ！");
  expect(by.get(113)).toMatchObject({ code: "A13", name: "kcwiki only", detail: "d" });
  expect(by.get(102)!.requirements).toEqual({ category: "fleet", groups: [{ ship: "駆逐", amount: 4 }] });
  expect(stats).toEqual({
    quests: 7, edges: 6, kc3Edges: 3, kcwikiEdges: 5, bothEdges: 2, withRequirements: 2, danglingEdges: 2,
    overridden: 0, overriddenRequirements: 0, overriddenPre: 0, overriddenRewards: 0, overrideOnly: 0,
  });
});

const SORTIE = {
  category: "sortie", map: ["2-5", "3-5"], boss: true, result: "S", times: 2,
  groups: [{ ship: "大和改二", shipIds: [911, 916], flagship: true }, { ship: "駆逐", stypes: [2], amount: 2 }],
};

test("overrides win field by field and record their provenance", () => {
  const overrides = parseQuestOverrides([
    { id: 102, source: "https://zekamashi.net/a/", author: "llm", date: "2026-10-24", requirements: SORTIE, rewards: { resources: [100, 0, 0, 0] } },
    { id: 153, code: "B71", source: "https://zekamashi.net/b/", pre: [274, 107] },
    { id: 9100, code: "B999", name: "新任務", source: "https://zekamashi.net/c/", requirements: { category: "other", note: "未確認" } },
  ]);
  const { quests, stats } = mergeQuests({ kc3Meta, kc3Jp, kcwiki, overrides });
  const by = new Map(quests.map((q) => [q.id, q]));
  expect(by.get(102)).toMatchObject({
    name: "「駆逐隊」を編成せよ！", requirements: SORTIE, rewards: { resources: [100, 0, 0, 0] },
    pre: [{ id: 101, src: ["kc3", "kcwiki"] }],
    override: { source: "https://zekamashi.net/a/", fields: ["requirements", "rewards"], author: "llm", date: "2026-10-24" },
  });
  // `pre` is the complete list: kcwiki's 111 is dropped, 274 keeps its upstream sources, 107 is new
  expect(by.get(153)!.pre).toEqual([{ id: 107, src: ["override"] }, { id: 274, src: ["kc3", "kcwiki", "override"] }]);
  expect(by.get(9100)).toMatchObject({ code: "B999", name: "新任務", requirements: { category: "other", note: "未確認" } });
  expect(stats).toMatchObject({ quests: 8, overridden: 3, overriddenRequirements: 2, overriddenPre: 1, overriddenRewards: 1, overrideOnly: 1, withRequirements: 3 });
});

test("the override schema is strict", () => {
  const base = { id: 1, source: "https://zekamashi.net/x/" };
  const bad = [
    { ...base }, // sets nothing
    { ...base, requirements: { ...SORTIE, map: "2-1 ~ 2-5" } }, // map ranges are kcwiki-only
    { ...base, requirements: { ...SORTIE, boss: undefined } }, // neither boss nor cells
    { ...base, requirements: { ...SORTIE, groups: [{ ship: "妙高" }] } }, // names only
    { ...base, requirements: { ...SORTIE, result: "SS" } },
    { ...base, requirements: { ...SORTIE, typo: 1 } },
    { ...base, source: "http://zekamashi.net/x/", pre: [2] },
  ];
  for (const b of bad) expect(() => parseQuestOverrides([b])).toThrow();
  expect(() => parseQuestOverrides([{ ...base, pre: [2] }, { ...base, pre: [3] }])).toThrow(/twice/);
});

test("shared/quest/overrides.json is valid", async () => {
  const list = parseQuestOverrides(await Bun.file(QUEST_OVERRIDES_PATH).json());
  expect(list.length).toBeGreaterThan(0);
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
    await h.db.prepare("INSERT INTO quests (id, code, name, detail, memo, pre, requirements, rewards, override) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
      .bind(q.id, q.code, q.name, q.detail, q.memo, JSON.stringify(q.pre), q.requirements && JSON.stringify(q.requirements), null, null).run();
  }
  await h.db.prepare("INSERT INTO sources (key, name, url, licence, revision, fetched_at) VALUES ('kc3kai-quests-meta', 'x', 'u', 'MIT', 'abc', '2026-10-24T00:00:00Z')").run();
  const r = await h.call<{ sources: unknown[]; quests: unknown[] }>("GET", "/api/v1/quests");
  expect(r.status).toBe(200);
  expect(r.json.quests).toEqual(quests);
  expect(r.json.sources).toEqual([{ key: "kc3kai-quests-meta", revision: "abc", fetchedAt: "2026-10-24T00:00:00Z" }]);
});
