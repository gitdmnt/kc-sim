import { describe, expect, test } from "bun:test";
import { computeFitBonus, fitToEquipmentStats } from "./fit";
import type { FitEntry } from "./fit";

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

  test("num counts items; unsupported conditions are skipped, not applied", () => {
    const two: FitEntry = { id: 3, ids: [9], types: null, bonuses: [{ shipType: [2], num: 2, bonus: { houg: 1 } }] };
    const ship = { masterId: 1, stype: 2 };
    const g = { masterId: 9, type2: 1, improvement: 0 };
    expect(computeFitBonus(ship, [g], [two]).bonus).toEqual({});
    expect(computeFitBonus(ship, [g, g], [two]).bonus).toEqual({ houg: 1 });
    const unsupported: FitEntry = {
      id: 4, ids: [9], types: null,
      bonuses: [{ shipClass: [7], num: 1, bonusSR: { houg: 1 } }, { shipNationality: [1], bonus: { houg: 9 } }],
    };
    expect(computeFitBonus(ship, [g], [unsupported])).toEqual({ bonus: {}, skipped: 2 });
  });

  test("conversion to EquipmentStats", () => {
    expect(fitToEquipmentStats({ houg: 2, kaih: 1, tais: 3, leng: 1 })).toEqual({ firepower: 2, evasion: 1, asw: 3 });
  });
});
