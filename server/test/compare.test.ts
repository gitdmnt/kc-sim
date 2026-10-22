import { expect, test } from "bun:test";
import { compareRouting } from "../src/routing/compare";
import { parseNodeSummary } from "../src/kcnav/parse";
import { jobPath } from "../src/kcnav/enqueue";
import type { RoutingDoc } from "../src/routing/schema";

const doc: RoutingDoc = {
  map: "1-1",
  sources: [{ id: "t", note: "t" }],
  nodes: {
    Start: { rules: [{ to: "A" }] },
    A: { rules: [{ when: { m: "ships", gte: 6 }, random: [{ to: "B", p: 0.45 }, { to: "C", p: 0.55 }] }, { random: [{ to: "B", p: 0.2 }, { to: "C", p: 0.8 }] }] },
    B: { end: true },
    C: { end: true },
  },
};

test("verified 1-1 nodesummary shape parses", () => {
  // Response observed 2026-10-22 (docs/DATA_SOURCES.md §1).
  const runs = parseNodeSummary({ result: { "0": { runs: 125494 }, "1": { runs: 125494, lockTags: [0] }, "2": { runs: 31269, lockTags: [0] }, "3": { runs: 90130, lockTags: [0] } }, retrieved: "x" });
  expect(runs).toEqual([{ edgeId: 0, runs: 125494 }, { edgeId: 1, runs: 125494 }, { edgeId: 2, runs: 31269 }, { edgeId: 3, runs: 90130 }]);
});

test("conditional node: coverage only; fixed node: distribution compared", () => {
  const r = compareRouting(doc, [
    { from: "Start", to: "A", runs: 1000 },
    { from: "A", to: "B", runs: 300 },
    { from: "A", to: "C", runs: 700 },
  ]);
  const a = r.find((n) => n.node === "A")!;
  expect(a.uncovered).toEqual([]);
  expect(a.distribution).toBeUndefined();
  expect(r.find((n) => n.node === "Start")!.distribution).toMatchObject({ ok: true, maxAbsDiff: 0 });
});

test("observed branch the rules cannot produce is reported; small samples skip unobserved", () => {
  const r = compareRouting({ ...doc, nodes: { ...doc.nodes, A: { rules: [{ to: "C" }] } } }, [
    { from: "A", to: "B", runs: 120 },
    { from: "A", to: "C", runs: 880 },
  ], { tolerance: 0.05 });
  const a = r.find((n) => n.node === "A")!;
  expect(a.uncovered).toEqual(["B"]);
  expect(a.distribution).toMatchObject({ ok: false });
  expect(compareRouting(doc, [{ from: "A", to: "C", runs: 50 }])[0]!.unobserved).toEqual([]);
});

test("nodesummary and batched enemycomps job paths", () => {
  expect(jobPath("nodesummary", 15, { start: "2026-08-23", filters: { minSpeed: "10", include: "DD" } }))
    .toBe("/api/routing/maps/1-5/nodesummary?start=2026-08-23&include=DD&minSpeed=10");
  expect(jobPath("enemycomps", 15, { start: "2026-08-22", edges: [12, 6, 10, 11] }))
    .toBe("/api/routing/maps/1-5/edges/6,10,11,12/enemycomps?start=2026-08-22");
});

test("nodesummary edges without runs (KCNav omits zeros) parse as 0", () => {
  expect(parseNodeSummary({ result: { "0": {}, "4": { runs: 3 } } })).toEqual([{ edgeId: 0, runs: 0 }, { edgeId: 4, runs: 3 }]);
});
