// Per-unit costs behind src/budget.ts COST, measured where the workers run (bench/worker.ts /micro) and in bun
// (bench/calibrate.ts). Each op runs one unit; callers time batches. No bun or Node APIs.
import { runBattle } from "../../sim-core/pkg/sim_core";
import type { BattleInput } from "../../sim-core/pkg/sim_core";
import { extractAttackEvents } from "../../shared/capture/parser";
import { gridFor, type GridFn } from "../../shared/estimate/forward";
import { groupObservations, newPosterior, shipPrior, summarizeShip } from "../../shared/estimate/infer";
import { buildObservations } from "../../shared/estimate/observe";
import { DEFAULT_GRID } from "../../shared/estimate/posterior";
import { captureFromRun, syntheticWorld } from "../../shared/estimate/synthetic";
import type { Observation } from "../../shared/estimate/types";
import { compactDensity, decodeGrid, encodeGrid } from "../src/estimator/job";
import { ENEMIES, FRIEND } from "./fixtures";

export type MicroOps = Record<string, () => unknown>;

/** One synthetic day + night battle as captured, and its observations as the server builds them (needs sim-core). */
export function sampleBattle() {
  const input: BattleInput = {
    friend: { ships: FRIEND, formation: "lineAhead" }, enemy: { ships: [...ENEMIES, ...ENEMIES.slice(0, 2)], formation: "lineAhead" },
    options: { kind: "dayNight", log: true },
  };
  const records = captureFromRun(input, runBattle(input, 7), { id: "m", capturedAt: Date.UTC(2026, 9, 1) });
  const reparsed = records.map((r) => ({ battle: r.battle, events: extractAttackEvents(r.battle.raw, r.battle.path) }));
  const world = syntheticWorld(FRIEND, ENEMIES);
  const observations = buildObservations(reparsed, world).observations;
  const pick = (role: Observation["role"]) => observations.find((o) => o.role === role)!.query;
  return { records, world, evasion: pick("evasion"), accuracy: pick("accuracy") };
}

/** Builds the ops; `gridFn` must be ready (sim-core instantiated), `wasm` is the compiled module. */
export function microOps(gridFn: GridFn, wasm: WebAssembly.Module): MicroOps {
  const { records, world, evasion: qe, accuracy: qa } = sampleBattle();
  const axes = shipPrior(undefined, DEFAULT_GRID).axes;
  const post = newPosterior(axes);
  const values = { ev: post.ev, acc: post.acc, luck: post.luck };
  const counts = { miss: 3, hit: 5, crit: 1 };
  for (const [q, role] of [[qe, "evasion"], [qa, "accuracy"]] as const) {
    const g = gridFor(gridFn, q, role, values);
    if (role === "evasion") post.addEvasion(g, counts);
    else post.addAccuracy(g, counts);
  }
  const encoded = encodeGrid(post.llEv);
  const sp = shipPrior(undefined, DEFAULT_GRID);
  const imports: WebAssembly.Imports = {};
  for (const i of WebAssembly.Module.imports(wasm)) {
    const ns = (imports[i.module] ??= {});
    if (i.kind === "function") ns[i.name] = () => undefined;
    else if (i.kind === "table") ns[i.name] = new WebAssembly.Table({ initial: 128, element: "anyfunc" });
    else if (i.kind === "memory") ns[i.name] = new WebAssembly.Memory({ initial: 17 });
  }
  // a 100 KB D1-style response: rows + columns, JSON strings inside
  const rows = { results: { columns: ["id", "raw"], rows: Array.from({ length: 10 }, (_, i) => [i, JSON.stringify(records[0]!.battle.raw).slice(0, 10_000)]) } };
  const wire = JSON.stringify(rows);
  return {
    "grid call (evasion, 201×101)": () => gridFor(gridFn, qe, "evasion", values),
    "grid call + fold (evasion)": () => post.addEvasion(gridFor(gridFn, qe, "evasion", values), counts),
    "grid call + fold (accuracy)": () => post.addAccuracy(gridFor(gridFn, qa, "accuracy", values), counts),
    "grid encode (base64 Float32)": () => encodeGrid(post.llEv),
    "grid decode": () => decodeGrid(encoded, post.llEv.length),
    "summarize ship (marginals + density)": () => summarizeShip(1, post, sp, { ev: 1, acc: 1, luck: 1 }).map((e) => compactDensity(e.density!)),
    "observe 1 day+night battle (re-parse + rolls + group)": () =>
      groupObservations(buildObservations(records.map((r) => ({ battle: r.battle, events: extractAttackEvents(r.battle.raw, r.battle.path) })), world).observations),
    [`JSON.parse ${Math.round(wire.length / 1024)} KB D1 response`]: () => JSON.parse(wire),
    [`JSON.stringify ${Math.round(wire.length / 1024)} KB`]: () => JSON.stringify(rows),
    "wasm instantiate (sim-core)": () => new WebAssembly.Instance(wasm, imports),
  };
}
