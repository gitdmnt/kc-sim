import { describe, expect, test } from "bun:test";
import sample from "../../dev/sampleState.json";
import { buildCatalog, normalizeForSearch } from "./catalog";

describe("normalizeForSearch", () => {
  test("katakana/hiragana, width and case", () => {
    expect(normalizeForSearch("ヤマト")).toBe(normalizeForSearch("やまと"));
    expect(normalizeForSearch("ＡＢＣ 12")).toBe("abc12");
    expect(normalizeForSearch("Ｉｏｗａ")).toBe("iowa");
  });
});

describe("buildCatalog (sample state)", () => {
  const c = buildCatalog(sample);
  test("only player ships and equipment", () => {
    expect(c.shipOptions.length).toBeGreaterThan(30);
    expect(c.shipOptions.every((o) => o.value < 1500)).toBe(true);
    expect(c.equipOptions.every((o) => o.value <= 500)).toBe(true);
  });
  test("groups by ship type / equip type and finds by yomi", () => {
    const yamato = c.shipOptions.find((o) => o.label === "大和改二")!;
    expect(yamato.group).toBe("戦艦");
    expect(yamato.search).toContain("やまと");
    expect(c.equipOptions.find((o) => o.label === "零式艦戦52型")?.group).toBe("艦上戦闘機");
    expect(c.shipName(yamato.value)).toBe("大和改二");
    expect(c.shipName(99999)).toBe("艦#99999");
    expect(c.equipTypeName(75)).not.toBe("");
  });
  test("empty / missing state never throws", () => {
    expect(buildCatalog(undefined).shipOptions).toEqual([]);
    expect(buildCatalog({}).equipOptions).toEqual([]);
  });
});
