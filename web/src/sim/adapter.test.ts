import { describe, expect, test } from "bun:test";
import sample from "../sampleState.json";
import { SERVER_ESTIMATOR_SOURCE } from "@shared/data/types";
import type { ApiEquipment, ApiShip, ShipDetail } from "@shared/data/types";
import { importFromPoi, masterFromPoi } from "../fleet";
import type { MasterData, Preset } from "../fleet";
import {
  buildBattleInput,
  buildEnemyShips,
  buildFriendShips,
  applyBest,
  bestEstimates,
  enemyFormationOf,
  friendFleet,
  friendFormationOf,
  landBaseWaves,
} from "@shared/sim/adapter";

const master: MasterData = {
  ships: { 1: { api_id: 1, api_name: "テスト艦", api_stype: 3, api_ctype: 7, api_leng: 2, api_soku: 10, api_maxeq: [0, 6, 0], api_taik: [30, 40] } },
  equips: {
    10: { api_id: 10, api_name: "砲", api_type: [1, 1, 1, 1, 0], api_houg: 3, api_houm: 2, api_leng: 2 },
    20: { api_id: 20, api_name: "水偵", api_type: [5, 7, 10, 10, 0], api_saku: 6, api_houg: 1, api_baku: 1 },
  },
};

const preset: Preset = {
  id: "p", name: "t", createdAt: 0, updatedAt: 0, fleetType: "single", formation: "echelon",
  ships: [
    {
      masterId: 1, level: 50, luckMod: 0, hpMod: 0, aswMod: 0, morale: 40,
      equips: [{ masterId: 10, improvement: 4, proficiency: 0 }, { masterId: 20, improvement: 2, proficiency: 3 }, null],
      exSlot: null,
      observed: { maxHp: 35, nowHp: 30, firepower: 30, torpedo: 20, antiAir: 15, armor: 12, evasion: 40, asw: 25, los: 31, luck: 12, range: 2, speed: 10 },
    },
  ],
};

describe("buildFriendShips", () => {
  test("naked stats = observed − equipment (− fit bonus), equipment carried over", () => {
    const { input, warnings, fitSkipped } = buildFriendShips(preset, master);
    expect(warnings).toEqual([]);
    expect(fitSkipped).toBe(0);
    const s = input[0];
    expect(s).toMatchObject({ id: 1, shipType: 3, level: 50, maxHp: 35, morale: 40, range: 2, speed: 10 });
    expect(s.stats).toEqual({ firepower: 26, torpedo: 20, antiAir: 15, armor: 12, evasion: 40, asw: 25, los: 25, luck: 12 });
    expect(s.equipBonus).toBeUndefined();
    expect(s.slots).toHaveLength(3);
    expect(s.slots[0]).toMatchObject({ id: 10, types: [1, 1, 1, 1, 0], improvement: 4, stats: { firepower: 3, accuracy: 2, range: 2 } });
    expect(s.slots[0]!.planes).toBeUndefined();
    expect(s.slots[1]).toMatchObject({ id: 20, improvement: 2, proficiency: 3, planes: 6, stats: { los: 6, bombing: 1 } });
    expect(s.slots[2]).toBeNull();
  });

  test("fit bonus is subtracted from naked stats and reported in equipBonus", () => {
    const fit = [{ id: 1, ids: [10], types: null, bonuses: [{ shipX: [1], num: 1, bonus: { houg: 2, kaih: 1 } }] }];
    const { input } = buildFriendShips(preset, master, { fitBonuses: fit });
    expect(input[0].stats.firepower).toBe(24);
    expect(input[0].stats.evasion).toBe(39);
    expect(input[0].equipBonus).toEqual({ firepower: 2, evasion: 1 });
    // opt out: bonus stays in naked stats, as the contract allows
    const off = buildFriendShips(preset, master, { fitBonuses: fit, applyFit: false });
    expect(off.input[0].stats.firepower).toBe(26);
    expect(off.input[0].equipBonus).toBeUndefined();
  });

  test("manual ship without observed uses computed values and warns about unknowns", () => {
    const manual: Preset = { ...preset, ships: [{ ...preset.ships[0], observed: undefined }] };
    const { input, warnings } = buildFriendShips(manual, master);
    expect(input[0].maxHp).toBe(30); // Lv1 HP fallback
    expect(warnings.some((w) => w.includes("耐久が不明"))).toBe(true);
    expect(warnings.some((w) => w.includes("回避 が不明"))).toBe(true);
  });

  test("works on the bundled sample fleet", () => {
    const p = importFromPoi(sample, 0)!;
    const { input, warnings } = buildFriendShips(p, masterFromPoi(sample));
    expect(input).toHaveLength(6);
    expect(warnings).toEqual([]);
    expect(input.every((s) => s.maxHp > 0 && s.stats.firepower >= 0)).toBe(true);
  });
});

describe("buildEnemyShips", () => {
  const ships = new Map<number, ApiShip>([
    [1501, { id: 1501, name: "駆逐イ級", stype: 2, range: 1, speed: 10, slots: [0, 0], hp: 20 } as ApiShip],
    [1550, { id: 1550, name: "空母ヲ級", stype: 7, range: 2, speed: 10, slots: [10, 10], hp: 50 } as ApiShip],
  ]);
  const equips = new Map<number, ApiEquipment>([
    [1501, { id: 1501, name: "5inch単装砲", type: [1, 1, 1, 1, 0], fp: 1, tp: 0, aa: 0, ar: 0, bomb: 0, asw: 0, los: 0, acc: 0, ev: 0, luck: 0, range: 1 } as ApiEquipment],
    [1540, { id: 1540, name: "深海艦攻", type: [3, 8, 8, 8, 0], fp: 0, tp: 8, aa: 0, ar: 0, bomb: 0, asw: 0, los: 0, acc: 0, ev: 0, luck: 0, range: 1 } as ApiEquipment],
  ]);
  const details = new Map<number, ShipDetail>([
    [1501, { ship: ships.get(1501)!, estimates: [], best: { ev: { value: 14, confidence: "datamined", source: "x" }, asw: { value: 25, confidence: "datamined", source: "x" }, tacc: { value: 3, confidence: "placeholder", source: "y" } } }],
  ]);
  const lookup = { ship: (i: number) => ships.get(i), equip: (i: number) => equips.get(i), detail: (i: number) => details.get(i) };

  test("eParam stats, equipment, plane counts from master slots, best estimates", () => {
    const r = buildEnemyShips(
      [
        { shipId: 1501, level: 1, hp: 20, fp: 5, tp: 15, aa: 6, ar: 5, equips: [1501, -1] },
        { shipId: 1550, level: 5, hp: 50, fp: 30, tp: 0, aa: 20, ar: 20, equips: [1540, -1, -1] },
      ],
      lookup
    );
    const [dd, cv] = r.input;
    expect(dd).toMatchObject({ id: 1501, shipType: 2, level: 1, maxHp: 20, range: 1 });
    expect(dd.stats).toEqual({ firepower: 5, torpedo: 15, antiAir: 6, armor: 5, evasion: 14, asw: 25, los: 0, luck: 0 });
    // tacc (kcsim TACC) is torpedo-only, never the all-attack hiddenAccuracy
    expect(dd.torpedoAccuracy).toBe(3);
    expect(dd.hiddenAccuracy).toBeUndefined();
    expect(dd.slots[0]).toMatchObject({ id: 1501, stats: { firepower: 1, range: 1 } });
    expect(dd.slots[1]).toBeNull();
    expect(cv.slots[0]).toMatchObject({ id: 1540, planes: 10 });
    expect(cv.torpedoAccuracy).toBeUndefined();
    // missing estimate → warning + "unknown" reliability
    expect(r.warnings.some((w) => w.includes("空母ヲ級") && w.includes("推定値"))).toBe(true);
    expect(r.reliability.find((x) => x.shipId === 1501 && x.stat === "tacc")).toMatchObject({ confidence: "placeholder", value: 3 });
    expect(r.reliability.find((x) => x.shipId === 1501 && x.stat === "acc")).toMatchObject({ confidence: "unknown", value: null });
    expect(r.reliability.find((x) => x.shipId === 1550 && x.stat === "ev")).toMatchObject({ confidence: "unknown", value: null });
  });

  test("acc → hiddenAccuracy, tacc → torpedoAccuracy", () => {
    const ship = { shipType: 2, maxHp: 20, stats: { firepower: 5, torpedo: 15, antiAir: 6, armor: 5 }, slots: [] };
    const s = applyBest(ship, { acc: { value: 12, confidence: "observed", source: SERVER_ESTIMATOR_SOURCE } });
    expect(s.hiddenAccuracy).toBe(12);
    expect(s.torpedoAccuracy).toBeUndefined();
    const t = applyBest(ship, { tacc: { value: 70, confidence: "datamined", source: "kancolle-replay-shipdata" } });
    expect(t.torpedoAccuracy).toBe(70);
    expect(t.hiddenAccuracy).toBeUndefined();
  });

  test("skipHiddenStats leaves only the visible stats (the estimator decides the hidden ones)", () => {
    const r = buildEnemyShips([{ shipId: 1501, level: 1, hp: 20, fp: 5, tp: 15, aa: 6, ar: 5, equips: [] }], lookup, { skipHiddenStats: true });
    expect(r.input[0].stats).toEqual({ firepower: 5, torpedo: 15, antiAir: 6, armor: 5 });
    expect(r.input[0].torpedoAccuracy).toBeUndefined();
    expect(r.reliability).toEqual([]);
  });

  describe("server estimates (estimator:server) follow the setting", () => {
    const row = (stat: "ev" | "acc", value: number, confidence: "observed" | "datamined", source: string, n: number | null = null) =>
      ({ stat, value, confidence, sd: null, n, source, note: null, updatedAt: "2026-10-22T00:00:00Z" }) as const;
    const detail: ShipDetail = {
      ship: ships.get(1501)!,
      estimates: [
        row("ev", 17.5, "observed", SERVER_ESTIMATOR_SOURCE, 812),
        row("ev", 14, "datamined", "kancolle-replay-shipdata"),
        row("acc", 12, "observed", SERVER_ESTIMATOR_SOURCE, 400),
      ],
      best: {
        ev: { value: 17.5, confidence: "observed", source: SERVER_ESTIMATOR_SOURCE },
        acc: { value: 12, confidence: "observed", source: SERVER_ESTIMATOR_SOURCE },
        asw: { value: 25, confidence: "datamined", source: "x" },
      },
    };
    const withServer = new Map(details).set(1501, detail);
    const lk = { ...lookup, detail: (i: number) => withServer.get(i) };
    const comp = [{ shipId: 1501, level: 1, hp: 20, fp: 5, tp: 15, aa: 6, ar: 5, equips: [] as number[] }];

    test("on (default): the server's best is used", () => {
      for (const opts of [undefined, { useServerEstimates: true }]) {
        const r = buildEnemyShips(comp, lk, opts);
        expect(r.input[0].stats.evasion).toBe(17.5);
        expect(r.input[0].hiddenAccuracy).toBe(12);
        expect(r.reliability.find((x) => x.stat === "ev")).toMatchObject({ confidence: "observed", source: SERVER_ESTIMATOR_SOURCE, n: 812 });
      }
    });

    test("off: the server's values are ignored; the next best source or 0 is used", () => {
      const r = buildEnemyShips(comp, lk, { useServerEstimates: false });
      expect(r.input[0].stats.evasion).toBe(14);
      expect(r.input[0].stats.asw).toBe(25);
      expect(r.input[0].hiddenAccuracy).toBeUndefined();
      expect(r.reliability.find((x) => x.stat === "ev")).toMatchObject({ confidence: "datamined", source: "kancolle-replay-shipdata", n: null });
      expect(r.reliability.find((x) => x.stat === "acc")).toMatchObject({ confidence: "unknown", value: null });
    });

    test("bestEstimates without a server row returns best untouched", () => {
      expect(bestEstimates(details.get(1501), false)).toBe(details.get(1501)!.best);
    });
  });
});

describe("battle input", () => {
  test("formations and options", () => {
    expect(friendFormationOf(preset)).toBe("echelon");
    expect(enemyFormationOf({ formation: 4 })).toBe("echelon");
    expect(enemyFormationOf({ formation: 11 })).toBe("lineAhead");
    expect(enemyFormationOf({ formation: null })).toBe("lineAhead");
    const b = buildBattleInput({ ships: [], formation: "diamond" }, [], { kind: "dayNight", enemyFormation: "lineAhead" });
    expect(b).toEqual({ friend: { ships: [], formation: "diamond" }, enemy: { ships: [], formation: "lineAhead" }, options: { kind: "dayNight" } });
  });

  test("combined fleet: escort and type in the friend fleet; formations follow the fleet kind", () => {
    const combined: Preset = { ...preset, fleetType: "surface_task_force", formation: "combined_forward", escort: preset.ships };
    const build = buildFriendShips(combined, master);
    expect(build.combined).toBe("surface");
    expect(build.escort).toHaveLength(1);
    expect(friendFleet(build, friendFormationOf(combined))).toMatchObject({ formation: "combinedForward", combined: "surface", escort: [{ id: 1 }] });
    // a single-fleet formation on a combined preset (or the reverse) falls back to the kind's default
    expect(friendFormationOf({ fleetType: "carrier_task_force", formation: "echelon" })).toBe("combinedBattle");
    expect(friendFormationOf({ fleetType: "single", formation: "combined_battle" })).toBe("lineAhead");
    expect(friendFleet(buildFriendShips(preset, master))).toEqual({ ships: expect.any(Array) });
    expect(buildFriendShips({ ...combined, escort: [{ ...preset.ships[0], masterId: 999 }] }, master).warnings[0]).toStartWith("随伴1番艦");
  });

  test("land-base waves: sortie bases whose targets are the node, one wave per matching target; recon squadrons default to 4", () => {
    const lb = (mode: "sortie" | "defense", targets: [string, string]) => ({
      mode,
      squadrons: [{ masterId: 20, improvement: 0, proficiency: 7 }, null, { masterId: 10, improvement: 0, proficiency: 0, slotSize: 12 }, null],
      targets,
    });
    const waves = landBaseWaves([lb("sortie", ["J", "J"]), lb("sortie", ["F", "J"]), lb("defense", ["J", "J"]), lb("sortie", ["F", ""])], "J", master);
    expect(waves).toHaveLength(3);
    expect(waves[0].squadrons).toEqual([
      { id: 20, types: [5, 7, 10, 10, 0], stats: { los: 6, firepower: 1, bombing: 1 }, improvement: 0, proficiency: 7, planes: 4 },
      { id: 10, types: [1, 1, 1, 1, 0], stats: { firepower: 3, accuracy: 2, range: 2 }, improvement: 0, proficiency: 0, planes: 12 },
    ]);
    expect(buildBattleInput({ ships: [] }, [], { kind: "day", enemyFormation: "lineAhead", lbas: waves }).lbas).toHaveLength(3);
    expect("lbas" in buildBattleInput({ ships: [] }, [], { kind: "day", enemyFormation: "lineAhead", lbas: [] })).toBe(false);
  });
});
