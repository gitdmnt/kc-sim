import { describe, expect, test } from "bun:test";
import sample from "../sampleState.json";
import { buildCatalog } from "./catalog";
import { buildEquipPicker, canEquip, equipCategory, equipKey, EQUIP_CATEGORIES, ownedEquipGroups, ownedShips, selectedEquipKey } from "./owned";

const catalog = buildCatalog(sample);

describe("ownedEquipGroups", () => {
  test("groups instances by master id, ★ and 熟練", () => {
    const state = {
      info: {
        equips: {
          1: { api_slotitem_id: 6, api_level: 3, api_alv: 0 },
          2: { api_slotitem_id: 6, api_level: 3, api_alv: 0 },
          3: { api_slotitem_id: 6, api_level: 0, api_alv: 0 },
          4: { api_slotitem_id: 20, api_level: 0, api_alv: 7 },
        },
      },
    };
    const groups = ownedEquipGroups(state);
    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.masterId === 6 && g.improvement === 3)?.count).toBe(2);
    expect(groups.find((g) => g.masterId === 20)?.proficiency).toBe(7);
  });
  test("missing state gives nothing", () => {
    expect(ownedEquipGroups(null)).toEqual([]);
    expect(ownedEquipGroups({})).toEqual([]);
  });
});

describe("canEquip", () => {
  // 軽巡 (stype 3) は大口径主砲 (type[2]=3) を積めない。榛名改二 (戦艦) は積める
  const cruiser = Object.values(catalog.master.ships).find((s) => s?.api_stype === 3 && s.api_id < 1500)!.api_id;
  const battleship = 151;
  const bigGun = Object.values(catalog.master.equips).find((e) => e?.api_type?.[2] === 3 && e.api_id <= 500)!.api_id;
  test("uses the ship type table", () => {
    expect(canEquip(sample, catalog, cruiser, bigGun)).toBe(false);
    expect(canEquip(sample, catalog, battleship, bigGun)).toBe(true);
  });
  test("no ship or no table means no restriction", () => {
    expect(canEquip(sample, catalog, undefined, bigGun)).toBe(true);
    expect(canEquip({ info: {} }, catalog, cruiser, bigGun)).toBe(true);
  });
});

describe("buildEquipPicker", () => {
  test("without owned equipment it is the plain master list", () => {
    const p = buildEquipPicker(catalog, { ...sample, info: { ...sample.info, equips: {} } });
    expect(p.options).toHaveLength(catalog.equipOptions.length);
    expect(p.options.every((o) => !o.dim)).toBe(true);
  });

  test("owned groups come first with ★/count, unowned follow dimmed", () => {
    const p = buildEquipPicker(catalog, sample);
    const firstUnowned = p.options.findIndex((o) => o.dim);
    expect(firstUnowned).toBeGreaterThan(0);
    expect(p.options.slice(0, firstUnowned).every((o) => !o.dim && o.group?.startsWith("所持・"))).toBe(true);
    expect(p.options.slice(firstUnowned).every((o) => o.dim)).toBe(true);

    const ownedIds = new Set(ownedEquipGroups(sample).map((g) => g.masterId));
    expect(p.options.slice(firstUnowned).some((o) => ownedIds.has(o.value))).toBe(false);

    // 12.7cm連装砲 ★10 / ★7 (sample には id=9 が ★10 と ★7 で所持される)
    const star10 = p.options.find((o) => o.key === equipKey(9, 10, 0))!;
    expect(star10.sub).toContain("★10");
    expect(star10.sub).toContain("×");
    expect(p.choices.get(star10.key!)).toEqual({ masterId: 9, improvement: 10, proficiency: 0 });
    const keys = p.options.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("ship filter drops unequippable owned and master items", () => {
    const all = buildEquipPicker(catalog, sample);
    const cruiser = Object.values(catalog.master.ships).find((s) => s?.api_stype === 3 && s.api_id < 1500)!.api_id;
    const forCruiser = buildEquipPicker(catalog, sample, cruiser);
    expect(forCruiser.options.length).toBeLessThan(all.options.length);
    expect(forCruiser.options.every((o) => canEquip(sample, catalog, cruiser, o.value))).toBe(true);
  });

  test("selectedEquipKey prefers the exact owned group", () => {
    const p = buildEquipPicker(catalog, sample);
    expect(selectedEquipKey(p, { masterId: 9, improvement: 10, proficiency: 0 })).toBe(equipKey(9, 10, 0));
    expect(selectedEquipKey(p, { masterId: 9, improvement: 4, proficiency: 0 })).toBe("m:9");
    expect(selectedEquipKey(p, null)).toBeUndefined();
  });
});

describe("ownedShips", () => {
  const [a, b] = Object.values(catalog.master.ships).filter((s) => s && s.api_id < 1500).map((s) => s!.api_id);
  const state = {
    info: {
      ships: {
        1: { api_id: 1, api_ship_id: a, api_lv: 50 },
        2: { api_id: 2, api_ship_id: a, api_lv: 99 },
        3: { api_id: 3, api_ship_id: 99999, api_lv: 120 },
        4: { api_id: 4, api_ship_id: b, api_lv: 99 },
      },
    },
  };
  test("sorts by level descending and drops ships missing from the master", () => {
    const ships = ownedShips(state, catalog);
    expect(ships.map((s) => s.instanceId)).toHaveLength(3);
    expect(ships.map((s) => s.level)).toEqual([99, 99, 50]);
    expect(ships[2].instanceId).toBe(1);
  });
  test("no poi state gives nothing", () => {
    expect(ownedShips(null, catalog)).toEqual([]);
    expect(ownedShips({}, catalog)).toEqual([]);
  });
});

describe("equipCategory", () => {
  test("groups the gun, plane and anti-submarine types, rest are その他", () => {
    const label = (t: number) => EQUIP_CATEGORIES[equipCategory(t)].label;
    expect([1, 2, 3].map(label)).toEqual(["主砲", "主砲", "主砲"]);
    expect([4, 5, 6, 7, 8, 10, 14, 15].map(label)).toEqual(["副砲", "魚雷", "艦戦", "艦爆", "艦攻", "水偵", "ソナー", "爆雷"]);
    expect([label(23), label(undefined as unknown as number)]).toEqual(["その他", "その他"]);
  });
});
