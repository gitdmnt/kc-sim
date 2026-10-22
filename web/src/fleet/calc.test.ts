import { describe, expect, test } from "bun:test";
import {
  fleetFighterPower,
  losEquipScore,
  mapLos33,
  slotFighterPower,
  summarizeFleet,
} from "@shared/fleet/calc";
import { shipBoostedSpeed } from "@shared/fleet/speed";
import type { EquipMaster, MasterData, PresetShip, ShipMaster } from "@shared/fleet/types";
// Shared with sim-core routing::los33 (sim-core/tests/routing.rs los_formula_33_shared_vectors).
import losVectors from "../../../sim-core/tests/fixtures/los33-vectors.json";

const eq = (id: number, type2: number, extra: Partial<EquipMaster> = {}): EquipMaster => ({
  api_id: id,
  api_type: [0, 0, type2],
  ...extra,
});
const fighter = eq(1, 6, { api_tyku: 10 });

describe("slotFighterPower", () => {
  test("fighter, max proficiency", () => {
    // 10*sqrt(20) + sqrt(100/10) + 22 = 44.72 + 3.16 + 22 = 69.88
    expect(slotFighterPower(fighter, { improvement: 0, proficiency: 7 }, 20)).toBe(69);
  });
  test("fighter, ★10 adds 0.2 AA per star", () => {
    // 12*sqrt(20) = 53.66 + 3.16 + 22 = 78.8
    expect(slotFighterPower(fighter, { improvement: 10, proficiency: 7 }, 20)).toBe(78);
  });
  test("no proficiency", () => {
    expect(slotFighterPower(eq(2, 6, { api_tyku: 8 }), { improvement: 0, proficiency: 0 }, 18)).toBe(33);
  });
  test("proficiency table steps (fighter, AA 8, slot 4)", () => {
    // base 16; bonus sqrt(internal/10) + [0,0,2,5,9,14,14,22]
    const f = (p: number) => slotFighterPower(eq(3, 6, { api_tyku: 8 }), { improvement: 0, proficiency: p }, 4);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(f)).toEqual([16, 17, 19, 23, 27, 32, 32, 41]);
  });
  test("dive bomber with AA: only the 0.25★ bonus, no proficiency table", () => {
    const bakusen = eq(4, 7, { api_tyku: 4 });
    expect(slotFighterPower(bakusen, { improvement: 4, proficiency: 0 }, 16)).toBe(
      Math.floor((4 + 1) * 4)
    );
  });
  test("seaplane bomber uses its own bonus table", () => {
    const m = eq(5, 11, { api_tyku: 4 });
    expect(slotFighterPower(m, { improvement: 0, proficiency: 7 }, 12)).toBe(
      Math.floor(4 * Math.sqrt(12) + Math.sqrt(10) + 6)
    );
  });
  test("zero cases", () => {
    expect(slotFighterPower(eq(6, 9, { api_tyku: 0 }), { improvement: 0, proficiency: 7 }, 8)).toBe(0);
    expect(slotFighterPower(eq(7, 8, { api_tyku: 0, api_raig: 10 }), { improvement: 0, proficiency: 7 }, 8)).toBe(0);
    expect(slotFighterPower(fighter, { improvement: 0, proficiency: 7 }, 0)).toBe(0);
    expect(slotFighterPower(eq(8, 1, { api_tyku: 5 }), { improvement: 0, proficiency: 0 }, 10)).toBe(0); // gun
    expect(slotFighterPower(undefined, { improvement: 0, proficiency: 0 }, 10)).toBe(0);
  });
});

describe("fleetFighterPower", () => {
  const master: MasterData = {
    ships: { 1: { api_id: 1, api_maxeq: [20, 18, 0] } },
    equips: { 1: fighter },
  };
  const ship = (equips: PresetShip["equips"]): PresetShip => ({
    masterId: 1, level: 99, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips,
  });
  test("uses explicit slotSize, else master maxeq", () => {
    const e = { masterId: 1, improvement: 0, proficiency: 0 };
    expect(fleetFighterPower([ship([{ ...e, slotSize: 4 }, null])], master)).toBe(20); // 10*2
    expect(fleetFighterPower([ship([e, { ...e }])], master)).toBe(
      Math.floor(10 * Math.sqrt(20)) + Math.floor(10 * Math.sqrt(18))
    );
    expect(fleetFighterPower([], master)).toBe(0);
  });
});

describe("mapLos33", () => {
  test("bare ships only: 6 ships, HQ 120", () => {
    const ships = Array.from({ length: 6 }, () => ({ bareLos: 16, equips: [] }));
    expect(mapLos33(ships, 120)).toBeCloseTo(6 * 4 - 48, 10);
  });
  test("fewer than 6 ships gets +2 per empty slot; HQ term is ceil(0.4*lv)", () => {
    const ships = Array.from({ length: 5 }, () => ({ bareLos: 16, equips: [] }));
    expect(mapLos33(ships, 120)).toBeCloseTo(5 * 4 - 48 + 2, 10);
    expect(mapLos33(ships, 111)).toBeCloseTo(5 * 4 - 45 + 2, 10); // ceil(44.4)
  });
  test("equipment coefficients, improvement bonus and cn", () => {
    const ships = [
      { bareLos: 16, equips: [{ type2: 10, los: 7, improvement: 0 }] }, // 1.2*7 = 8.4
      { bareLos: 16, equips: [{ type2: 12, los: 5, improvement: 4 }] }, // 0.6*(5+1.25*2) = 4.5
    ];
    expect(mapLos33(ships, 120, 1)).toBeCloseTo(12.9 + 8 - 48 + 8, 10);
    expect(mapLos33(ships, 120, 4)).toBeCloseTo(12.9 * 4 + 8 - 48 + 8, 10);
  });
  test("per-type scores", () => {
    expect(losEquipScore({ type2: 8, los: 5, improvement: 0 })).toBeCloseTo(4);
    expect(losEquipScore({ type2: 9, los: 9, improvement: 0 })).toBeCloseTo(9);
    expect(losEquipScore({ type2: 11, los: 5, improvement: 9 })).toBeCloseTo(1.1 * (5 + 1.15 * 3));
    expect(losEquipScore({ type2: 13, los: 10, improvement: 1 })).toBeCloseTo(0.6 * (10 + 1.4));
    expect(losEquipScore({ type2: 1, los: 2, improvement: 10 })).toBeCloseTo(1.2);
  });
});

describe("mapLos33 shared vectors (sim-core)", () => {
  for (const v of losVectors.vectors) {
    test(v.name, () => {
      const ships = v.ships.map((s) => ({ bareLos: s.nakedLos, equips: s.equips.map((e) => ({ type2: e.cat, los: e.los, improvement: e.improvement })) }));
      for (const cn of [1, 2, 3, 4] as const) expect(mapLos33(ships, v.hq, cn)).toBeCloseTo(v.expected[`cn${cn}`], 9);
    });
  }
  test("dive bombers count 0.6, carrier recon gets 1.2√★", () => {
    expect(losEquipScore({ type2: 7, los: 5, improvement: 0 })).toBeCloseTo(3);
    expect(losEquipScore({ type2: 9, los: 9, improvement: 4 })).toBeCloseTo(9 + 2.4);
  });
});

describe("summarizeFleet", () => {
  const master: MasterData = {
    ships: { 1: { api_id: 1 }, 2: { api_id: 2 } },
    equips: {
      10: eq(10, 10, { api_saku: 7 }),
      13: eq(13, 12, { api_saku: 5 }),
      75: eq(75, 24),
    },
  };
  const ship = (id: number, observed: PresetShip["observed"], equips: PresetShip["equips"]): PresetShip => ({
    masterId: id, level: 99, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips, observed,
  });
  const e = (id: number, improvement = 0) => ({ masterId: id, improvement, proficiency: 0 });

  test("speed, LoS from observed (equipment subtracted), drums, radars", () => {
    const ships = [
      ship(1, { speed: 10, los: 30 }, [e(10), e(13), null]),
      ship(2, { speed: 5, los: 20 }, [e(75), e(75)]),
    ];
    const s = summarizeFleet(ships, master, 120);
    expect(s.speed).toBe(5);
    expect(s.drums).toEqual({ total: 2, ships: 1 });
    expect(s.radars).toBe(1);
    // bare: 30-12=18, 20 ; equip: 1.2*7 + 0.6*5 = 11.4
    const expected = 11.4 + Math.sqrt(18) + Math.sqrt(20) - 48 + 8;
    expect(s.los!.cn1).toBeCloseTo(expected, 8);
    expect(s.los!.cn3).toBeCloseTo(11.4 * 3 + Math.sqrt(18) + Math.sqrt(20) - 48 + 8, 8);
    expect(s.fighterPower).toBe(0);
  });

  test("unknown LoS gives null", () => {
    const s = summarizeFleet([ship(1, undefined, [])], master);
    expect(s.los).toBeNull();
    expect(s.speed).toBeNull();
  });
});

describe("speed boost from turbine and boilers (wikiwiki 速力 table)", () => {
  const mk = (api_name: string, api_soku: number, api_stype = 2): ShipMaster => ({ api_id: 1, api_name, api_soku, api_stype });
  const eqs = (...list: [number, number?][]) => list.map(([masterId, improvement = 0]) => ({ masterId, improvement, proficiency: 0 }));
  const speed = (m: ReturnType<typeof mk>, equips: ReturnType<typeof eqs>) => shipBoostedSpeed(m, equips);
  const T = [33] as [number];
  const E = [34] as [number];
  const B = [87] as [number];

  test("slow battleship (low B): 2 boiler slots → fast, 3 → fast+, never fastest", () => {
    const bb = mk("扶桑", 5, 9);
    expect(speed(bb, eqs(T, E)).value).toBe(10);
    expect(speed(bb, eqs(T, B, E)).value).toBe(10);
    expect(speed(bb, eqs(T, B, B)).value).toBe(15);
    expect(speed(bb, eqs(T, E, E, E)).value).toBe(15);
    expect(speed(bb, eqs(T, B, B, B)).value).toBe(15);
    expect(speed(bb, eqs(E, E)).value).toBe(5);
  });

  test("fast ship groups: A reaches fastest with one new boiler, B2 needs two", () => {
    expect(speed(mk("島風", 10), eqs(T, B)).value).toBe(20);
    expect(speed(mk("島風", 10), eqs(B, B)).value).toBe(10);
    expect(speed(mk("島風", 10), eqs([87, 7], [87, 7])).value).toBe(20);
    expect(speed(mk("吹雪", 10), eqs(T, B)).value).toBe(15);
    expect(speed(mk("吹雪", 10), eqs(T, B, B)).value).toBe(20);
    expect(speed(mk("金剛", 10, 8), eqs(T, B, E)).value).toBe(20);
    expect(speed(mk("加賀", 10, 11), eqs(T, B, B, B)).value).toBe(15);
  });

  test("star-7 new boiler counts for turbine-less and low A ships", () => {
    expect(speed(mk("大和", 5, 9), eqs(T, B)).value).toBe(10);
    expect(speed(mk("大和", 5, 9), eqs(T, [87, 7])).value).toBe(15);
    expect(speed(mk("Samuel B.Roberts", 5), eqs(T)).value).toBe(10);
  });

  test("no equipment keeps the base speed; unlisted ships are flagged as guessed", () => {
    expect(speed(mk("吹雪", 10), eqs())).toEqual({ value: 10, guessed: false });
    expect(speed(mk("吹雪", 10), eqs(T, B))).toEqual({ value: 15, guessed: true });
    expect(speed(mk("島風", 10), eqs(T, B)).guessed).toBe(false);
  });
});
