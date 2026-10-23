//! Sortie JSON contract (serde, camelCase). Mirrors the "sortie" section of `sim_core_types.d.ts`.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{ArmorDebuff, BaseBonusSet, BaseRaidSummary, EquipmentInput, FleetInput, Formation, FriendFleetInput, RankRates, ShipBonusSet, SupportInput};

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
    /// 夜昼戦: night battle first, then (optionally) the day battle (`BattleKind::NightToDay`).
    #[serde(alias = "night_to_day")]
    NightToDay,
    /// Any other string (treated as empty, reported in `warnings`).
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnemyComp {
    pub weight: f64,
    /// A single fleet, or an enemy combined fleet (`escort`, default formation `combinedBattle`).
    pub fleet: FleetInput,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SortieNode {
    pub kind: Option<NodeKind>,
    pub boss: Option<bool>,
    pub comps: Option<Vec<EnemyComp>>,
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
    /// Land-base distance of the node (api_distance). Waves to a node beyond a base's radius are
    /// dropped (warning).
    pub lbas_distance: Option<u32>,
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
}

impl Default for RetreatPolicy {
    fn default() -> Self {
        RetreatPolicy { on_heavy: true, allow_damecon: true, on_moderate: false }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SortiePolicy {
    pub formations: HashMap<String, Formation>,
    pub night: NightPolicy,
    pub retreat: RetreatPolicy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GaugeKind {
    Kill,
    Hp,
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
}

/// A sortie land base: squadrons and the node letters of its two waves (same letter twice = both
/// waves at that node; empty = not sortied). Plane counts reset every sortie; losses carry from
/// node to node.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LandBase {
    pub squadrons: Vec<EquipmentInput>,
    pub targets: Vec<String>,
    /// 防空: the base never sorties (its `targets` are ignored) and defends against `baseRaids`.
    pub defense: bool,
}

/// Enemy air raid on the land bases on arrival at `node`, before its battle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortieBaseRaid {
    pub node: String,
    /// Default 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chance: Option<f64>,
    pub comps: Vec<EnemyComp>,
    /// High-altitude raid even without heavy bombers in the comps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high_altitude: Option<bool>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_paths: Option<u32>,
    /// Land bases (up to 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lbas: Option<Vec<LandBase>>,
    /// Support expeditions: `node` at every non-goal battle node, `boss` at the goal node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support: Option<SortieSupport>,
    /// Friend fleet (友軍艦隊) at the night battles of `friendFleet.nodes` (default: goal node).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_fleet: Option<FriendFleetInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_raids: Option<Vec<SortieBaseRaid>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SortieSupport {
    /// 前衛支援 (non-goal battle nodes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<SupportInput>,
    /// 決戦支援 (the goal node).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boss: Option<SupportInput>,
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
    /// Present with `support`: fraction of the node's battles in which support arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_rate: Option<f64>,
    /// Present with `friendFleet`: fraction of the node's battles in which the friend fleet fought.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_fleet_rate: Option<f64>,
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
    pub damecon: DameconSummary,
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
pub struct GaugeSummary {
    pub kind: GaugeKind,
    pub remaining: f64,
    pub expected_sorties: Option<f64>,
    pub p50_sorties: Option<f64>,
    pub p90_sorties: Option<f64>,
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
    pub friend: Vec<SortieShipSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gauge: Option<GaugeSummary>,
    /// Present with `baseRaids`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_raid: Option<BaseRaidSummary>,
    pub warnings: Vec<String>,
}
