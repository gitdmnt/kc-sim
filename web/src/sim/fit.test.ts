import { describe, expect, test } from "bun:test";
import { computeFitBonus, fitToEquipmentStats, shipBaseId } from "@shared/sim/fit";
import type { FitEntry } from "@shared/sim/fit";

const recon: FitEntry = {
  id: 0, ids: null, types: [9],
  bonuses: [
    { shipType: [7, 10, 11, 18], level: 2, num: 1, bonus: { saku: 1 } },
    { shipType: [7, 10, 11, 18], level: 4, num: 1, bonus: { houg: 1 } },
    { shipType: [7, 10, 11, 18], level: 10, num: 1, bonus: { houg: 1, saku: 1 } },
  ],
};
const seaplane: FitEntry = {
  id: 1, ids: null, types: [10],
  bonuses: [{ shipX: [662, 663], num: 1, bonus: { houg: 2, kaih: 1, tais: 3 } }],
};
const withRequires: FitEntry = {
  id: 2, ids: [42], types: null,
  bonuses: [{ shipX: [592], requires: [174], num: 1, bonus: { raig: 5 } }],
};

describe("computeFitBonus", () => {
  test("level thresholds stack, ship type filter", () => {
    const ship = { masterId: 1, stype: 11 };
    const at = (improvement: number) => computeFitBonus(ship, [{ masterId: 54, type2: 9, improvement }], [recon]).bonus;
    expect(at(0)).toEqual({});
    expect(at(2)).toEqual({ saku: 1 });
    expect(at(4)).toEqual({ saku: 1, houg: 1 });
    expect(at(10)).toEqual({ saku: 2, houg: 2 });
    expect(computeFitBonus({ masterId: 1, stype: 2 }, [{ masterId: 54, type2: 9, improvement: 10 }], [recon]).bonus).toEqual({});
  });

  test("ship id and equipment type match", () => {
    const e = [{ masterId: 100, type2: 10, improvement: 0 }];
    expect(computeFitBonus({ masterId: 662, stype: 3 }, e, [seaplane]).bonus).toEqual({ houg: 2, kaih: 1, tais: 3 });
    expect(computeFitBonus({ masterId: 1, stype: 3 }, e, [seaplane]).bonus).toEqual({});
  });

  test("requires needs another listed equipment", () => {
    const ship = { masterId: 592, stype: 2 };
    const a = { masterId: 42, type2: 24, improvement: 0 };
    expect(computeFitBonus(ship, [a], [withRequires]).bonus).toEqual({});
    expect(computeFitBonus(ship, [a, { masterId: 174, type2: 5, improvement: 0 }], [withRequires]).bonus).toEqual({ raig: 5 });
  });

  test("num counts items", () => {
    const two: FitEntry = { id: 3, ids: [9], types: null, bonuses: [{ shipType: [2], num: 2, bonus: { houg: 1 } }] };
    const ship = { masterId: 1, stype: 2 };
    const g = { masterId: 9, type2: 1, improvement: 0 };
    expect(computeFitBonus(ship, [g], [two]).bonus).toEqual({});
    expect(computeFitBonus(ship, [g, g], [two]).bonus).toEqual({ houg: 1 });
  });

  test("shipS matches the series base id; unknown base id is skipped", () => {
    const e: FitEntry = { id: 5, ids: [9], types: null, bonuses: [{ shipS: [34], bonus: { houg: 2 } }] };
    const g = { masterId: 9, type2: 1, improvement: 0 };
    expect(computeFitBonus({ masterId: 200, stype: 2, baseId: 34 }, [g], [e])).toEqual({ bonus: { houg: 2 }, skipped: 0 });
    expect(computeFitBonus({ masterId: 200, stype: 2, baseId: 35 }, [g], [e])).toEqual({ bonus: {}, skipped: 0 });
    expect(computeFitBonus({ masterId: 200, stype: 2 }, [g], [e])).toEqual({ bonus: {}, skipped: 1 });
    const master = { ships: { 34: { api_id: 34, api_aftershipid: "200" }, 200: { api_id: 200, api_aftershipid: "300" }, 300: { api_id: 300, api_aftershipid: "200" } } };
    expect(shipBaseId(300, master)).toBe(34);
    expect(shipBaseId(1, { ships: { 1: { api_id: 1 } } })).toBeUndefined();
  });

  test("shipNationality maps ctype to the EO country code", () => {
    const e: FitEntry = { id: 6, ids: [9], types: null, bonuses: [{ shipNationality: [4, 5], num: 1, bonus: { kaih: 1 } }] };
    const g = { masterId: 9, type2: 1, improvement: 0 };
    expect(computeFitBonus({ masterId: 1, stype: 2, ctype: 65 }, [g], [e]).bonus).toEqual({ kaih: 1 });
    expect(computeFitBonus({ masterId: 1, stype: 2, ctype: 67 }, [g], [e]).bonus).toEqual({ kaih: 1 });
    expect(computeFitBonus({ masterId: 1, stype: 2, ctype: 12 }, [g], [e])).toEqual({ bonus: {}, skipped: 0 });
    expect(computeFitBonus({ masterId: 1, stype: 2 }, [g], [e]).skipped).toBe(1);
  });

  test("requiresNum / requiresNumType count the other equipment", () => {
    const e: FitEntry = {
      id: 7, ids: [9], types: null,
      bonuses: [{ requires: [174], requiresNum: 2, bonus: { raig: 1 } }, { requiresType: [21], requiresNumType: 2, bonus: { tyku: 1 } }],
    };
    const ship = { masterId: 1, stype: 2 };
    const g = { masterId: 9, type2: 1, improvement: 0 };
    const r = { masterId: 174, type2: 5, improvement: 0 };
    const mg = { masterId: 50, type2: 21, improvement: 0 };
    expect(computeFitBonus(ship, [g, r], [e]).bonus).toEqual({});
    expect(computeFitBonus(ship, [g, r, r], [e]).bonus).toEqual({ raig: 1 });
    expect(computeFitBonus(ship, [g, mg, mg], [e]).bonus).toEqual({ tyku: 1 });
  });

  test("bonusSR / bonusAR / bonusAccR need a radar with the stat; missing stats are skipped", () => {
    const e: FitEntry = {
      id: 8, ids: [9], types: null,
      bonuses: [{ shipClass: [7], bonusSR: { houg: 1 } }, { shipClass: [7], bonusAR: { tyku: 2 } }, { shipClass: [7], bonusAccR: { houm: 3 } }],
    };
    const ship = { masterId: 1, stype: 2, ctype: 7 };
    const g = { masterId: 9, type2: 1, improvement: 0 };
    const radar = (saku: number, tyku: number, houm: number) => ({ masterId: 28, type2: 12, improvement: 0, saku, tyku, houm });
    expect(computeFitBonus(ship, [g], [e])).toEqual({ bonus: {}, skipped: 0 });
    expect(computeFitBonus(ship, [g, radar(5, 0, 3)], [e]).bonus).toEqual({ houg: 1 });
    expect(computeFitBonus(ship, [g, radar(4, 2, 8)], [e]).bonus).toEqual({ tyku: 2, houm: 3 });
    expect(computeFitBonus(ship, [g, { masterId: 28, type2: 12, improvement: 0 }], [e]).skipped).toBe(3);
  });

  test("conversion to EquipmentStats", () => {
    expect(fitToEquipmentStats({ houg: 2, kaih: 1, tais: 3, leng: 1 })).toEqual({ firepower: 2, evasion: 1, asw: 3 });
  });
});
