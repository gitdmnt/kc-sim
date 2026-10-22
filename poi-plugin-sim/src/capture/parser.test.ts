import { describe, expect, test } from "bun:test";
import {
  combinedKouku,
  dayBattle,
  legacyHougeki,
  listItemsTorpedo,
  midnightBattle,
} from "./fixtures";
import { extractAttackEvents, extractEnemy, splitDamage } from "./parser";

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
