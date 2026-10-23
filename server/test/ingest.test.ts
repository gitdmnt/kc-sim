import { describe, expect, test } from "bun:test";
import { lit, upsert, sourceRef } from "../scripts/lib/sql";
import { parseShipData } from "../scripts/ingest-abyssal";
import { applyEdgeCorrections, buildGraphs } from "../scripts/ingest-map-graph";
import { nodeTypeFromEvent, normalizeLetter, parseMapKey } from "../src/maps";

describe("sql builders", () => {
  test("literals", () => {
    expect(lit(null)).toBe("NULL");
    expect(lit("O'Brien")).toBe("'O''Brien'");
    expect(lit(true)).toBe("1");
    expect(lit([1, "a"])).toBe(`'[1,"a"]'`);
    expect(() => lit(Number.NaN)).toThrow();
  });
  test("upsert splits large batches and supports ignore + raw refs", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: "x".repeat(50), source_id: sourceRef("k") }));
    const stmts = upsert("t", rows, ["id"]);
    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) expect(s.length).toBeLessThan(100_000);
    expect(stmts[0]).toContain("(SELECT id FROM sources WHERE key = 'k')");
    expect(stmts[0]).toContain("DO UPDATE SET name = excluded.name");
    expect(upsert("t", rows.slice(0, 1), ["id"], "ignore")[0]).toContain("DO NOTHING");
  });
});

describe("map naming", () => {
  test("map keys", () => {
    expect(parseMapKey("1-5")).toEqual({ id: 15, world: 1, no: 5 });
    expect(parseMapKey("621")).toEqual({ id: 621, world: 62, no: 1 });
    expect(parseMapKey("x")).toBeNull();
  });
  test("start letters", () => {
    expect(normalizeLetter("Start", false)).toBe("Start");
    expect(normalizeLetter("Start 2", true)).toBe("Start2");
    expect(normalizeLetter("1", false)).toBe("Start");
    expect(normalizeLetter("2", true)).toBe("Start2");
    expect(normalizeLetter("B1", true)).toBe("B1");
  });
  test("node types from kcwiki (id, kind) combinations", () => {
    expect(nodeTypeFromEvent(4, 1)).toBe("battle");
    expect(nodeTypeFromEvent(4, 6)).toBe("air_raid");
    expect(nodeTypeFromEvent(5, 5)).toBe("boss");
    expect(nodeTypeFromEvent(6, 2)).toBe("select");
    expect(nodeTypeFromEvent(6, 0)).toBe("empty");
    expect(nodeTypeFromEvent(9, 0)).toBe("landing");
    expect(nodeTypeFromEvent(4, 7)).toBe("night_to_day");
  });
});

test("kcSHIPDATA parsing keeps provenance flags", () => {
  const code = `var SHIPDATA = {
    1: { name: 'Mutsuki', type: 'DD', HP: 13 },
    1501: { name: 'DD I-Class', nameJP: '駆逐イ級', type: 'DD', HP: 20, FP: 5, TP: 15, AA: 6, AR: 5, EV: 14, ASW: 25, LOS: 3, LUK: 1, RNG: 1, SPD: 10, SLOTS: [0,0], EQUIPS: [1501] },
    2000: { name: 'X', nameJP: 'X', type: 'BB', HP: 900, EV: 60, LOS: 100, LUK: 100, TACC: 100, unknownstats: { EV: 3, LOS: 2, LUK: 2, TACC: 2 }, canOpTorp: function() { return true; }, installtype: 2 },
    9001: { name: 'custom' },
  };`;
  const rows = parseShipData(code);
  expect(rows.map((r) => r.id)).toEqual([1501, 2000]);
  expect(rows[0]!.ship).toMatchObject({ name: "駆逐イ級", name_en: "DD I-Class", stype: 2, hp: 20, equips: [1501] });
  expect(rows[0]!.estimates.find((e) => e.stat === "ev")).toEqual({ stat: "ev", value: 14, confidence: "datamined" });
  const est = Object.fromEntries(rows[1]!.estimates.map((e) => [e.stat, e.confidence]));
  expect(est).toEqual({ ev: "db_estimate", los: "placeholder", luck: "placeholder", tacc: "placeholder" });
  expect(rows[1]!.ship.flags).toEqual({ canOpTorp: "function", installtype: 2 });
});

test("edge corrections override KC3 edges and split merged starts", () => {
  const kc3 = { "World 6-4": { "1": ["Start", "A"], "2": ["Start", "B"], "3": ["A", "B"] }, "World 7-4": { "1": ["Start", "A"], "3": ["A", "C"] } } as Record<string, Record<string, [string, string]>>;
  const fixed = applyEdgeCorrections(kc3, { "6-4": { "1": ["Start 1", "A"], "2": ["Start 2", "B"] }, "7-4": { "3": ["Start", "C"] } });
  expect(kc3["World 7-4"]!["3"]).toEqual(["A", "C"]);
  const graphs = buildGraphs(fixed, {}, {});
  expect(graphs.find((x) => x.mapId === 64)!.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["Start1>A", "Start2>B", "A>B"]);
  expect(graphs.find((x) => x.mapId === 74)!.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["Start>A", "Start>C"]);
});

test("graph building normalises starts and attaches kcwiki node types", () => {
  const graphs = buildGraphs(
    { "World 62-1": { "1": ["Start 1", "A"], "2": ["Start 2", "B"], "3": ["A", "B"] }, "World 1-1": { "1": ["Start", "A"] } },
    { "World 62-1": { letters: { A: [10, 20] } } },
    { "621": { A: { color: 4, id: 4, kind: 1, type: "Normal" }, B: { color: 5, id: 5, kind: 1, type: "Boss" } } },
  );
  const g = graphs.find((x) => x.mapId === 621)!;
  expect(g.edges).toEqual([
    { edge_id: 1, from: "Start1", to: "A" }, { edge_id: 2, from: "Start2", to: "B" }, { edge_id: 3, from: "A", to: "B" },
  ]);
  expect(g.nodes.find((n) => n.letter === "A")).toMatchObject({ x: 10, y: 20, node_type: "battle", is_boss: false });
  expect(g.nodes.find((n) => n.letter === "B")).toMatchObject({ node_type: "boss", is_boss: true });
  expect(graphs.find((x) => x.mapId === 11)!.nodes.find((n) => n.letter === "Start")!.node_type).toBe("start");
});
