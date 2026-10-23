import { expect, test } from "bun:test";
import type { EnemyCompSet } from "@shared/data/types";
import { normalizePreset } from "../../fleet/normalize";
import { DEFAULT_GAUGE, DEFAULT_SORTIE_GLOBAL, DEFAULT_SORTIE_MAP, addGauge, flagshipFcf, mapPrefsOf, sortieOptionsOf } from "./sortieConfig";

const retreat = { onHeavy: true, allowDamecon: true, onModerate: false };
const set = (difficulty: number): EnemyCompSet => ({ difficulty, retrievedAt: "t", periodStart: null, periodEnd: null, totalCount: 1, source: "kcnav", comps: [] });

test("defaults: no gauge, policy flags and per-map choices passed through", () => {
  const o = sortieOptionsOf({ ...DEFAULT_SORTIE_GLOBAL, ...retreat }, DEFAULT_SORTIE_MAP, []);
  expect(o).toEqual({
    retreat: { ...retreat, useFcf: true },
    underway: true,
    rations: true,
    advance: {},
    smoke: [],
    nodeEffects: {},
    extraPerSortie: {},
  });
});

test("gauge: hp final set and threshold; extra gauges become phases; morale, bucket minutes, consecutive", () => {
  const sets = [set(3), set(4)];
  const gauge = { ...DEFAULT_GAUGE, kind: "hp" as const, remaining: 1500, finalSetKey: "4:t", finalThreshold: 400, tank: "type1" as const };
  const two = addGauge(gauge);
  expect(two.extra).toEqual([{ kind: "hp", remaining: 1500, phase: undefined }]);
  const o = sortieOptionsOf(
    { ...DEFAULT_SORTIE_GLOBAL, ...retreat, bucketAboveMin: 90, consecutive: { enabled: true, waitMinutes: 5, untilMorale: 45 } },
    { ...DEFAULT_SORTIE_MAP, gauge: { ...two, extra: [{ kind: "tp", remaining: 300, tpPerSortie: 70, phase: 2 }], morale: { enabled: true, waitMinutes: 0, untilMorale: 40 } } },
    sets
  );
  const main = { kind: "hp" as const, remaining: 1500, finalThreshold: 400, finalSet: sets[1] };
  expect(o.gaugeInput).toEqual({ ...main, phases: [main, { kind: "tp", remaining: 300, tpPerSortie: 70, phase: 2 }], morale: { waitMinutes: 0, untilMorale: 40 } });
  expect(o.repair).toEqual({ bucketAboveSec: 5400 });
  expect(o.consecutive).toEqual({ waitMinutes: 5, untilMorale: 45 });
});

test("adding a gauge to an unset gauge starts an HP gauge", () => {
  expect(addGauge(DEFAULT_GAUGE)).toMatchObject({ kind: "hp", extra: [{ kind: "hp", remaining: 4 }] });
});

test("stored map prefs are completed with defaults", () => {
  expect(mapPrefsOf({ "1-5": { advance: { A: "retreat" } } }, "1-5")).toEqual({ ...DEFAULT_SORTIE_MAP, advance: { A: "retreat" } });
  expect(mapPrefsOf({ "1-5": { gauge: { kind: "kill" } as never } }, "1-5").gauge).toEqual({ ...DEFAULT_GAUGE, kind: "kill" });
  expect(mapPrefsOf({}, "2-1")).toEqual(DEFAULT_SORTIE_MAP);
});

test("command facility on the flagship (slots or reinforcement slot)", () => {
  const ship = { masterId: 1, level: 1, luckMod: 0, hpMod: 0, aswMod: 0, morale: 49, equips: [{ masterId: 2, improvement: 0, proficiency: 0 }, null] };
  expect(flagshipFcf(ship)).toBeUndefined();
  expect(flagshipFcf({ ...ship, exSlot: { masterId: 272, improvement: 0, proficiency: 0 } })).toBe(272);
  expect(flagshipFcf({ ...ship, equips: [null, { masterId: 107, improvement: 0, proficiency: 0 }] })).toBe(107);
  expect(flagshipFcf(undefined)).toBeUndefined();
});

test("presets: a stored 7-ship normal fleet becomes a striking force; other fleets keep 6 ships", () => {
  const ship = { masterId: 1 };
  const seven = Array.from({ length: 7 }, () => ship);
  expect(normalizePreset({ ships: seven }, () => "x", 0)).toMatchObject({ fleetType: "striking_force", ships: { length: 7 } });
  expect(normalizePreset({ fleetType: "striking_force", ships: [ship] }, () => "x", 0).fleetType).toBe("striking_force");
  expect(normalizePreset({ fleetType: "surface_task_force", ships: seven }, () => "x", 0).ships).toHaveLength(6);
});
