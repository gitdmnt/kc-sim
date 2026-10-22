//! KanColle single-node battle engine for Monte-Carlo simulation, compiled to wasm.
//!
//! Contract: `docs/SIM_INTERFACE.md` / `sim_core_types.d.ts`. Combat formulas are ported from
//! KC3Kai/kancolle-replay (MIT, © 2016 fourinone41) and cross-checked with en.kancollewiki.net.

pub mod battle;
pub mod equipment;
pub mod formation;
pub mod fit;
pub mod formulas;
pub mod model;
pub mod query;
pub mod rng;
pub mod routing;
pub mod ship;
pub mod sim;
pub mod sortie;

use serde::de::DeserializeOwned;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &'static str = include_str!("../sim_core_types.d.ts");

fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(console_error_panic_hook::set_once);
    }
}

fn from_js<T: DeserializeOwned>(v: JsValue, what: &str) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&format!("invalid {what}: {e}")))
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| JsError::new(&e.to_string()))
}

fn seed_of(seed: f64) -> Result<u64, JsError> {
    if !seed.is_finite() || seed < 0.0 || seed >= 9_007_199_254_740_992.0 || seed.fract() != 0.0 {
        return Err(JsError::new("seed must be an integer in [0, 2^53)"));
    }
    Ok(seed as u64)
}

/// Monte-Carlo: `count` battles from the same start state; aggregate statistics only.
#[wasm_bindgen(js_name = simulateBattle, unchecked_return_type = "SimulationSummary")]
pub fn simulate_battle(
    #[wasm_bindgen(unchecked_param_type = "BattleInput")] input: JsValue,
    count: u32,
    seed: f64,
) -> Result<JsValue, JsError> {
    init();
    let input: model::BattleInput = from_js(input, "BattleInput")?;
    let out = sim::simulate(&input, count, seed_of(seed)?).map_err(|e| JsError::new(&e))?;
    to_js(&out)
}

/// One battle: result plus the post-battle state for chaining sortie nodes.
#[wasm_bindgen(js_name = runBattle, unchecked_return_type = "RunBattleOutput")]
pub fn run_battle(#[wasm_bindgen(unchecked_param_type = "BattleInput")] input: JsValue, seed: f64) -> Result<JsValue, JsError> {
    init();
    let input: model::BattleInput = from_js(input, "BattleInput")?;
    let out = sim::run_battle(&input, seed_of(seed)?).map_err(|e| JsError::new(&e))?;
    to_js(&out)
}

/// Hit / critical probability of one attack roll (forward model).
#[wasm_bindgen(js_name = hitProbability, unchecked_return_type = "HitProbability")]
pub fn hit_probability(#[wasm_bindgen(unchecked_param_type = "AttackQuery")] query: JsValue) -> Result<JsValue, JsError> {
    init();
    let q: model::AttackQuery = from_js(query, "AttackQuery")?;
    to_js(&query::hit_probability(&q).map_err(|e| JsError::new(&e))?)
}

/// `hitProbability` over a grid of one ship's evasion × luck × hidden accuracy (estimator helper):
/// `[pHit, pCrit]` pairs, evasion outermost, hidden accuracy innermost.
#[wasm_bindgen(js_name = hitProbabilityGrid)]
pub fn hit_probability_grid(#[wasm_bindgen(unchecked_param_type = "HitGridQuery")] grid: JsValue) -> Result<Vec<f64>, JsError> {
    init();
    let g: model::HitGridQuery = from_js(grid, "HitGridQuery")?;
    query::hit_probability_grid(&g).map_err(|e| JsError::new(&e))
}

/// Damage distribution of one normal / critical hit (forward model).
#[wasm_bindgen(js_name = damageDistribution, unchecked_return_type = "DamageDistribution")]
pub fn damage_distribution(#[wasm_bindgen(unchecked_param_type = "AttackQuery")] query: JsValue) -> Result<JsValue, JsError> {
    init();
    let q: model::AttackQuery = from_js(query, "AttackQuery")?;
    to_js(&query::damage_distribution(&q).map_err(|e| JsError::new(&e))?)
}

/// Monte-Carlo sortie simulation (routing + chained battles); aggregate statistics only.
#[wasm_bindgen(js_name = simulateSortie, unchecked_return_type = "SortieSummary")]
pub fn simulate_sortie(
    #[wasm_bindgen(unchecked_param_type = "SortieInput")] input: JsValue,
    count: u32,
    seed: f64,
) -> Result<JsValue, JsError> {
    init();
    let input: sortie::model::SortieInput = from_js(input, "SortieInput")?;
    let out = sortie::simulate_sortie(&input, count, seed_of(seed)?).map_err(|e| JsError::new(&e))?;
    to_js(&out)
}
