import { describe, expect, test } from "bun:test";
import type { BattleInput, ShipSummary, SimulationSummary } from "@sim-core";
import { allocateCounts, mergeSummaries, runJobs } from "./runner";

const ship = (maxHp: number, o: Partial<ShipSummary> = {}): ShipSummary => ({
  maxHp, hpMean: maxHp, hpHistogram: new Array(maxHp + 1).fill(0), sunkRate: 0, heavyRate: 0,
  moderateRate: 0, lightRate: 0, healthyRate: 1, damageDealtMean: 0, mvpRate: 0, ...o,
});
const summary = (count: number, o: Partial<SimulationSummary> = {}): SimulationSummary => ({
  count,
  rankRates: { SS: 0, S: 1, A: 0, B: 0, C: 0, D: 0, E: 0 },
  airStateRates: { none: 1, supremacy: 0, superiority: 0, parity: 0, denial: 0, incapability: 0 },
  nightBattleRate: 0, enemyFlagshipSunkRate: 1, friendHeavyAnyRate: 0, friendSunkAnyRate: 0,
  friend: [ship(3)], enemy: [ship(2)], ...o,
});
const input = {} as BattleInput;

describe("mergeSummaries", () => {
  test("weights rates by count and sums histograms", () => {
    const a = summary(100, {
      rankRates: { SS: 0, S: 1, A: 0, B: 0, C: 0, D: 0, E: 0 },
      friend: [ship(3, { hpMean: 3, hpHistogram: [0, 0, 0, 100], mvpRate: 1 })],
    });
    const b = summary(300, {
      rankRates: { SS: 0, S: 0, A: 1, B: 0, C: 0, D: 0, E: 0 },
      friend: [ship(3, { hpMean: 1, hpHistogram: [0, 300, 0, 0], mvpRate: 0, sunkRate: 0.5, healthyRate: 0.5 })],
    });
    const m = mergeSummaries([a, b]);
    expect(m.count).toBe(400);
    expect(m.rankRates.S).toBeCloseTo(0.25);
    expect(m.rankRates.A).toBeCloseTo(0.75);
    expect(m.friend[0].hpMean).toBeCloseTo(1.5);
    expect(m.friend[0].hpHistogram).toEqual([0, 300, 0, 100]);
    expect(m.friend[0].sunkRate).toBeCloseTo(0.375);
    expect(m.friend[0].mvpRate).toBeCloseTo(0.25);
  });
  test("skipEnemy, single part, mismatch", () => {
    expect(mergeSummaries([summary(10), summary(10)], { skipEnemy: true }).enemy).toEqual([]);
    expect(mergeSummaries([summary(10)]).count).toBe(10);
    expect(() => mergeSummaries([summary(10), summary(10, { enemy: [ship(2), ship(2)] })])).toThrow("mismatch");
    expect(mergeSummaries([summary(0)]).count).toBe(0);
  });
});

describe("runJobs", () => {
  test("chunks, seeds, progress and totals", () => {
    const calls: [number, number][] = [];
    const out = runJobs(
      (_i, n, seed) => (calls.push([n, seed]), summary(n)),
      [{ key: "a", input, count: 25, seed: 100 }, { key: "b", input, count: 10, seed: 7 }],
      { chunk: 10, onProgress: (d, t) => progress.push([d, t]) }
    );
    expect(calls).toEqual([[10, 100], [10, 101], [5, 102], [10, 7]]);
    expect(out.map((r) => [r.key, r.summary.count])).toEqual([["a", 25], ["b", 10]]);
    expect(progress.at(-1)).toEqual([35, 35]);
  });
  const progress: [number, number][] = [];

  test("seed wraps below 2^53; zero count still returns a summary", () => {
    const seeds: number[] = [];
    runJobs((_i, n, s) => (seeds.push(s), summary(n)), [{ key: "a", input, count: 20, seed: 2 ** 53 - 1 }], { chunk: 10 });
    expect(seeds).toEqual([2 ** 53 - 1, 0]);
    expect(runJobs(() => summary(0), [{ key: "z", input, count: 0, seed: 1 }])[0].summary.count).toBe(0);
  });
});

describe("allocateCounts", () => {
  test("largest remainder keeps the total", () => {
    expect(allocateCounts(1000, [0.5, 0.3, 0.2])).toEqual([500, 300, 200]);
    const r = allocateCounts(10, [1, 1, 1]);
    expect(r.reduce((a, b) => a + b, 0)).toBe(10);
    expect(allocateCounts(5, [0, 0])).toEqual([5, 0]);
    expect(allocateCounts(7, [])).toEqual([]);
  });
});
