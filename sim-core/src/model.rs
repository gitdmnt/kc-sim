//! JSON contract (serde, camelCase). Mirrors `sim_core_types.d.ts`; see private notes SIM_INTERFACE.

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
    /// 第一警戒航行序列 (combined fleets only).
    CombinedAntiSub,
    /// 第二警戒航行序列.
    CombinedForward,
    /// 第三警戒航行序列.
    CombinedDiamond,
    /// 第四警戒航行序列.
    CombinedBattle,
    /// Internal: the pre-rework echelon table kcsim applies to an enemy echelon fleet facing a
    /// combined friend fleet (`SIMCONSTS.echelonOld`). Never part of the JSON contract.
    #[doc(hidden)]
    #[serde(skip)]
    EchelonOld,
}

impl Formation {
    /// One of the four cruising formations (警戒航行序列) of a combined fleet.
    pub fn is_combined(self) -> bool {
        matches!(self, Formation::CombinedAntiSub | Formation::CombinedForward | Formation::CombinedDiamond | Formation::CombinedBattle)
    }
}

/// Combined fleet type: 空母機動部隊 / 水上打撃部隊 / 輸送護衛部隊.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CombinedType {
    Carrier,
    Surface,
    Transport,
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
    /// Night battle first, then the day battle when the enemy is still afloat (払暁戦; kcsim
    /// `simNightFirstCombined` against an enemy combined fleet). Single friend fleets only.
    NightToDay,
}

/// Installation (陸上型) kind, kcSHIPDATA `installtype` 1..6: soft-skinned (飛行場姫, 港湾棲姫, …),
/// artillery imp / pillbox (砲台小鬼, トーチカ), supply depot (集積地), isolated island (離島棲姫,
/// 中枢棲姫), northernmost landing princess (北端上陸姫), summer harbour princess (港湾夏姫).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallationKind {
    SoftSkinned,
    Artillery,
    SupplyDepot,
    IsolatedIsland,
    Northernmost,
    HarbourSummer,
}

/// Abyssal targets with their own post-cap damage table (kcSHIPDATA `isSummerBB`, `isSummerCA`,
/// `isSummerCV`, `isFrenchBB`, `isEuroWP`, `isAnchorage`, `isDock`; kcships `*PostMult`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetGroup {
    SummerBattleship,
    SummerHeavyCruiser,
    SummerCarrier,
    FrenchBattleship,
    EuropeanPrincess,
    Anchorage,
    Dock,
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
    /// Jet assault (噴式強襲) of land-base jets, before the land-base waves.
    JetLandBase,
    /// Jet assault of the fleets' carrier jets, before the land-base waves.
    JetAirStrike,
    /// Land-based air squadron waves (before the air phase).
    LandBase,
    AirStrike,
    OpeningAsw,
    OpeningTorpedo,
    Shelling1,
    Shelling2,
    /// Third shelling round of a combined friend fleet.
    Shelling3,
    ClosingTorpedo,
    Night,
    /// Support expedition (支援艦隊); `attacker` = support fleet ship index.
    Support,
    /// Friend fleet (友軍艦隊) at night; friend-side `attacker` / enemy-side `defender` index the
    /// friend fleet's ships.
    FriendFleet,
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
    // fleet special attacks (特殊砲撃), kcsim attackSpecial 100..106, 300..302, 400, 401
    NelsonTouch,
    NagatoCutin,
    MutsuCutin,
    ColoradoCutin,
    KongouCutin,
    RichelieuCutin,
    QueenElizabethCutin,
    SubFleetAttack,
    YamatoCutin3,
    YamatoCutin2,
    // jet carrier cut-ins (kcsim AS types 74..76): jet fighter + 2 jet bombers / + jet bomber /
    // + dive + torpedo bomber
    CvciJfJbJb,
    CvciJfJb,
    CvciJfBa,
    // Zuiun / 634 Air Group day cut-ins (kcsim AS types 200 / 201)
    ZuiunCutin,
    Bomber634Cutin,
    // night Zuiun cut-ins (kcsim 2001..2004): 2 Zuiun + radar, 2 Zuiun, Zuiun + radar, Zuiun
    NightZuiunZzr,
    NightZuiunZz,
    NightZuiunZr,
    NightZuiunZ,
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

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
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
    /// Aircraft combat radius (master api_distance). Land-base reach checks only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<u32>,
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
    /// Installation kind (kcSHIPDATA `installtype`); implies `isInstallation` unless that is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation_kind: Option<InstallationKind>,
    /// PT imp group (PT小鬼群, kcSHIPDATA `isPT`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pt_imp: Option<bool>,
    /// Takes the supply-depot post-cap bonus without being an installation (kcSHIPDATA
    /// `isSupplyDepot`, 集積地棲姫III バカンスmode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supply_depot: Option<bool>,
    /// Dive-bomber airstrike damage multiplier against this ship (kcSHIPDATA `divebombWeak`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub divebomb_weak: Option<f64>,
    /// Land-based airstrike pre-cap multiplier against this ship (kcSHIPDATA `LBWeak`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lb_weak: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_group: Option<TargetGroup>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetInput {
    /// Main fleet (主力). Combined fleets: per-ship outputs list these first, then the escort.
    pub ships: Vec<ShipInput>,
    /// Combined friend: one of the `combined*` formations (default `combinedBattle`); an enemy
    /// combined fleet likewise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formation: Option<Formation>,
    /// Escort fleet (随伴), 1..6 ships. Friend: requires `combined`. Enemy: an enemy combined
    /// fleet (6 vs 12 / 12 vs 12).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escort: Option<Vec<ShipInput>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combined: Option<CombinedType>,
    /// Friend fleet: a smoke screen was already deployed this sortie (once per sortie).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smoke_used: Option<bool>,
    /// Sortie carry-over: a fleet special attack (once per sortie) was already used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub special_attack_used: Option<bool>,
    /// Kongou-class night special attacks used this sortie (max 3, counted separately).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kongou_special_count: Option<u32>,
}

impl FleetInput {
    /// Escort ships (empty for a single fleet).
    pub fn escort_ships(&self) -> &[ShipInput] {
        self.escort.as_deref().unwrap_or(&[])
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BattleOptions {
    pub kind: BattleKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engagement: Option<Engagement>,
    pub log: bool,
    /// The friend fleet tries to deploy a smoke screen (煙幕) at this node.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub smoke: bool,
    /// Force the smoke screen: layers (0 none, 1..3) deployed at the start of the battle in
    /// place of the `smoke` roll, as a battle packet shows them (`api_smoke_type`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoke_layers: Option<u8>,
    /// Barrage-balloon node (阻塞気球): balloons equipped by either fleet take effect.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub balloons: bool,
    /// Atoll node (環礁): friend submarines (from level 10) and the other kcsim anti-atoll ships
    /// attack with their 特四式内火艇 (/改) in the opening torpedo and at night.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub atoll: bool,
    /// Trigger rates (percent) overriding the defaults of the fleet special attacks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub special_attack_rates: Option<SpecialAttackRates>,
}

/// Trigger rates in percent of the fleet special attacks; absent = default (formula of the
/// level / luck of the participants where one is known, else kcsim's fixed rate).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpecialAttackRates {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nelson_touch: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nagato: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mutsu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colorado: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kongou: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub richelieu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queen_elizabeth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yamato3: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yamato2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_fleet: Option<f64>,
    /// Chance of the second attack of a level ≥ 75 submarine without a submarine radar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_fleet_second: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleInput {
    pub friend: FleetInput,
    pub enemy: FleetInput,
    #[serde(default)]
    pub options: BattleOptions,
    /// Land-base waves in order, resolved before the air phase. Each wave is independent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lbas: Option<Vec<LandBaseWave>>,
    /// Enemy air raid on the land bases (基地空襲), resolved before the battle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_raid: Option<BaseRaidInput>,
    /// Event historical bonuses of the friend ships, in `friend.ships` order (`null` / missing = none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bonuses: Option<Vec<Option<ShipBonusSet>>>,
    /// Event bonuses of the friend escort ships, in `friend.escort` order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escort_bonuses: Option<Vec<Option<ShipBonusSet>>>,
    /// Event bonuses of the land-base waves, in `lbas` order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lbas_bonuses: Option<Vec<Option<BaseBonusSet>>>,
    /// Armor debuffs of the enemy ships.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debuffs: Option<Vec<ArmorDebuff>>,
    /// Support expedition (支援艦隊) arriving at this battle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support: Option<SupportInput>,
    /// Friend fleet (友軍艦隊): fights at night before the player's night battle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_fleet: Option<FriendFleetInput>,
    /// Event bonuses of the friend fleet's ships, in `friend_fleet.fleet.ships` order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_fleet_bonuses: Option<Vec<Option<ShipBonusSet>>>,
}

/// Event historical bonus multipliers (kancolle-replay `bonusDmg` / `bonusAcc` / `bonusEva`); each
/// default 1.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamageMods {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dmg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acc: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eva: Option<f64>,
}

/// Plane bonus group (kancolle-replay `bonusGroups`, kcsim `getBonusSpecialPlane`): applies while any
/// of `slots` (ships: 0–4, 5 the reinforcement slot; land bases: squadrons 0–3) still has planes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneBonusGroup {
    pub slots: Vec<usize>,
    #[serde(flatten)]
    pub mods: DamageMods,
    /// Also for attacks without planes and for evasion (kcsim `bonusSpecialPNotAirOnly`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub not_air_only: bool,
}

/// Event bonuses of one friend ship in one battle.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipBonusSet {
    #[serde(flatten)]
    pub mods: DamageMods,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planes: Option<Vec<PlaneBonusGroup>>,
}

/// Event bonuses of one land base in one battle (`eva` is ignored).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseBonusSet {
    /// Per squadron (kcsim `bonusSpecialPSelf` / `bonusSpecialAccPSelf`), in `squadrons` order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub squadrons: Option<Vec<Option<DamageMods>>>,
    /// Base-wide plane groups over the squadron indices (kcsim `bonusSpecialPUseAll`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planes: Option<Vec<PlaneBonusGroup>>,
}

/// Armor debuff of enemy ships (kancolle-replay `listDebuff` / `applyAutoDebuff`): armor
/// `max(1, armor − amount)` for the ships whose `id` is listed (absent = every enemy ship); the last
/// matching entry wins.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmorDebuff {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_id: Option<Vec<u32>>,
    pub amount: f64,
}

/// Support type; omitted = derived from the support fleet's composition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SupportType {
    Air,
    Shelling,
    Torpedo,
    Asw,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportInput {
    pub fleet: FleetInput,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<SupportType>,
    /// Arrival chance override in [0,1].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chance: Option<f64>,
    /// Boss support (決戦支援). Single battles only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boss: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendFleetInput {
    pub fleet: FleetInput,
    /// Arrival chance in [0,1]. Default 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chance: Option<f64>,
    /// Sortie only: node letters where the friend fleet can arrive (default: the goal node).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nodes: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportResult {
    pub arrived: bool,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<SupportType>,
}

/// One land-base wave: one base's squadrons (1..4). `planes` is the squadron size (default 18,
/// recon categories 4, large land-based bombers 9). Consecutive waves with identical squadrons are
/// one base sent twice to this node (集中): the jet assault counts it once.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandBaseWave {
    pub squadrons: Vec<EquipmentInput>,
}

/// A land base under an enemy air raid. Only `defense` bases send planes up.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RaidBase {
    pub squadrons: Vec<EquipmentInput>,
    /// 防空 (air defence).
    pub defense: bool,
    /// Current base HP (default 200).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hp: Option<i32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRaidInput {
    /// Raiding enemy fleet (its bombers attack the bases).
    pub enemy: FleetInput,
    pub bases: Vec<RaidBase>,
    /// High-altitude raid (高高度空襲) even without heavy bombers in `enemy` (most recent event raids).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high_altitude: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRaidResult {
    pub air_state: AirState,
    /// HP lost per base (index as `bases`).
    pub hp_lost: Vec<i32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseRaidSummary {
    /// Sorties only: fraction of sorties in which a raid happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    pub air_state_rates: AirStateRates,
    /// Mean HP lost per base, over the raids.
    pub hp_lost_mean: Vec<f64>,
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
    /// Main-fleet MVP (index into `friend`).
    pub mvp: usize,
    /// Combined friend fleet: escort-fleet MVP (index into `friend`, main ships first).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mvp_escort: Option<usize>,
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
    /// Smoke screen deployed by the friend fleet: 1..3 layers; absent = none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smoke: Option<u8>,
    /// Present when `options.log` is true: AACI activations and rocket barrages per air phase.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_defense: Option<Vec<AirDefenseEvent>>,
    /// Present when `support` was given and the battle reached the support phase.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support: Option<SupportResult>,
    /// Present when `friendFleet` was given: true if it fought.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_fleet: Option<bool>,
    /// Present when `baseRaid` was given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_raid: Option<BaseRaidResult>,
}

/// Air defence event of the defending side in one air-combat phase.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirDefenseEvent {
    pub phase: Phase,
    /// Side that defends (whose ship fires).
    pub side: Side,
    /// Index of the ship in its fleet (combined friend: main ships first).
    pub ship: usize,
    /// AACI kind (`api_kind`), absent for a rocket barrage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aaci: Option<u8>,
    /// Rocket barrage (対空噴進弾幕) triggered: the ship evades every airstrike of this phase.
    pub rocket_barrage: bool,
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
    /// Present with `support`: fraction of battles in which support arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_rate: Option<f64>,
    /// Present with `friendFleet`: fraction of battles in which the friend fleet fought.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_fleet_rate: Option<f64>,
    /// Present with `baseRaid`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_raid: Option<BaseRaidSummary>,
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
    /// Event bonuses of the attacker / defender (a friend ship); absent = none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attacker_bonus: Option<ShipBonusSet>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defender_bonus: Option<ShipBonusSet>,
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
