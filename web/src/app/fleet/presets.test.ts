import { describe, expect, test } from "bun:test";
import sample from "../../sampleState.json";
import { buildCatalog } from "../../fleet/catalog";
import { blankPreset, defaultSlotSize, newShipFor } from "./presets";

const catalog = buildCatalog(sample);
const yamato = catalog.shipOptions.find((o) => o.label === "大和改二")!.value;
const mutsuki = catalog.shipOptions.find((o) => o.label === "睦月改二")!.value;

describe("preset helpers", () => {
  test("blankPreset is a manual single fleet", () => {
    const p = blankPreset();
    expect(p).toMatchObject({ fleetType: "single", formation: "line_ahead", ships: [], source: "manual", hqLevel: 120 });
  });

  test("newShipFor sizes equips to the master's slot count", () => {
    const s = newShipFor(yamato, catalog);
    expect(s.equips).toHaveLength(catalog.master.ships[yamato]!.api_slot_num!);
    expect(s.equips.every((e) => e === null)).toBe(true);
    expect(s).toMatchObject({ level: 99, luckMod: 0, morale: 49, exSlot: null });
    expect(s.observed).toBeUndefined();
  });

  test("changing the ship keeps level/mods/equips that still fit and drops observed", () => {
    const base = {
      ...newShipFor(yamato, catalog),
      level: 120,
      luckMod: 4,
      observed: { maxHp: 100 },
    };
    base.equips[0] = { masterId: 3, improvement: 5, proficiency: 0 };
    base.equips[3] = { masterId: 4, improvement: 0, proficiency: 0 };
    const next = newShipFor(mutsuki, catalog, base);
    expect(next.masterId).toBe(mutsuki);
    expect(next.level).toBe(120);
    expect(next.luckMod).toBe(4);
    expect(next.equips).toHaveLength(catalog.master.ships[mutsuki]!.api_slot_num!);
    expect(next.equips[0]?.masterId).toBe(3);
    expect(next.observed).toBeUndefined();
  });

  test("defaultSlotSize reads api_maxeq", () => {
    expect(defaultSlotSize(catalog, yamato, 0)).toBe(catalog.master.ships[yamato]!.api_maxeq![0]);
    expect(defaultSlotSize(catalog, 99999, 0)).toBeUndefined();
  });
});
