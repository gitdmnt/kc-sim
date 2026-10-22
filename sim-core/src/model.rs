//! JSON contract (serde, camelCase). Mirrors `sim_core_types.d.ts`; see `docs/SIM_INTERFACE.md`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Formation {
    #[default]
    LineAhead,
    DoubleLine,
    Diamond,
    Echelon,
    LineAbreast,
    Vanguard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engagement {
    SameCourse,
    HeadOn,
    TAdvantage,
    TDisadvantage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AirState {
    None,
    Supremacy,
    Superiority,
    Parity,
    Denial,
    Incapability,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Rank {
    SS,
    S,
    A,
    B,
    C,
    D,
    E,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Friend,
    Enemy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DamageState {
    Healthy,
    Light,
    Moderate,
    Heavy,
    Sunk,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BattleKind {
    #[default]
    Day,
    DayNight,
    NightOnly,
    AirBattle,
    AirRaid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Detection {
    Success,
    SuccessLost,
    FailureLost,
    Failure,
    Found,
    NotFound,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    AirStrike,
    OpeningAsw,
    OpeningTorpedo,
    Shelling1,
    Shelling2,
    ClosingTorpedo,
    Night,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttackKind {
    Air,
    Shelling,
    Asw,
    Torpedo,
    Night,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpecialAttack {
    #[default]
    Normal,
    DoubleAttack,
    CutinMainSecondary,
    CutinMainRadar,
    CutinMainAp,
    CutinMainMain,
    CvciFba,
    CvciBba,
    CvciBa,
    NightDoubleAttack,
    NightCutinMixed,
    NightCutinTorpedo,
    NightCutinGunSecondary,
    NightCutinGunMain,
    DdciGunTorpRadar,
    DdciLookoutTorpRadar,
    DdciTorpLookoutTorp,
    DdciTorpLookoutDrum,
    DdciGunTorpRadarDouble,
    DdciLookoutTorpRadarDouble,
    DdciTorpLookoutTorpDouble,
    DdciTorpLookoutDrumDouble,
    NightCvciFfa,
    NightCvciFa,
    NightCvciBomber,
    NightCvciFOther,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HitResult {
    Miss,
    Hit,
    Critical,
}

// ----------------------------------------------------------------- input ----

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EquipmentStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firepower: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub torpedo: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anti_air: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub armor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evasion: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asw: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub los: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accuracy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bombing: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub luck: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquipmentInput {
    pub id: u32,
    pub types: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<EquipmentStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub improvement: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proficiency: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planes: Option<i32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipStats {
    pub firepower: f64,
    pub torpedo: f64,
    pub anti_air: f64,
    pub armor: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evasion: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asw: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub los: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub luck: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub ship_type: u32,
    /// api_ctype (ship class); enables class-specific rules (Akizuki-class AACI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_class: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<f64>,
    pub max_hp: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hp: Option<i32>,
    pub stats: ShipStats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equip_bonus: Option<EquipmentStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_accuracy: Option<f64>,
    /// Hidden torpedo accuracy (kcsim `TACC`): added to torpedo-phase accuracy only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torpedo_accuracy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub morale: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuel: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuel_max: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ammo: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ammo_max: Option<i32>,
    #[serde(default)]
    pub slots: Vec<Option<EquipmentInput>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ex_slot: Option<EquipmentInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_installation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_opening_asw: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub night_attacker: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetInput {
    pub ships: Vec<ShipInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formation: Option<Formation>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BattleOptions {
    pub kind: BattleKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engagement: Option<Engagement>,
    pub log: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleInput {
    pub friend: FleetInput,
    pub enemy: FleetInput,
    #[serde(default)]
    pub options: BattleOptions,
}

// ---------------------------------------------------------------- output ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipResult {
    pub max_hp: i32,
    pub hp_start: i32,
    pub hp_end: i32,
    pub sunk: bool,
    pub damage_state: DamageState,
    pub damage_dealt: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub damecon_used: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttackEvent {
    pub phase: Phase,
    pub kind: AttackKind,
    pub special: SpecialAttack,
    pub attacker_side: Side,
    pub attacker: usize,
    pub defender: usize,
    pub covered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<usize>,
    pub hit: HitResult,
    pub damage: i32,
    pub defender_hp_before: i32,
    pub defender_hp_after: i32,
    pub p_hit: f64,
    pub p_crit: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleResult {
    pub rank: Rank,
    pub mvp: usize,
    pub engagement: Engagement,
    pub air_state: AirState,
    pub detection: Detection,
    pub night_battle: bool,
    pub enemy_gauge: i32,
    pub friend_gauge: i32,
    pub friend: Vec<ShipResult>,
    pub enemy: Vec<ShipResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<AttackEvent>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleState {
    pub friend: FleetInput,
    pub enemy: FleetInput,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBattleOutput {
    pub result: BattleResult,
    pub state: BattleState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipSummary {
    pub max_hp: i32,
    pub hp_mean: f64,
    pub hp_histogram: Vec<u32>,
    pub sunk_rate: f64,
    pub heavy_rate: f64,
    pub moderate_rate: f64,
    pub light_rate: f64,
    pub healthy_rate: f64,
    pub damage_dealt_mean: f64,
    pub mvp_rate: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RankRates {
    #[serde(rename = "SS")]
    pub ss: f64,
    #[serde(rename = "S")]
    pub s: f64,
    #[serde(rename = "A")]
    pub a: f64,
    #[serde(rename = "B")]
    pub b: f64,
    #[serde(rename = "C")]
    pub c: f64,
    #[serde(rename = "D")]
    pub d: f64,
    #[serde(rename = "E")]
    pub e: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirStateRates {
    pub none: f64,
    pub supremacy: f64,
    pub superiority: f64,
    pub parity: f64,
    pub denial: f64,
    pub incapability: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationSummary {
    pub count: u32,
    pub rank_rates: RankRates,
    pub air_state_rates: AirStateRates,
    pub night_battle_rate: f64,
    pub enemy_flagship_sunk_rate: f64,
    pub friend_heavy_any_rate: f64,
    pub friend_sunk_any_rate: f64,
    pub friend: Vec<ShipSummary>,
    pub enemy: Vec<ShipSummary>,
}

// --------------------------------------------------------- forward model ----

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryKind {
    Shelling,
    Torpedo,
    Night,
    Asw,
    OpeningAsw,
    Air,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NightContext {
    pub own_starshell: bool,
    pub enemy_starshell: bool,
    pub own_searchlight: bool,
    pub enemy_searchlight: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub night_contact_accuracy: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttackQuery {
    pub kind: QueryKind,
    pub attacker: ShipInput,
    pub defender: ShipInput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attacker_side: Option<Side>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attacker_formation: Option<Formation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defender_formation: Option<Formation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attacker_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attacker_fleet_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defender_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defender_fleet_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engagement: Option<Engagement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub special: Option<SpecialAttack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub night: Option<NightContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_modifier: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitProbability {
    pub p_hit: f64,
    pub p_crit: f64,
    pub accuracy: f64,
    pub evasion: f64,
}

/// Ship of an [`AttackQuery`] whose hidden stats are varied by [`HitGridQuery`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GridTarget {
    Attacker,
    Defender,
}

/// Forward model over a cartesian grid of one ship's hidden stats (estimator helper).
/// Each axis replaces the target's naked `stats.evasion` / `stats.luck` / `hiddenAccuracy`;
/// an absent or empty axis keeps the query's value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitGridQuery {
    pub query: AttackQuery,
    pub target: GridTarget,
    #[serde(default)]
    pub evasion: Vec<f64>,
    #[serde(default)]
    pub luck: Vec<f64>,
    #[serde(default)]
    pub hidden_accuracy: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DamagePoint {
    pub damage: i32,
    pub p: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamageDistribution {
    pub mean_hit: f64,
    pub mean_critical: f64,
    pub hit: Vec<DamagePoint>,
    pub critical: Vec<DamagePoint>,
}
