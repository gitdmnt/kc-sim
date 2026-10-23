import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { initSync, runBattle } from "@sim-core";
import type { BattleInput, ShipInput } from "@sim-core";
import { bonusAt, buildBonuses, debuffsAt } from "@shared/sim/bonuses";
import type { BuildBonusOptions, EventBonusEntry, EventBonusResponse } from "@shared/sim/bonuses";
import type { RoutingDoc } from "@shared/data/types";
import type { MasterData, Preset, PresetAirBase, PresetEquip, PresetShip } from "@shared/fleet/types";
import type { MapData } from "../data/mapData";
import { buildSortieInput } from "./sortieAdapter";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../sim-core/pkg/sim_core_bg.wasm", import.meta.url)) });
});

const entry = (nodes: string[] | null, b: Record<string, unknown>, nodesExclude: string[] | null = null): EventBonusEntry => ({ nodes, nodesExclude, ...b });
const response = (bonuses: EventBonusEntry[], lbasBonuses: EventBonusEntry[] = [], debuffs: EventBonusEntry[] = []): EventBonusResponse => ({
  map: "57-5", date: "2023-10-05", note: null, source: "kancolle-replay", revision: null, bonuses, lbasBonuses, debuffs,
});

// 駆逐艦 (ctype 28) の改装系列 1 → 2 → 3、軽巡 (stype 3)、空母 (stype 11)。装備は主砲 2、副砲高角砲 10、艦攻 16、陸攻 168。
const master: MasterData = {
  ships: {
    1: { api_id: 1, api_stype: 2, api_ctype: 28, api_aftershipid: "2", api_maxeq: [0, 0, 0, 0, 0] },
    2: { api_id: 2, api_stype: 2, api_ctype: 28, api_aftershipid: "3", api_maxeq: [0, 0, 0, 0, 0] },
    3: { api_id: 3, api_stype: 2, api_ctype: 28, api_aftershipid: "0", api_maxeq: [0, 0, 0, 0, 0] },
    20: { api_id: 20, api_stype: 3, api_ctype: 4, api_aftershipid: "0", api_maxeq: [0, 0, 0, 0, 0] },
    30: { api_id: 30, api_stype: 11, api_ctype: 3, api_aftershipid: "0", api_maxeq: [20, 20, 10, 5, 0] },
  },
  equips: {
    2: { api_id: 2, api_type: [1, 1, 1, 1, 0] },
    10: { api_id: 10, api_type: [1, 2, 4, 16, 0] },
    16: { api_id: 16, api_type: [3, 5, 8, 8, 0] },
    168: { api_id: 168, api_type: [21, 27, 47, 37, 0] },
  },
};
const eq = (masterId: number, improvement = 0): PresetEquip => ({ masterId, improvement, proficiency: 0 });
const ship = (masterId: number, equips: (PresetEquip | null)[] = [], exSlot: PresetEquip | null = null): PresetShip => ({
  masterId, level: 99, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips, exSlot,
});
const preset = (ships: PresetShip[], escort?: PresetShip[]): Preset => ({
  id: "p", name: "p", createdAt: 0, updatedAt: 0, fleetType: escort ? "carrier_task_force" : "single", formation: "line_ahead", ships, escort,
});

describe("buildBonuses", () => {
  test("ship filters, perEquip and per-node sets that replace `all`", () => {
    const res = response([
      entry(null, { dmg: 1.12, acc: 1.05, shipType: [2] }),
      entry(null, { dmg: 1.04, requireEquipId: [2], perEquip: 1 }),
      entry(["T"], { dmg: 1.1, shipClass: [28] }),
      entry(null, { dmg: 1.5, shipType: [3] }, ["T"]),
    ]);
    const out = buildBonuses(preset([ship(3, [eq(2), eq(2)]), ship(20)]), res, master);
    // DD: 1.12 × 1.04² everywhere, × 1.1 at T.
    expect(out.bonuses[0]).toEqual({ all: { dmg: 1.211392, acc: 1.05 }, nodes: { T: { dmg: 1.3325312, acc: 1.05 } } });
    // CL: 1.5 except at T, where the set is empty (no bonus there).
    expect(out.bonuses[1]).toEqual({ all: { dmg: 1.5 }, nodes: { T: {} } });
    expect(bonusAt(out.bonuses[1], "T")).toBeNull();
    expect(bonusAt(out.bonuses[1], "A")).toEqual({ dmg: 1.5 });
    expect(out.warnings).toEqual([]);
  });

  test("shipBase follows api_aftershipid; unknown remodel data is reported", () => {
    const res = response([entry(null, { dmg: 1.2, shipBase: [1] })]);
    expect(buildBonuses(preset([ship(3)]), res, master).bonuses[0]).toEqual({ all: { dmg: 1.2 } });
    const noRemodel: MasterData = { ...master, ships: Object.fromEntries(Object.entries(master.ships).map(([k, s]) => [k, { ...s!, api_aftershipid: undefined }])) };
    const out = buildBonuses(preset([ship(3)]), res, noRemodel);
    expect(out.bonuses[0]).toBeNull();
    expect(out.warnings[0]).toContain("shipBase");
  });

  test("unconfirmed entries and acc/eva modes", () => {
    const res = response([entry(null, { dmg: 1.2, acc: 1.1, eva: 1.05, shipType: [2] }), entry(null, { dmg: 1.5, unconfirmed: 1 })]);
    const at = (opts: BuildBonusOptions) => buildBonuses(preset([ship(3)]), res, master, opts).bonuses[0]?.all;
    expect(at({})).toEqual({ dmg: 1.2, acc: 1.1, eva: 1.05 });
    expect(at({ unconfirmed: true })).toEqual({ dmg: 1.8, acc: 1.1, eva: 1.05 });
    expect(at({ accEva: "none" })).toEqual({ dmg: 1.2 });
    expect(at({ accEva: "dmg" })).toEqual({ dmg: 1.2, acc: 1.2, eva: 1.2 });
    expect(at({ accEva: "half" })).toEqual({ dmg: 1.2, acc: 1.1, eva: 1.1 });
  });

  test("plane groups and kcsim HA-gun type 104", () => {
    const res = response([
      entry(null, { dmg: 1.1, isPlane: 1, requireEquipType: [8], perEquip: 1 }),
      entry(null, { dmg: 1.2, acc: 1.1, isPlane: 1, requireEquipId: [16], notAirOnly: 1 }),
      entry(null, { dmg: 1.3, requireEquipType: [104] }),
      entry(null, { dmg: 9, requireEquipType: [4] }),
    ]);
    const out = buildBonuses(preset([ship(30, [eq(16), eq(16), null, eq(10)])]), res, master);
    expect(out.bonuses[0]).toEqual({
      all: {
        dmg: 1.3,
        planes: [{ slots: [0], dmg: 1.1 }, { slots: [1], dmg: 1.1 }, { slots: [0, 1], dmg: 1.2, acc: 1.1, notAirOnly: true }],
      },
    });
  });

  test("land bases: compacted squadrons, basewide, perEquip and per-node", () => {
    const sq = (masterId: number): PresetEquip => ({ masterId, improvement: 0, proficiency: 7, slotSize: 18 });
    const base: PresetAirBase = { mode: "sortie", squadrons: [sq(168), null, sq(168), sq(16)], targets: ["Y", "Y"] };
    const res = response([], [
      entry(null, { dmg: 1.1, basewide: 1, requireEquipId: [168] }),
      entry(null, { dmg: 1.05, basewide: 1, requireEquipType: [47], perEquip: 1 }),
      entry(["Y"], { dmg: 1.2, acc: 1.1, requireEquipId: [16] }),
    ]);
    const out = buildBonuses(preset([ship(3)]), res, master, { lbas: [base] });
    const all = { dmg: 1.21275 };
    // Engine squadron order skips the empty slot: [168, 168, 16].
    expect(out.lbasBonuses![0]).toEqual({
      all: { squadrons: [all, all, all] },
      nodes: { Y: { squadrons: [all, all, { dmg: 1.4553, acc: 1.1 }] } },
    });
  });

  test("debuffs per node", () => {
    const res = response([], [], [entry(["Y"], { shipId: [1501], amount: 44 }), entry(null, { amount: 5 })]);
    expect(debuffsAt(res, "Y")).toEqual([{ shipId: [1501], amount: 44 }, { amount: 5 }]);
    expect(debuffsAt(res, "A")).toEqual([{ amount: 5 }]);
  });

  test("the engine accepts the output", () => {
    const res = response([entry(null, { dmg: 2, shipType: [2] })]);
    const built = buildBonuses(preset([ship(3)]), res, master);
    const dd: ShipInput = { shipType: 2, maxHp: 999, stats: { firepower: 50, torpedo: 0, antiAir: 0, armor: 200 }, slots: [], range: 1 };
    const enemy: ShipInput = { shipType: 9, maxHp: 999, stats: { firepower: 0, torpedo: 0, antiAir: 0, armor: 0 }, slots: [] };
    const input: BattleInput = {
      friend: { ships: [dd] }, enemy: { ships: [enemy] }, options: { log: true, engagement: "sameCourse" },
      bonuses: [bonusAt(built.bonuses[0], "A")],
    };
    const hits = (runBattle(input, 1).result.events ?? []).filter((e) => e.attackerSide === "friend" && e.hit === "hit");
    expect(hits.length).toBeGreaterThan(0);
    // ⌊50 + 5⌋ × 2 = 110 against armor 0.
    for (const h of hits) expect(h.damage).toBe(110);
  });
});

describe("buildSortieInput: event bonuses per node", () => {
  const routing: RoutingDoc = { map: "9-9", nodes: { Start: { rules: [{ to: "A" }] }, A: { rules: [{ to: "B" }] }, B: { end: true } } };
  const comp = (id: number) => ({
    difficulty: 0, retrievedAt: "x", periodStart: null, periodEnd: null, totalCount: 10, source: "kcnav",
    comps: [{ id, formation: 1, count: 10, weight: 1, airpower: [], main: [{ shipId: 1501, level: 1, hp: 20, fp: 5, tp: 15, aa: 6, ar: 5, equips: [] }], escort: [] }],
  });
  // Fixture with only the fields buildSortieInput reads (unchecked cast below).
  const fixture = {
    key: "9-9", source: "bundle" as const, stale: false,
    detail: {
      map: { id: 99, key: "9-9", world: 9, no: 9, name: "t", isEvent: true, maxHp: null, requiredDefeatCount: null },
      nodes: [
        { letter: "Start", x: 0, y: 0, colorNo: 0, eventId: 0, eventKind: null, type: "start", isBoss: false },
        { letter: "A", x: 1, y: 1, colorNo: 4, eventId: 4, eventKind: null, type: "battle", isBoss: false },
        { letter: "B", x: 2, y: 2, colorNo: 5, eventId: 5, eventKind: null, type: "boss", isBoss: true },
      ],
      edges: [], routing, enemyCompNodes: ["A", "B"],
    },
    comps: { A: [comp(1)], B: [comp(2)] },
    compSelection: {},
    ships: new Map([[1501, { ship: { id: 1501, name: "イ", stype: 2, speed: 10, range: 1, slotNum: 0, isAbyssal: true, hp: 20, fp: 5, tp: 15, aa: 6, ar: 5, slots: [], equips: [] }, estimates: [], best: {} }]]),
    equips: new Map(),
  };
  const data = fixture as unknown as MapData;
  const settings = { selects: {}, flags: {}, difficulty: 0, night: "bossOnly" as const, retreat: { onHeavy: true, allowDamecon: true, onModerate: false }, formations: {}, hqLevel: 100, applyFit: false };
  const dd = (): PresetShip => ({ ...ship(3), observed: { maxHp: 30, nowHp: 30, firepower: 10, torpedo: 20, antiAir: 5, armor: 5, evasion: 50, asw: 30, los: 20, luck: 10, range: 1, speed: 10 } });

  test("ship bonuses and debuffs land on the battle nodes", () => {
    const res = response([entry(null, { dmg: 1.3, shipType: [2] }), entry(["B"], { dmg: 2, shipType: [2] })], [], [entry(["B"], { shipId: [1501], amount: 4 })]);
    const p = preset([dd()]);
    const b = buildSortieInput(p, master, data, settings, { eventBonus: { response: res, debuff: true } });
    expect(b.input.map.nodes.A!.bonuses).toEqual([{ dmg: 1.3 }]);
    expect(b.input.map.nodes.B!.bonuses).toEqual([{ dmg: 2.6 }]);
    expect(b.input.map.nodes.A!.debuffs).toBeUndefined();
    expect(b.input.map.nodes.B!.debuffs).toEqual([{ shipId: [1501], amount: 4 }]);
    expect(b.input.map.nodes.Start!.bonuses).toBeUndefined();
    const off = buildSortieInput(p, master, data, settings, { eventBonus: { response: res, debuff: false } });
    expect(off.input.map.nodes.B!.debuffs).toBeUndefined();
    expect(buildSortieInput(p, master, data, settings).input.map.nodes.B!.bonuses).toBeUndefined();
  });
});
