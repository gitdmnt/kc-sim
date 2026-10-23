import { describe, expect, test } from "bun:test";
import { inferRouting, los33, nextDistribution, observedSortie, observedSortieRow, type RouteShip, type SortieSample } from "../scripts/lib/routing-infer";
import type { Rule, RoutingDoc } from "../src/routing/schema";
import type { Edge } from "../src/routing/validate";

const E11: Edge[] = [{ from: "Start", to: "A" }, { from: "A", to: "B" }, { from: "A", to: "C" }];

/** Deterministic pseudo-random fleets: 1–6 ships of DD / CL / CA / BB with 0–2 recon seaplanes each. */
function fleets(n: number): RouteShip[][] {
  let seed = 12345;
  const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(r() * 6) }, () => ({
    stype: [2, 3, 5, 9][Math.floor(r() * 4)]!, id: 1, speed: r() < 0.5 ? 5 : 10, nakedLos: 40 + Math.floor(r() * 20),
    equips: Array.from({ length: Math.floor(r() * 3) }, () => ({ id: 25, cat: 10, los: 5, level: 0 })),
  })));
}

/** Sorties routed by `truth` (deterministic rules only). */
function sorties(truth: RoutingDoc, ships: RouteShip[][]): SortieSample[] {
  return ships.map((main) => {
    const s: SortieSample = { main, hq: 120, path: ["Start", "A"] };
    const d = nextDistribution(truth, "A", s, new Set(["Start", "A"]));
    s.path.push(Object.keys(d)[0]!);
    return s;
  });
}

const doc = (rules: Rule[]): RoutingDoc => ({
  map: "1-1", sources: [{ id: "t", note: "t" }], nodes: { Start: { rules: [{ to: "A" }] }, A: { rules }, B: { end: true }, C: { end: true } },
});

describe("inferRouting", () => {
  test("recovers a ship-count rule and emits a valid document", () => {
    const truth = doc([{ when: { m: "count", types: ["DD"], gte: 2 }, to: "B" }, { to: "C" }]);
    const res = inferRouting("1-1", E11, sorties(truth, fleets(600)));
    expect(res.errors).toEqual([]);
    expect(JSON.stringify(res.doc.nodes.A)).toContain('"types":["DD"]');
    for (const main of fleets(800).slice(600)) {
      const s = { main, hq: 120, path: [] };
      expect(nextDistribution(res.doc, "A", s, new Set())).toEqual(nextDistribution(truth, "A", s, new Set()));
    }
  });

  test("turns a pure LoS split into a los action with a threshold inside the observed gap", () => {
    const truth = doc([{ when: { m: "los", cn: 1, gte: 0 }, to: "B" }, { to: "C" }]);
    const res = inferRouting("1-1", E11, sorties(truth, fleets(600)));
    expect(res.errors).toEqual([]);
    const rule = res.doc.nodes.A && "rules" in res.doc.nodes.A ? res.doc.nodes.A.rules[0]! : null;
    expect(rule && "los" in rule ? rule.los.thresholds[0]!.to : null).toBe("B");
    const t = rule && "los" in rule ? rule.los.thresholds[0]!.min : NaN;
    const values = fleets(600).map((m) => los33(m, 1, 120));
    expect(Math.max(...values.filter((v) => v < 0))).toBeLessThan(t);
    expect(Math.min(...values.filter((v) => v >= 0))).toBeGreaterThanOrEqual(t);
  });

  test("a fleet-independent random branch becomes one uncertain random rule", () => {
    const ships = fleets(1000);
    const samples = ships.map((main, i) => ({ main, hq: 120, path: ["Start", "A", i % 2 ? "B" : "C"] }));
    const res = inferRouting("1-1", E11, samples);
    expect(res.errors).toEqual([]);
    const rules = res.doc.nodes.A && "rules" in res.doc.nodes.A ? res.doc.nodes.A.rules : [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ uncertain: true, random: [{ p: 0.5 }, { p: 0.5 }] });
  });

  test("unobserved branching nodes get an uncertain placeholder; sorties off the edge list are dropped", () => {
    const res = inferRouting("1-1", E11, [{ main: fleets(1)[0]!, hq: 120, path: ["Start", "B"] }]);
    expect(res.errors).toEqual([]);
    expect(res.dropped).toBe(1);
    expect(res.doc.nodes.A).toMatchObject({ rules: [{ uncertain: true, random: [{ to: "B", p: 0.5 }, { to: "C", p: 0.5 }] }] });
  });
});

test("observedSortie maps cells to letters and the fleet snapshot to routing ships", () => {
  const edges = new Map<number, Edge>([[1, { from: "Start", to: "A" }], [2, { from: "A", to: "B" }], [3, { from: "A", to: "C" }]]);
  const row = observedSortieRow.parse({
    difficulty: 0,
    fleet: { ships: [{ masterId: 10, equips: [{ masterId: 25, improvement: 4 }, null], exSlot: null, observed: { los: 50, speed: 10 } }] },
    sortie: { combined: 0, cells: [{ no: 1, selectCells: [2, 3] }, { no: 3 }], features: { hqLevel: 100 } },
  });
  const master = { ship: (id: number) => (id === 10 ? { stype: 2, speed: 10 } : undefined), equip: (id: number) => (id === 25 ? { cat: 10, los: 5 } : undefined) };
  expect(observedSortie(row, edges, master)).toEqual({
    main: [{ stype: 2, id: 10, speed: 10, nakedLos: 45, equips: [{ id: 25, cat: 10, los: 5, level: 4 }] }],
    hq: 100, difficulty: 0, path: ["Start", "A", "C"], selects: { A: ["B", "C"] },
  });
  expect(observedSortie({ ...row, sortie: { cells: [{ no: 9 }] } }, edges, master)).toEqual({ reason: "cell 9 is not an edge of the map" });
});

test("observedSortie: gauge number, stored fleet type (striking counts as single), path cut after an FCF retreat", () => {
  const edges = new Map<number, Edge>([[1, { from: "Start", to: "A" }], [2, { from: "A", to: "B" }], [4, { from: "B", to: "D" }]]);
  const ship = { masterId: 10, equips: [], observed: { los: 50, speed: 10 } };
  const master = { ship: () => ({ stype: 2, speed: 10 }), equip: () => undefined };
  const row = observedSortieRow.parse({
    difficulty: 4,
    fleet: { ships: [ship], escort: [ship] },
    sortie: { combined: 2, fleetType: "stf", gauge: { gaugeNum: 2 }, cells: [{ no: 1 }, { no: 2, result: { escape: { retreated: true } } }, { no: 4 }] },
  });
  expect(observedSortie(row, edges, master)).toMatchObject({ fleetType: "stf", gauge: 2, difficulty: 4, path: ["Start", "A", "B"] });
  const striking = observedSortieRow.parse({ ...row, fleet: { ships: Array.from({ length: 7 }, () => ship) }, sortie: { fleetType: "striking", cells: [{ no: 1 }] } });
  const s = observedSortie(striking, edges, master);
  expect("fleetType" in s ? s.fleetType : undefined).toBeUndefined();
});
