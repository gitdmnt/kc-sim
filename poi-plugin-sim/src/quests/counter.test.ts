import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "bun:test";
import { buildQuestGoals, countedGoals, QuestCounter } from "./counter";
import { QuestProgressDb } from "./store";
import type { QuestCounts, QuestProgressStore } from "./store";
import { projectQuests } from "@shared/embed/protocol";

// Synthetic quests in the override format (docs/QUEST_OVERRIDES.md)
const SORTIE = 9001;
const EXERCISE = 9002;
const SCRAP = 9003;
const EXPEDITION = 9004;
const POI_TRACKED = 9005;
const GOALS = buildQuestGoals([
  {
    id: SORTIE,
    requirements: {
      category: "sortie", map: ["2-5", "3-5"], boss: true, result: "S", times: 2,
      groups: [{ ship: "大和改二", shipIds: [911, 916], flagship: true }, { stypes: [2], amount: 2 }],
    },
  },
  { id: EXERCISE, requirements: { category: "excercise", result: "A", times: 3, daily: true, groups: [{ stypes: [2], amount: 2 }] } },
  { id: SCRAP, requirements: { category: "equipexchange", scraps: [{ name: "12.7cm連装砲", amount: 3, equipIds: [2] }] } },
  { id: EXPEDITION, requirements: { category: "expedition", objects: [{ id: 5, name: "海上護衛任務", times: 1 }] } },
  { id: POI_TRACKED, requirements: { category: "simple", subcategory: "equipment", times: 1 } },
  { id: 9006, requirements: { category: "fleet", groups: [{ stypes: [2], amount: 4 }] } },
]);

const MASTER = {
  $ships: {
    911: { api_id: 911, api_stype: 8, api_ctype: 37, api_aftershipid: "916" },
    916: { api_id: 916, api_stype: 10, api_ctype: 37 },
    1: { api_id: 1, api_stype: 2, api_ctype: 1 },
    21: { api_id: 21, api_stype: 3, api_ctype: 4 },
  },
  $equips: { 2: { api_id: 2, api_type: [1, 1, 1, 1, 0] }, 4: { api_id: 4, api_type: [1, 2, 2, 2, 0] } },
  $missions: { 5: { api_id: 5, api_name: "海上護衛任務" } },
};

const active = (...ids: number[]) =>
  Object.fromEntries(ids.map((id) => [id, { detail: { api_no: id, api_state: 2, api_type: 4, api_progress_flag: 0 } }]));

const newState = () => ({
  info: {
    basic: { api_member_id: 77 },
    fleets: [{ api_ship: [1001, 1002, 1003, -1, -1, -1] }, { api_ship: [1004, 1002, -1, -1, -1, -1], api_mission: [2, 5, 0, 0] }],
    ships: {
      1001: { api_ship_id: 911, api_lv: 99 },
      1002: { api_ship_id: 1, api_lv: 50 },
      1003: { api_ship_id: 1, api_lv: 50 },
      1004: { api_ship_id: 21, api_lv: 50 },
    } as Record<number, { api_ship_id: number; api_lv: number }>,
    equips: { 501: { api_slotitem_id: 2 }, 502: { api_slotitem_id: 2 }, 503: { api_slotitem_id: 4 } } as Record<number, { api_slotitem_id: number }>,
    maps: { 25: { api_gauge_num: 1 } },
    quests: { activeQuests: active(SORTIE, EXERCISE, SCRAP, EXPEDITION, POI_TRACKED), records: { [POI_TRACKED]: { develop: { count: 0, required: 1 } } } },
  },
  const: MASTER,
});

class MemoryStore implements QuestProgressStore {
  saved = new Map<string, QuestCounts>();
  async load(admiral: string) {
    return structuredClone(this.saved.get(admiral) ?? {});
  }
  async save(admiral: string, c: QuestCounts) {
    this.saved.set(admiral, structuredClone(c));
  }
}

type Fire = (path: string, body?: unknown, post?: unknown) => Promise<void>;

const setup = (now = Date.UTC(2026, 9, 24, 3)) => {
  // poi's redux state is immutable: an update replaces the root (tests that need that assign `holder.state`)
  const holder = { state: newState() };
  const state = holder.state;
  const store = new MemoryStore();
  const changes: string[] = [];
  const counter = new QuestCounter({ store, getState: () => holder.state, goals: GOALS, onChange: (a) => changes.push(a), now: () => now });
  const fire: Fire = (path, body = {}, post = {}) => counter.handle(`/kcsapi/${path}`, body, post);
  const counts = () => store.saved.get("77") ?? {};
  return { state, holder, store, changes, fire, counts };
};

const sortie = async (fire: Fire, map: [number, number], cells: { no: number; boss?: boolean }[], rank = "S", deck = "1") => {
  const [first, ...rest] = cells;
  await fire("api_req_map/start", { api_maparea_id: map[0], api_mapinfo_no: map[1], api_no: first!.no, api_event_id: first!.boss ? 5 : 4, api_bosscell_no: 20 }, { api_deck_id: deck });
  for (const c of rest) await fire("api_req_map/next", { api_no: c.no, api_event_id: c.boss ? 5 : 4, api_bosscell_no: 20 });
  await fire("api_req_sortie/battleresult", { api_win_rank: rank });
  await fire("api_port/port");
};

describe("QuestCounter", () => {
  test("sortie: boss only, rank threshold, fleet constraint, multi-map goals", async () => {
    const t = setup();
    await sortie(t.fire, [2, 5], [{ no: 3 }]); // not the boss
    await sortie(t.fire, [2, 5], [{ no: 3 }, { no: 20, boss: true }], "A"); // below S
    await sortie(t.fire, [2, 5], [{ no: 3 }, { no: 20, boss: true }]);
    await sortie(t.fire, [3, 5], [{ no: 20, boss: true }]);
    await sortie(t.fire, [3, 5], [{ no: 20, boss: true }], "S", "2"); // fleet 2: no 大和改二 flagship
    t.state.info.fleets[0]!.api_ship = [1001, 1002, -1, -1, -1, -1]; // one destroyer only
    await sortie(t.fire, [2, 5], [{ no: 20, boss: true }]);
    expect(t.counts()[SORTIE]).toEqual({ "@2-5": { count: 1 }, "@3-5": { count: 1 } });
    // the bossless 1-1 run counted nothing for anyone
    expect(Object.keys(t.counts())).toEqual([String(SORTIE)]);
  });

  test("a combined-fleet battleresult counts with the main fleet", async () => {
    const t = setup();
    await t.fire("api_req_map/start", { api_maparea_id: 2, api_mapinfo_no: 5, api_no: 20, api_event_id: 5, api_bosscell_no: 20 }, { api_deck_id: "1" });
    await t.fire("api_req_combined_battle/battleresult", { api_win_rank: "S" });
    expect(t.counts()[SORTIE]?.["@2-5"]).toEqual({ count: 1 });
  });

  test("exercise (daily, rank, fleet), expedition, scrap from the pre-response state", async () => {
    const t = setup();
    await t.fire("api_req_practice/battle", {}, { api_deck_id: "1" });
    await t.fire("api_req_practice/battle_result", { api_win_rank: "A" });
    await t.fire("api_req_practice/battle", {}, { api_deck_id: "1" });
    await t.fire("api_req_practice/battle_result", { api_win_rank: "B" });
    expect(t.counts()[EXERCISE]?.["@ex"]?.count).toBe(1);
    expect(t.counts()[EXERCISE]?.["@ex"]?.day).toBeNumber();

    await t.fire("api_req_mission/result", { api_clear_result: 0, api_quest_name: "海上護衛任務" }, { api_deck_id: "2" });
    expect(t.counts()[EXPEDITION]).toBeUndefined();
    await t.fire("api_req_mission/result", { api_clear_result: 1, api_quest_name: "海上護衛任務" }, { api_deck_id: "2" });
    expect(t.counts()[EXPEDITION]).toEqual({ "@m0": { count: 1 } });

    // poi removes the scrapped equipment before game.response: the counter looks them up in the previous state
    await t.fire("api_port/port");
    t.holder.state = { ...t.state, info: { ...t.state.info, equips: {} } };
    await t.fire("api_req_kousyou/destroyitem2", {}, { api_slotitem_ids: "501,502,503" });
    expect(t.counts()[SCRAP]).toEqual({ ".s0": { count: 2 } });
  });

  test("quests poi tracks and inactive quests are not counted", async () => {
    const t = setup();
    await t.fire("api_req_kousyou/createitem", { api_get_items: [{}, {}, {}] });
    expect(t.counts()[POI_TRACKED]).toBeUndefined();
    t.state.info.quests.activeQuests = active(EXERCISE);
    await sortie(t.fire, [2, 5], [{ no: 20, boss: true }]);
    expect(t.counts()[SORTIE]).toBeUndefined();
  });

  test("reset on reward (clearitemget) and when the 全て list no longer has the quest", async () => {
    const t = setup();
    await sortie(t.fire, [2, 5], [{ no: 20, boss: true }]);
    await t.fire("api_req_practice/battle", {}, { api_deck_id: "1" });
    await t.fire("api_req_practice/battle_result", { api_win_rank: "S" });
    expect(Object.keys(t.counts()).sort()).toEqual([String(SORTIE), String(EXERCISE)]);
    await t.fire("api_req_quest/clearitemget", {}, { api_quest_id: String(SORTIE) });
    expect(Object.keys(t.counts())).toEqual([String(EXERCISE)]);
    // another tab's list does not drop anything; the 全て tab without the quest does
    await t.fire("api_get_member/questlist", { api_list: [] }, { api_tab_id: "9" });
    expect(Object.keys(t.counts())).toEqual([String(EXERCISE)]);
    await t.fire("api_get_member/questlist", { api_list: [{ api_no: SCRAP }] }, { api_tab_id: "0" });
    expect(t.counts()).toEqual({});
    expect(t.changes.every((a) => a === "77")).toBe(true);
  });

  test("counts persist per admiral in IndexedDB", async () => {
    const db = new QuestProgressDb(new IDBFactory());
    await db.save("77", { [SORTIE]: { "@2-5": { count: 1 } } });
    await db.save("78", {});
    await db.close();
    expect(await db.load("77")).toEqual({ [SORTIE]: { "@2-5": { count: 1 } } });
    expect(await db.load("79")).toEqual({});
  });
});

describe("countedGoals → projectQuests", () => {
  test("active countable quests with their counts; poi's own records win", () => {
    const now = Date.UTC(2026, 9, 24, 3);
    const s = newState();
    const goals = countedGoals(s.info.quests, { [SORTIE]: { "@2-5": { count: 1 } } }, now, GOALS);
    expect(goals[SORTIE]).toEqual([
      { key: "@2-5", description: expect.stringContaining("2-5 ボス S勝利以上"), count: 1, required: 2, source: "kcsim" },
      { key: "@3-5", description: expect.stringContaining("3-5"), count: 0, required: 2, source: "kcsim" },
    ]);
    const projected = projectQuests(s.info.quests, null, goals);
    expect(projected.records[SORTIE]?.[0]?.source).toBe("kcsim");
    expect(projected.records[POI_TRACKED]).toEqual([{ key: "develop", description: null, count: 0, required: 1 }]);
  });
});
