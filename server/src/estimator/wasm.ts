// sim-core (wasm-pack --target web) inside workerd: wrangler imports `.wasm` as a compiled
// WebAssembly.Module (CompiledWasm rule), which initSync instantiates without fetch or eval.
//
// V8 compiles wasm functions lazily, on their first call. The first grid call in a fresh isolate therefore
// compiles the whole query path (serde deserialization, ship building, accuracy formulas): ~3–5 ms of CPU in
// local workerd (bench/calibrate.ts), most of a Workers Free invocation. So the module is instantiated and every
// query kind is run once here, in the global scope, which has its own startup limit (1 s), instead of inside
// the first estimator run of the isolate.
import simCoreModule from "../../../sim-core/pkg/sim_core_bg.wasm?module";
import { hitProbabilityGrid, initSync } from "../../../sim-core/pkg/sim_core";
import type { AttackQuery, EquipmentInput, QueryKind, ShipInput } from "../../../sim-core/pkg/sim_core";
import type { GridFn } from "../../../shared/estimate/forward";

initSync({ module: simCoreModule });

// Every field the estimator's canonical queries can carry: each one has its own deserialization code.
const stats = { firepower: 3, torpedo: 5, antiAir: 1, armor: 1, evasion: 2, asw: 4, los: 1, accuracy: 1, bombing: 5, luck: 1, range: 1 };
const equip = (id: number, cat: number, planes = 0): EquipmentInput => ({ id, types: [1, 2, cat, cat, 0], stats, improvement: 4, proficiency: 7, planes });
const ship = (id: number, shipType: number, slots: EquipmentInput[]): ShipInput => ({
  id, name: "warm-up", shipType, shipClass: 1, level: 50, maxHp: 40, hp: 30, morale: 25, fuel: 10, fuelMax: 20, ammo: 15, ammoMax: 20, range: 2, speed: 10,
  stats: { firepower: 30, torpedo: 30, antiAir: 10, armor: 30, evasion: 30, asw: 30, los: 10, luck: 10 }, equipBonus: stats,
  hiddenAccuracy: 3, torpedoAccuracy: 2, slots: [...slots, null], exSlot: equip(9, 42),
});
const attacker = ship(1, 11, [equip(1, 2), equip(2, 5), equip(4, 8, 10), equip(5, 7, 10)]);
const defender = ship(1501, 2, [equip(6, 1), equip(7, 12), equip(8, 29)]);
const kinds: QueryKind[] = ["shelling", "torpedo", "night", "asw", "openingAsw", "air"];
for (const kind of kinds) {
  const query: AttackQuery = {
    kind, attacker, defender, attackerSide: "enemy", attackerFormation: "vanguard", defenderFormation: "diamond", attackerIndex: 1,
    attackerFleetSize: 6, defenderIndex: 2, defenderFleetSize: 6, engagement: "headOn", special: kind === "night" ? "nightCutinTorpedo" : "cutinMainSecondary",
    night: { ownStarshell: true, enemyStarshell: false, ownSearchlight: true, enemySearchlight: false, nightContactAccuracy: 2 }, slot: 3, contactModifier: 1.2,
  };
  for (const target of ["attacker", "defender"] as const) {
    try {
      hitProbabilityGrid({ query, target, evasion: [0, 1], luck: [0, 1], hiddenAccuracy: [0, 1] });
    } catch {
      // a kind this ship cannot do still compiled the deserialization
    }
  }
}
// Full-size grids make the per-point loops hot, so V8 tiers them up from its baseline compiler now.
const axis = (n: number) => Array.from({ length: n }, (_, i) => i);
const shelling: AttackQuery = { kind: "shelling", attacker, defender };
for (let i = 0; i < 20; i++) {
  hitProbabilityGrid({ query: shelling, target: "defender", evasion: axis(201), luck: axis(101) });
  hitProbabilityGrid({ query: shelling, target: "attacker", luck: axis(101), hiddenAccuracy: axis(201) });
}

export const simCoreGrid = (): GridFn => hitProbabilityGrid;
