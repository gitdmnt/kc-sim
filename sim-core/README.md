# sim-core

KanColle battle and sortie engine (Rust → wasm) for Monte-Carlo win/rank rates, routing and gauges:
single or combined (機動 / 水上 / 輸送護衛) friend fleets vs a single enemy fleet, with land-based air
squadron waves.
The JSON/TypeScript contract is `../docs/SIM_INTERFACE.md` (machine-readable copy:
`sim_core_types.d.ts`, embedded into `pkg/sim_core.d.ts`).

```ts
simulateBattle(input: BattleInput, count: number, seed: number): SimulationSummary
runBattle(input: BattleInput, seed: number): RunBattleOutput        // result + post-battle state
hitProbability(query: AttackQuery): HitProbability                   // forward model
damageDistribution(query: AttackQuery): DamageDistribution           // forward model
simulateSortie(input: SortieInput, count: number, seed: number): SortieSummary  // routing + chained battles
```

## Build & test

```sh
wasm-pack build --target web            # -> pkg/
cargo test                              # unit + integration tests (routing tests read ../server/seed/routing)
cargo test --release --test bench -- --nocapture --test-threads=1   # throughput (battles/s, sorties/s, µs per 201×101 hitProbabilityGrid; asserts >= 50k battles/s); one at a time, or the benches share cores
bun validation/routing-vs-kcnav.ts [--offline]  # routing vs KCNav edge counts -> ../docs/VALIDATION.md (needs pkg/)
KCR_DIR=<kancolle-replay checkout> bun validation/battle-vs-kcsim.ts  # realistic sorties + per-node battles vs kcsim -> ../docs/VALIDATION.md §3
```

## Layout

| file | content |
|---|---|
| `src/model.rs` | serde types of the contract |
| `src/equipment.rs` | equipment classification by `api_type`, improvement / proficiency effects |
| `src/ship.rs` | derived per-ship data (totals, cut-in kinds, ASW power, AA), mutable battle state |
| `src/formation.rs` | formation / vanguard / engagement tables |
| `src/formulas.rs` | accuracy, critical, soft cap, armor, scratch, protection |
| `src/fit.rs` | main-gun fit (accuracy / CL firepower) by equipment id and ship class |
| `src/battle/` | phases (`air`, `day` = OASW + shelling, `torpedo`, `night`, `lbas` = land-base waves), combined-fleet phase order, `calc` (per-attack modifiers shared with the forward model), rank, supply, morale |
| `src/sim.rs` | `run_battle`, Monte-Carlo aggregation |
| `src/query.rs` | `hit_probability`, `damage_distribution` |
| `src/routing.rs` | ROUTING_DSL parser / validator / evaluator, LoS formula 33 |
| `src/sortie/` | sortie loop (node handling, retreat, state carry-over), aggregation, gauge estimates; `model.rs` = sortie JSON types |
| `src/lib.rs` | wasm-bindgen exports |
| `tests/` | engine behaviour, rank rules, JSON contract, published-number realism checks, combined fleets + LBAS (`combined.rs`), routing (all seed docs, start rules, golden routes, combined-fleet metrics), sortie (1-5 end-to-end from `fixtures/1-5.api.json`, a one-time capture of the local server API), bench |
| `validation/` | KCNav routing comparison harness + its data snapshot (`docs/VALIDATION.md`) |

Mechanics and the list of known simplifications are documented in `../docs/SIM_INTERFACE.md`.

## Attribution

Combat formulas, constants and phase logic are ported from
[KC3Kai/kancolle-replay](https://github.com/KC3Kai/kancolle-replay) (`js/kcsim.js`, `js/kcsimcombined.js`,
`js/kcships.js`, `js/kcEQDATA.js`) and cross-checked with [en.kancollewiki.net](https://en.kancollewiki.net/).
Battle-rank rules follow KC3Kai's `BattlePrediction` / ElectronicObserver `kcmemo.md`.

kancolle-replay is distributed under the MIT License:

```
The MIT License (MIT)
Copyright (c) 2016 fourinone41

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
