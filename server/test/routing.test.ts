import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { countRules, validateRoutingDoc, type Edge } from "../src/routing/validate";
import { normalizeLetter } from "../src/maps";

type EdgeFixture = Record<string, Record<string, [string, string]>>;
const kc3 = (await Bun.file(new URL("./fixtures/kc3-edges.json", import.meta.url)).json()) as EdgeFixture;
// Live game edges of the 37 normal maps (KCNav map routes, exported from D1 on 2026-10-22). KC3's
// edges.json is wrong for 5-6 / 6-4 / 6-5 / 7-4, so seeds are validated against this snapshot.
const kcnav = (await Bun.file(new URL("./fixtures/edges-normal-kcnav.json", import.meta.url)).json()) as EdgeFixture;
const edgesOf = (map: string, fixture: EdgeFixture = kc3): Edge[] => {
  const raw = Object.values(fixture[`World ${map}`] ?? {});
  const multi = raw.flat().some((l) => /^Start ?\d+$/.test(l));
  return raw.map(([a, b]) => ({ from: normalizeLetter(a, multi), to: normalizeLetter(b, multi) }));
};

const SEED_DIR = new URL("../seed/routing/", import.meta.url).pathname;
const seeds = [...new Glob("*.json").scanSync(SEED_DIR)].filter((f) => f !== "routing.schema.json").sort();

describe("seed routing documents", () => {
  test("every current normal map has a seed", () => {
    const normal = Object.keys(kcnav).map((k) => /^World ([1-7]-\d)$/.exec(k)?.[1]).filter((m): m is string => !!m);
    expect(normal).toHaveLength(37);
    expect(seeds).toEqual(normal.map((m) => `${m}.json`).sort());
  });
  for (const f of seeds) {
    test(`${f} validates against KCNav (live game) edges`, async () => {
      const doc = await Bun.file(SEED_DIR + f).json();
      expect(`${doc.map}.json`).toBe(f);
      const { errors } = validateRoutingDoc(doc, edgesOf(doc.map, kcnav));
      expect(errors).toEqual([]);
    });
  }
});

test("maps with several start points require a start rule list", () => {
  const edges = edgesOf("6-5", kcnav);
  const doc = { map: "6-5", sources: [{ id: "t", note: "t" }], nodes: { Start1: { rules: [{ to: "A" }] }, Start2: { rules: [{ to: "B" }] } } };
  expect(validateRoutingDoc(doc, edges).errors.join()).toContain('a "start" rule list is required');
  const bad = { ...doc, start: { rules: [{ to: "A" }] } };
  expect(validateRoutingDoc(bad, edges).errors.join()).toContain("@start->A is not an edge");
});

const base = (nodes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  map: "1-1", sources: [{ id: "t", note: "test" }], nodes, ...extra,
});
const E11 = edgesOf("1-1"); // Start->A, A->{B,C}

describe("validator rejects", () => {
  test("weights not summing to 1", () => {
    const r = validateRoutingDoc(base({ Start: { rules: [{ to: "A" }] }, A: { rules: [{ random: [{ to: "B", p: 0.5 }, { to: "C", p: 0.4 }] }] }, B: { end: true }, C: { end: true } }), E11);
    expect(r.errors.join()).toContain("sum to 0.9");
  });
  test("destination that is not an edge", () => {
    const r = validateRoutingDoc(base({ Start: { rules: [{ to: "B" }] }, A: { rules: [{ to: "B" }] }, B: { end: true }, C: { end: true } }), E11);
    expect(r.errors.join()).toContain("Start->B is not an edge");
  });
  test("conditional last rule (non-total)", () => {
    const r = validateRoutingDoc(base({ Start: { rules: [{ to: "A" }] }, A: { rules: [{ when: { m: "ships", gte: 6 }, to: "B" }] }, B: { end: true }, C: { end: true } }), E11);
    expect(r.errors.join()).toContain("last rule must be unconditional");
  });
  test("missing node with outgoing edges", () => {
    const r = validateRoutingDoc(base({ Start: { rules: [{ to: "A" }] }, B: { end: true }, C: { end: true } }), E11);
    expect(r.errors.join()).toContain("nodes.A: has outgoing edges but no rules");
  });
  test("non-descending los thresholds and bad select default", () => {
    const r = validateRoutingDoc(base({
      Start: { rules: [{ to: "A" }] },
      A: { rules: [{ when: { m: "ships", eq: 1 }, select: ["B", "C"] }, { los: { cn: 1, thresholds: [{ min: 5, to: "B" }, { min: 6, to: "C" }], below: "C" } }] },
      B: { end: true }, C: { end: true },
    }, { defaults: { select: { A: "Z" } } }), E11);
    expect(r.errors.join()).toContain("strictly descending");
    expect(r.errors.join()).toContain("defaults.select.A=Z");
  });
  test("unknown metric / extra keys (closed schema)", () => {
    expect(validateRoutingDoc(base({ Start: { rules: [{ when: { m: "luck", gte: 1 }, to: "A" }, { to: "A" }] } })).errors.length).toBeGreaterThan(0);
    expect(validateRoutingDoc(base({ Start: { rules: [{ to: "A", weight: 1 }] } })).errors.length).toBeGreaterThan(0);
  });
});

test("countRules counts nested rules and uncertain flags", () => {
  const doc = validateRoutingDoc(base({
    Start: { rules: [{ to: "A" }] },
    A: { rules: [{ when: { m: "ships", gte: 5 }, rules: [{ to: "B", uncertain: true }] }, { to: "C" }] },
    B: { end: true }, C: { end: true },
  }), E11).doc!;
  expect(countRules(doc)).toEqual({ total: 4, uncertain: 1 });
});
