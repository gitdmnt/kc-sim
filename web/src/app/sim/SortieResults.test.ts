import { expect, test } from "bun:test";
import type { NodeSummary } from "@sim-core";
import { orderNodeRows } from "./SortieResults";

const n = (reachRate: number): NodeSummary => ({
  reachRate, battleRate: reachRate, rankRates: { SS: 0, S: 0, A: 0, B: 0, C: 0, D: 0, E: 0 },
  retreatRate: 0, retreatHeavyRate: 0, retreatModerateRate: 0, nightRate: 0, fcfRate: 0,
});

test("Start first, then reach desc; zero-reach nodes dropped except bosses", () => {
  const rows = orderNodeRows({ A: n(1), Start: n(1), D: n(0.99), G: n(0), E: n(0.47) }, ["J"]);
  expect(rows.map(([l]) => l)).toEqual(["Start", "A", "D", "E", "J"]);
  expect(rows[4]![1].reachRate).toBe(0);
});

test("a boss present in the summary keeps its data; Start1/Start2 lead", () => {
  const rows = orderNodeRows({ B: n(0.3), Start1: n(0.5), Start2: n(0.5), J: n(0.2) }, ["J"]);
  expect(rows.map(([l]) => l)).toEqual(["Start1", "Start2", "B", "J"]);
});
