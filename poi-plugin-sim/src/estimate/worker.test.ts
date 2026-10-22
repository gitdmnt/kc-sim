/** sim.worker の推定リクエスト (poi では wasm を Worker の中でしか動かせない) の往復。 */
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import type { AttackQuery } from "@sim-core";
import type { WorkerRequest, WorkerResponse } from "../sim/sim.worker";
import type { Observation } from "./types";

test("worker answers an estimate request with progress and estimateDone", async () => {
  const wasm = new Uint8Array(readFileSync(new URL("../../../sim-core/pkg/sim_core_bg.wasm", import.meta.url)));
  const query: AttackQuery = {
    kind: "shelling",
    attackerSide: "friend",
    attacker: { shipType: 2, level: 50, maxHp: 30, stats: { firepower: 10, torpedo: 10, antiAir: 1, armor: 10, luck: 10 }, slots: [] },
    defender: { shipType: 2, maxHp: 30, stats: { firepower: 1, torpedo: 1, antiAir: 1, armor: 1, evasion: 0, luck: 0 }, slots: [] },
  };
  const observations: Observation[] = Array.from({ length: 30 }, (_, i) => ({
    shipId: 1700, role: "evasion", query, outcome: i % 3 ? "hit" : "miss", battleId: "b", seq: i,
  }));
  const worker = new Worker(new URL("../sim/sim.worker.ts", import.meta.url).href);
  const messages: WorkerResponse[] = [];
  const done = Promise.withResolvers<void>();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    messages.push(e.data);
    if (e.data.type !== "progress") done.resolve();
  };
  const request: WorkerRequest = { type: "estimate", wasm, observations, priors: { 1700: { luck: { value: 10, confidence: "datamined", source: "t" } } }, options: {} };
  worker.postMessage(request);
  await done.promise;
  worker.terminate();

  expect(messages.map((m) => m.type)).toEqual(["progress", "estimateDone"]);
  const last = messages[1];
  if (last.type !== "estimateDone") throw new Error(last.type);
  expect(last.results.map((r) => [r.shipId, r.stat, r.n])).toEqual([[1700, "ev", 30], [1700, "acc", 0], [1700, "luck", 30]]);
  expect(last.results[2].prior).toMatchObject({ confidence: "datamined", value: 10 });
});
