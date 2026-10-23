import { describe, expect, test } from "bun:test";
import {
  combinedKouku,
  dayBattle,
  legacyHougeki,
  listItemsTorpedo,
  mapNext15J,
  mapNextSelect,
  mapStart15,
  mapinfoEvent,
  mapinfoNormal,
  midnightBattle,
  resultNoDrop,
  resultWithDrop,
  resultWithEscape,
  resultWithEventItems,
} from "./fixtures";
import {
  extractAttackEvents, extractBattleResult, extractCellData, extractEnemy, extractGauge, extractMapCell, splitDamage,
} from "@shared/capture/parser";

describe("extractGauge (mapinfo entry)", () => {
  test("event map: gauge number / type / HP / rank / state from api_eventmap", () => {
    expect(extractGauge(mapinfoEvent)).toEqual({
      gaugeNum: 2, gaugeType: 2, nowHp: 1200, maxHp: 1800, state: 2, rank: 3, cleared: 0, defeatCount: 0,
    });
  });
  test("normal map: cleared flag and defeat count only", () => {
    expect(extractGauge(mapinfoNormal)).toEqual({
      gaugeNum: null, gaugeType: null, nowHp: null, maxHp: null, state: null, rank: null, cleared: 1, defeatCount: 1,
    });
  });
  test("gauge fields directly on the entry are used when api_eventmap lacks them", () => {
    expect(extractGauge({ api_id: 571, api_gauge_num: 3, api_gauge_type: 3, api_eventmap: { api_now_maphp: 5, api_max_maphp: 50 } }))
      .toMatchObject({ gaugeNum: 3, gaugeType: 3, nowHp: 5, maxHp: 50 });
  });
  test("nothing readable", () => {
    expect(extractGauge(undefined)).toBeNull();
    expect(extractGauge({ api_id: 11 })).toBeNull();
  });
});

describe("extractBattleResult (battleresult)", () => {
  test("ship drop with rank and name", () => {
    expect(extractBattleResult(resultWithDrop)).toEqual({
      rank: "A", drop: { shipId: 230, name: "朝潮" }, escapeFlag: 0,
    });
  });
  test("no drop", () => {
    expect(extractBattleResult(resultNoDrop)).toEqual({ rank: "B", drop: null, escapeFlag: 0 });
  });
  test("FCF escape: api_escape_flag and api_escape idx / tow idx", () => {
    expect(extractBattleResult(resultWithEscape)).toEqual({
      rank: "S", drop: null, escapeFlag: 1, escape: { idx: [7], towIdx: [4], type: null },
    });
    expect(extractBattleResult({ ...resultWithEscape, api_escape_type: 1 })!.escape!.type).toBe(1);
  });
  test("use items and event items", () => {
    expect(extractBattleResult(resultWithEventItems)).toEqual({
      rank: "S", drop: { shipId: 401, name: "大和改二" }, escapeFlag: 0,
      useItem: { id: 44, name: "勲章" }, eventItems: [{ type: 1, id: 123, value: 1 }],
    });
  });
  test("not a battle result", () => {
    expect(extractBattleResult({})).toBeNull();
    expect(extractBattleResult(undefined)).toBeNull();
    expect(extractBattleResult({ api_win_rank: "S", api_get_ship: {}, api_get_eventitem: [null, { api_type: 1 }] }))
      .toEqual({ rank: "S", drop: null, escapeFlag: 0 });
  });
});

describe("map packets (api_req_map/start, next)", () => {
  test("start: first cell without api_from_no", () => {
    expect(extractMapCell(mapStart15)).toEqual({
      no: 1, from: null, colorNo: 4, eventId: 4, eventKind: 1, bossCellNo: 12, next: 1, selectCells: null,
    });
  });
  test("start: api_cell_data keeps every cell incl. the start and optional api_distance", () => {
    const cells = extractCellData(mapStart15)!;
    expect(cells.map((c) => c.no)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(cells[0]).toEqual({ no: 0, colorNo: 0, passed: 1, distance: null });
    expect(cells[6]).toEqual({ no: 6, colorNo: 4, passed: 0, distance: 3 });
    expect(cells[12]).toEqual({ no: 12, colorNo: 5, passed: 0, distance: null });
  });
  test("next: boss cell, terminal (api_next 0), api_from_no", () => {
    expect(extractMapCell(mapNext15J)).toEqual({
      no: 12, from: 7, colorNo: 5, eventId: 5, eventKind: 1, bossCellNo: 12, next: 0, selectCells: null,
    });
    expect(extractCellData(mapNext15J)).toBeNull();
  });
  test("next: active branching offers api_select_route cells", () => {
    expect(extractMapCell(mapNextSelect)).toMatchObject({ no: 3, from: 2, eventId: 6, eventKind: 2, next: 2, selectCells: [5, 6] });
  });
  test("malformed packets", () => {
    expect(extractMapCell(undefined)).toBeNull();
    expect(extractMapCell({ api_maparea_id: 1 })).toBeNull();
    expect(extractCellData({ api_cell_data: [{ api_no: 2 }, null, { api_color_no: 4 }] })).toEqual([
      { no: 2, colorNo: null, passed: null, distance: null },
    ]);
  });
});

describe("splitDamage", () => {
  test("strips the .1 cover flag", () => {
    expect(splitDamage(12.1)).toEqual({ damage: 12, protected: true });
    expect(splitDamage(30)).toEqual({ damage: 30, protected: false });
    expect(splitDamage(0.1)).toEqual({ damage: 0, protected: true });
    expect(splitDamage(undefined)).toEqual({ damage: 0, protected: false });
    expect(splitDamage(104.1)).toEqual({ damage: 104, protected: true });
  });
});

describe("extractAttackEvents: day battle", () => {
  const events = extractAttackEvents(dayBattle, "api_req_sortie/battle");
  const phase = (p: string) => events.filter((e) => e.phase === p);

  test("phase order and seq", () => {
    expect([...new Set(events.map((e) => e.phase))]).toEqual([
      "air", "opening_asw", "opening_torpedo", "shelling1", "shelling2", "closing_torpedo",
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  test("air stage3", () => {
    const air = phase("air");
    expect(air).toHaveLength(3);
    const friend = air.filter((e) => e.defenderSide === "friend");
    expect(friend).toEqual([
      expect.objectContaining({
        attackerSide: "enemy", attackerIdx: -1, defenderIdx: 1,
        hit: "crit", damage: 10, protected: true, airKind: "bomb", attackType: null,
      }),
    ]);
    const enemy = air.filter((e) => e.defenderSide === "enemy");
    expect(enemy[0]).toMatchObject({ defenderIdx: 0, hit: "hit", damage: 3, airKind: "both" });
    expect(enemy[1]).toMatchObject({ defenderIdx: 1, hit: "crit", damage: 7, airKind: "bomb" });
  });

  test("opening asw", () => {
    expect(phase("opening_asw")).toEqual([
      expect.objectContaining({
        attackerSide: "friend", attackerIdx: 2, defenderSide: "enemy", defenderIdx: 0,
        hit: "hit", damage: 4, attackType: 0,
      }),
    ]);
  });

  test("opening torpedo (legacy frai/fcl/fydam)", () => {
    const t = phase("opening_torpedo");
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      attackerSide: "friend", attackerIdx: 0, defenderSide: "enemy", defenderIdx: 2,
      hit: "crit", damage: 55, protected: false, attackType: null,
    });
    expect(t[1]).toMatchObject({
      attackerSide: "enemy", attackerIdx: 1, defenderSide: "friend", defenderIdx: 0,
      hit: "hit", damage: 9, protected: true,
    });
  });

  test("shelling1: eflag, double attack, hit kinds, protection, items", () => {
    const s = phase("shelling1");
    expect(s).toHaveLength(4);
    expect(s[0]).toMatchObject({
      attackerSide: "friend", attackerIdx: 0, defenderSide: "enemy", defenderIdx: 0,
      hit: "crit", damage: 35, protected: false, attackType: 0, displayItems: [1, 2],
    });
    expect(s[1]).toMatchObject({
      attackerSide: "enemy", attackerIdx: 1, defenderSide: "friend", defenderIdx: 2,
      hit: "hit", damage: 12, protected: true,
    });
    expect(s[1].displayItems).toBeUndefined();
    expect(s[2]).toMatchObject({ attackerIdx: 1, defenderIdx: 1, hit: "hit", damage: 20, attackType: 2 });
    expect(s[3]).toMatchObject({ attackerIdx: 1, defenderIdx: 1, hit: "miss", damage: 0, attackType: 2 });
  });

  test("shelling2 and closing torpedo", () => {
    expect(phase("shelling2")[0]).toMatchObject({ attackerSide: "enemy", hit: "miss", damage: 0 });
    expect(phase("closing_torpedo")).toEqual([
      expect.objectContaining({
        attackerSide: "friend", attackerIdx: 1, defenderIdx: 1, hit: "hit", damage: 18,
      }),
    ]);
  });
});

describe("extractAttackEvents: night & misc", () => {
  test("midnight uses api_sp_list and phase night", () => {
    const events = extractAttackEvents(midnightBattle, "api_req_battle_midnight/battle");
    expect(events.every((e) => e.phase === "night")).toBe(true);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      attackerSide: "friend", attackerIdx: 0, defenderIdx: 1, hit: "crit", damage: 40, attackType: 0,
    });
    expect(events[1]).toMatchObject({ attackerSide: "enemy", attackerIdx: 2, hit: "miss", damage: 0 });
    expect(events[2]).toMatchObject({ attackType: 1, hit: "hit", damage: 15, protected: false });
    expect(events[3]).toMatchObject({ attackType: 1, hit: "hit", damage: 16, protected: true });
  });

  test("plain api_hougeki in a day path is shelling1", () => {
    const events = extractAttackEvents({ api_hougeki: midnightBattle.api_hougeki }, "api_req_sortie/airbattle");
    expect(events[0].phase).toBe("shelling1");
  });

  test("night-to-day api_n_hougeki1/2", () => {
    const events = extractAttackEvents(
      { api_n_hougeki1: midnightBattle.api_hougeki, api_n_hougeki2: midnightBattle.api_hougeki },
      "api_req_sortie/night_to_day"
    );
    expect(events).toHaveLength(8);
    expect(events.every((e) => e.phase === "night")).toBe(true);
  });

  test("legacy -1 padded arrays", () => {
    const events = extractAttackEvents({ api_hougeki1: legacyHougeki }, "api_req_sortie/battle");
    expect(events).toEqual([
      expect.objectContaining({ attackerIdx: 0, defenderIdx: 1, damage: 8, hit: "hit", phase: "shelling1" }),
    ]);
  });

  test("api_frai_list_items format", () => {
    const events = extractAttackEvents(
      { api_opening_atack: listItemsTorpedo, api_raigeki: listItemsTorpedo },
      "api_req_sortie/battle"
    );
    const opening = events.filter((e) => e.phase === "opening_torpedo");
    expect(opening).toEqual([
      expect.objectContaining({ attackerSide: "friend", attackerIdx: 0, defenderIdx: 3, hit: "hit", damage: 10 }),
      expect.objectContaining({ attackerSide: "friend", attackerIdx: 0, defenderIdx: 4, hit: "crit", damage: 20, protected: true }),
      expect.objectContaining({ attackerSide: "enemy", attackerIdx: 1, defenderIdx: 0, hit: "miss", damage: 0 }),
    ]);
    expect(events.filter((e) => e.phase === "closing_torpedo")).toHaveLength(3);
  });

  test("combined escort stage3 gets +6 index", () => {
    const events = extractAttackEvents(combinedKouku, "api_req_combined_battle/battle");
    expect(events).toEqual([
      expect.objectContaining({ defenderSide: "friend", defenderIdx: 8, damage: 7, hit: "hit", airKind: "bomb" }),
    ]);
  });

  test("combined carrier battle puts torpedo before shelling2", () => {
    const body = { api_hougeki1: dayBattle.api_hougeki1, api_hougeki2: dayBattle.api_hougeki2, api_raigeki: dayBattle.api_raigeki };
    const seq = (p: string) => [...new Set(extractAttackEvents(body, p).map((e) => e.phase))];
    expect(seq("api_req_combined_battle/battle")).toEqual(["shelling1", "closing_torpedo", "shelling2"]);
    expect(seq("api_req_sortie/battle")).toEqual(["shelling1", "shelling2", "closing_torpedo"]);
  });

  test("garbage in, nothing out", () => {
    expect(extractAttackEvents(null)).toEqual([]);
    expect(extractAttackEvents({ api_hougeki1: "x", api_kouku: { api_stage3: null }, api_air_base_attack: [null] })).toEqual([]);
  });
});

describe("extractEnemy", () => {
  test("day battle enemy info", () => {
    const e = extractEnemy(dayBattle);
    expect(e.ships.map((s) => s.masterId)).toEqual([1501, 1502, 1503]);
    expect(e.ships[2]).toEqual({
      idx: 2, masterId: 1503, level: 1, maxHp: 16, nowHp: 16, slots: [503, 504], params: [7, 0, 7, 7],
    });
    expect([e.friendFormation, e.enemyFormation, e.engagement]).toEqual([1, 2, 1]);
    expect(e.escort).toEqual([]);
  });

  test("midnight has partial hp, combined escort is parsed", () => {
    expect(extractEnemy(midnightBattle).ships[0]).toMatchObject({ nowHp: 5, maxHp: 12 });
    const c = extractEnemy(combinedKouku);
    expect(c.escort.map((s) => [s.idx, s.masterId, s.level])).toEqual([[0, 1510, 5], [1, 1511, 6]]);
    expect(c.engagement).toBe(2);
  });

  test("missing fields", () => {
    const e = extractEnemy({});
    expect(e).toEqual({ ships: [], escort: [], friendFormation: null, enemyFormation: null, engagement: null });
    expect(extractEnemy(undefined).ships).toEqual([]);
  });
});

import { battleKindLabel } from "./labels";
describe("battleKindLabel", () => {
  test("paths", () => {
    expect(battleKindLabel("api_req_sortie/battle")).toBe("昼戦");
    expect(battleKindLabel("api_req_sortie/airbattle")).toBe("航空戦");
    expect(battleKindLabel("api_req_battle_midnight/battle")).toBe("夜戦");
    expect(battleKindLabel("api_req_combined_battle/battle_water")).toBe("連合 水上部隊");
    expect(battleKindLabel("api_req_sortie/ld_airbattle")).toBe("長距離空襲");
    expect(battleKindLabel("api_req_foo/bar")).toBe("bar");
  });
});
