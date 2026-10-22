import { describe, expect, test } from "bun:test";
import { EQUIP_CATEGORY_COLOR, EQUIP_ICON_CATEGORIES, equipIconCategory } from "./EquipIcon";

describe("equipIconCategory", () => {
  test("maps known icon ids", () => {
    expect(equipIconCategory(1)).toBe("smallGun");
    expect(equipIconCategory(3)).toBe("largeGun");
    expect(equipIconCategory(5)).toBe("torpedo");
    expect(equipIconCategory(11)).toBe("radar");
    expect(equipIconCategory(38)).toBe("fighter");
  });
  test("unknown ids fall back to other", () => {
    expect(equipIconCategory(0)).toBe("other");
    expect(equipIconCategory(-1)).toBe("other");
    expect(equipIconCategory(999)).toBe("other");
  });
  test("every category has a colour", () => {
    for (const c of EQUIP_ICON_CATEGORIES) expect(EQUIP_CATEGORY_COLOR[c]).toMatch(/^#/);
  });
});
