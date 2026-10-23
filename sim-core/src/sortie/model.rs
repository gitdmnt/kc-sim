//! Sortie JSON contract (serde, camelCase). Mirrors the "sortie" section of `sim_core_types.d.ts`.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{ArmorDebuff, BaseBonusSet, BattleKind, EquipmentInput, FleetInput, Formation, RankRates, ShipBonusSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Start,
    Battle,
    Boss,
    #[serde(alias = "night_battle")]
    NightBattle,
    #[serde(alias = "air_battle")]
    AirBattle,
    #[serde(alias = "air_raid")]
    AirRaid,
    Empty,
    Select,
    Resource,
    #[serde(alias = "whirlpool")]
    Maelstrom,
    Landing,
    #[serde(alias = "escort_success")]
    EscortSuccess,
    #[serde(alias = "air_recon")]
    AirRecon,
    #[serde(alias = "anchorage_repair")]
    AnchorageRepair,
    /// Any other string (treated as empty, reported in `warnings`).
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnemyComp {
    pub weight: f64,
    pub fleet: FleetInput,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SortieNode {
    pub kind: Option<NodeKind>,
    pub boss: Option<bool>,
    pub comps: Option<Vec<EnemyComp>>,
    /// Expected gain per visit (resource / landing nodes).
    pub resource: Option<ResourceAmounts>,
    pub maelstrom: Option<Maelstrom>,
    /// Fuel / ammo consumed by the node's battle as fractions of the ship's capacity, replacing
    /// the defaults derived from the node kind and the enemy (see SIM_INTERFACE "Supply").
    pub supply: Option<SupplyRates>,
    /// Battle kind of the node, replacing the one derived from `kind` and the night policy
    /// (e.g. a night-to-day node).
    pub battle_kind: Option<BattleKind>,
    /// Barrage-balloon node (阻塞気球): balloons equipped by either fleet take effect.
    pub balloons: Option<bool>,
    /// Event bonuses of the friend ships at this node, in `friend.ships` order (`null` = none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bonuses: Option<Vec<Option<ShipBonusSet>>>,
    /// Event bonuses of the friend escort ships at this node, in `friend.escort` order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escort_bonuses: Option<Vec<Option<ShipBonusSet>>>,
    /// Event bonuses of the land bases attacking this node, in `lbas` (base) order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lbas_bonuses: Option<Vec<Option<BaseBonusSet>>>,
    /// Armor debuffs of the enemy ships here (at the goal node also `gauge.finalComps`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debuffs: Option<Vec<ArmorDebuff>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SupplyRates {
    pub fuel: f64,
    pub ammo: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResourceAmounts {
    pub fuel: f64,
    pub ammo: f64,
    pub steel: f64,
    pub bauxite: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaelstromResource {
    Fuel,
    Ammo,
}

/// Maelstrom node: per-ship loss `min(max, floor(have × rate × (1 − radar reduction)))`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Maelstrom {
    pub resource: MaelstromResource,
    /// Loss rate. Without it the node causes no loss (warned).
    #[serde(default)]
    pub rate: Option<f64>,
    /// Per-ship cap.
    #[serde(default)]
    pub max: Option<i32>,
    /// Rate used with probability `highChance` (strong maelstrom).
    #[serde(default)]
    pub rate_high: Option<f64>,
    #[serde(default)]
    pub high_chance: Option<f64>,
    /// Radar ships reduce the loss. Default true.
    #[serde(default)]
    pub radar_reducible: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortieMap {
    pub routing: Value,
    #[serde(default)]
    pub nodes: HashMap<String, SortieNode>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SortieConfig {
    pub start: Option<String>,
    pub selects: HashMap<String, String>,
    pub flags: HashMap<String, bool>,
    pub difficulty: Option<f64>,
    pub phase: Option<f64>,
    pub gauge: Option<f64>,
    /// Node letter whose battle replaces the boss node in every boss output (and the gauge); the
    /// sortie ends right after it. Default: the map's boss node.
    pub target: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NightPolicy {
    Never,
    #[default]
    BossOnly,
    Always,
    IfNotSRank,
    IfNotARank,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RetreatPolicy {
    pub on_heavy: bool,
    pub allow_damecon: bool,
    pub on_moderate: bool,
    /// Evacuate a heavily damaged ship with the main flagship's command facility (艦隊司令部施設,
    /// 遊撃部隊 艦隊司令部施設, 精鋭水雷戦隊 司令部) instead of ending the sortie.
    pub use_fcf: bool,
}

impl Default for RetreatPolicy {
    fn default() -> Self {
        RetreatPolicy { on_heavy: true, allow_damecon: true, on_moderate: false, use_fcf: true }
    }
}

/// Per-node advance choice (進撃 / 撤退) after the node is resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Advance {
    /// Always return after this node.
    Retreat,
    /// Advance even with heavily / moderately damaged ships (a heavily damaged main flagship
    /// still ends the sortie).
    Push,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SortiePolicy {
    pub formations: HashMap<String, Formation>,
    pub night: NightPolicy,
    pub retreat: RetreatPolicy,
    /// Node letter → advance choice; absent nodes follow `retreat`.
    pub advance: HashMap<String, Advance>,
    /// Use underway replenishment (洋上補給) before the boss battle. Default true.
    pub underway: Option<bool>,
    /// Eat combat rations (戦闘糧食 / 秋刀魚の缶詰) before the boss battle. Default true.
    pub rations: Option<bool>,
    /// Node letters where the friend fleet tries a smoke screen (煙幕; once per sortie).
    pub smoke: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GaugeKind {
    Kill,
    Hp,
    /// Transport gauge: TP gained at the boss by rank (S full, A ×0.7 floored).
    Tp,
}

/// Tank-force TP table of a transport event (KC3Kai `fud_quarterly.json#tpMultipliers.tankforce`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TankType {
    Type1,
    Type2,
    TypeUnk,
}

/// One gauge of a multi-gauge map, run after the previous one is cleared.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GaugePhase {
    pub kind: GaugeKind,
    pub remaining: f64,
    /// Boss comps of this gauge (default: the boss node's comps).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comps: Option<Vec<EnemyComp>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_comps: Option<Vec<EnemyComp>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_threshold: Option<f64>,
    /// Routing `phase` during this gauge. Default: the map's starting phase + the gauge index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<f64>,
    /// Routing `gauge` number during this gauge. Default: the map's starting gauge + the gauge index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gauge: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank: Option<TankType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tp_per_sortie: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GaugeInput {
    pub kind: GaugeKind,
    pub remaining: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_comps: Option<Vec<EnemyComp>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runs: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_sorties: Option<u32>,
    /// Carry morale between the sorties of a run (absent: every sortie starts from the input morale).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub morale: Option<GaugeMorale>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tank: Option<TankType>,
    /// `tp`: TP of a full-rank sortie, replacing the table lookup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tp_per_sortie: Option<f64>,
    /// Gauges run one after another in each run (this input's own `kind`/`remaining` is gauge 0 when
    /// `phases` is absent). When present, `phases` replaces the fields above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phases: Option<Vec<GaugePhase>>,
}

/// Wait between sorties: at least `waitMinutes`, and until every ship reaches `untilMorale` (≤ 49).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GaugeMorale {
    pub wait_minutes: Option<f64>,
    pub until_morale: Option<i32>,
}

/// A sortie land base: squadrons and the node letters of its two waves (same letter twice = both
/// waves at that node; empty = not sortied). Plane counts reset every sortie; losses carry from
/// node to node.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LandBase {
    pub squadrons: Vec<EquipmentInput>,
    pub targets: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortieInput {
    /// Single or combined friend fleet.
    pub friend: FleetInput,
    pub hq_level: f64,
    pub map: SortieMap,
    #[serde(default)]
    pub config: SortieConfig,
    #[serde(default)]
    pub policy: SortiePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gauge: Option<GaugeInput>,
    /// Run the `count` sorties back to back: morale carries from one sortie to the next, with the
    /// given wait in between (absent: every sortie starts from the input morale).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consecutive: Option<GaugeMorale>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_paths: Option<u32>,
    /// Land bases (up to 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lbas: Option<Vec<LandBase>>,
    /// The single friend fleet is a striking force (遊撃部隊; routing fleet type `striking`).
    /// A 7-ship fleet is always one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub striking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repair: Option<RepairPolicy>,
    /// Costs the engine does not model (support expeditions, ...), added to every sortie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_per_sortie: Option<ResourceAmounts>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepairPolicy {
    /// Ships whose docking time exceeds this many seconds are repaired with a bucket instead
    /// (no docking cost or time). Default: never.
    pub bucket_above_sec: Option<f64>,
}

// ---------------------------------------------------------------- output ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PathRate {
    pub path: Vec<String>,
    pub rate: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummary {
    pub reach_rate: f64,
    pub battle_rate: f64,
    pub rank_rates: RankRates,
    pub retreat_rate: f64,
    pub retreat_heavy_rate: f64,
    pub retreat_moderate_rate: f64,
    pub night_rate: f64,
    /// Sorties in which a ship was evacuated (command facility) after this node.
    pub fcf_rate: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DameconSummary {
    pub used_rate: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortieShipSummary {
    pub sunk_rate: f64,
    pub heavy_rate: f64,
    pub moderate_rate: f64,
    pub damage_taken_mean: f64,
    pub hp_missing_mean: f64,
    pub fuel_used_mean: f64,
    pub ammo_used_mean: f64,
    pub bauxite_mean: f64,
    /// Aircraft slots that lost their proficiency (wiped to 0 planes), mean per sortie.
    pub proficiency_lost_mean: f64,
    pub repair: RepairSummary,
    pub damecon: DameconSummary,
    /// Sorties in which this ship was evacuated by the command facility (retreating or escorting).
    pub evacuated_rate: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Dist {
    pub mean: f64,
    pub p50: f64,
    pub p90: f64,
}

/// Net resources of a sortie or a gauge clear (costs minus gains from resource nodes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesSummary {
    pub fuel: Dist,
    pub ammo: Dist,
    pub steel: Dist,
    pub bauxite: Dist,
    /// Instant repair items (`repair.bucketAboveSec`).
    pub buckets: Dist,
    /// Docking time: per sortie the slowest ship, per gauge clear the sum over sorties.
    pub time_sec: Dist,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairSummary {
    pub fuel: Dist,
    pub steel: Dist,
    pub time_sec: Dist,
}

/// Fleet docking need: costs summed over ships, `timeSec` = slowest ship (parallel docks),
/// `timeSecTotal` = sum (one dock).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetRepairSummary {
    pub fuel: Dist,
    pub steel: Dist,
    pub time_sec: Dist,
    pub time_sec_total: Dist,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeEffectsSummary {
    /// Mean gain per sortie from resource / landing nodes.
    pub gained_mean: ResourceAmounts,
    /// Mean total maelstrom loss per sortie (already inside `fuelUsedMean` / `ammoUsedMean`).
    pub maelstrom_fuel_mean: f64,
    pub maelstrom_ammo_mean: f64,
    /// Mean HP restored per sortie by anchorage repair, and mean repair materials used.
    pub anchorage_hp_mean: f64,
    pub anchorage_materials_mean: f64,
    /// Steel of the anchorage repairs (3 per HP restored).
    pub anchorage_steel_mean: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BossSummary {
    pub reach_rate: f64,
    pub rank_rates: RankRates,
    pub kill_rate: f64,
    pub flagship_sunk_rate: f64,
    pub flagship_damage_mean: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseSummary {
    pub kind: GaugeKind,
    pub expected_sorties: Option<f64>,
    pub p90_sorties: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GaugeSummary {
    pub kind: GaugeKind,
    pub remaining: f64,
    pub expected_sorties: Option<f64>,
    pub p50_sorties: Option<f64>,
    pub p90_sorties: Option<f64>,
    /// Waiting between sorties per cleared run (only with `GaugeInput.morale`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_wait_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p50_wait_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p90_wait_minutes: Option<f64>,
    /// With `phases`: sorties spent in each gauge over the cleared runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phases: Option<Vec<PhaseSummary>>,
    /// Resources spent per cleared run (sum over its sorties); absent when no run cleared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<ResourcesSummary>,
    pub capped_rate: f64,
    pub runs: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortieSummary {
    pub count: u32,
    pub paths: Vec<PathRate>,
    pub other_paths_rate: f64,
    pub nodes: BTreeMap<String, NodeSummary>,
    pub boss: BossSummary,
    pub retreat_rate: f64,
    pub sunk_rate: f64,
    pub battles_mean: f64,
    pub nodes_mean: f64,
    pub fuel_used_mean: f64,
    pub ammo_used_mean: f64,
    pub bauxite_mean: f64,
    pub repair: FleetRepairSummary,
    pub resources_per_sortie: ResourcesSummary,
    /// Sorties with at least one command-facility evacuation.
    pub fcf_rate: f64,
    /// Underway replenishment items (洋上補給) used per sortie.
    pub underway_used_mean: f64,
    /// Combat rations (戦闘糧食 / 秋刀魚の缶詰) eaten per sortie.
    pub rations_used_mean: f64,
    /// Land-base sortie and resupply cost per sortie (fuel, ammo, bauxite; inside `resourcesPerSortie`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lbas_cost_mean: Option<ResourceAmounts>,
    /// With `consecutive`: mean wait between sorties (minutes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_minutes_mean: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects: Option<NodeEffectsSummary>,
    pub friend: Vec<SortieShipSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gauge: Option<GaugeSummary>,
    pub warnings: Vec<String>,
}
