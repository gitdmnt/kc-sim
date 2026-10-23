//! Per-ship derived combat data (`ShipCore`, immutable during a battle) and the mutable
//! per-battle state (`ShipState`). Derivations follow KC3Kai/kancolle-replay `js/kcships.js`
//! (`Ship.loadEquips`, `NBtypes`, `AStype`, `ASWPower`, `weightedAntiAir`, ...), MIT © fourinone41.

use crate::equipment::{f, Equip, Improves, ID_DAMECON_GODDESS, ID_DAMECON_TEAM, ID_DRUM, ID_NIGHT_ZUIUN, ID_SKILLED_LOOKOUTS, ID_TSLO};
use crate::model::{EquipmentStats, ShipInput};

pub use crate::aaci::{aaci_trigger_rate, AACI_TABLE};

/// Maximum slots per ship: 5 regular + reinforcement expansion.
pub const MAX_SLOTS: usize = 6;
pub const EX_SLOT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShipClass {
    DE,
    DD,
    CL,
    CLT,
    CA,
    CAV,
    CVL,
    FBB,
    BB,
    BBV,
    CV,
    SS,
    SSV,
    AP,
    AV,
    LHA,
    CVB,
    AR,
    AS,
    CT,
    AO,
}

impl ShipClass {
    pub fn from_stype(stype: u32) -> ShipClass {
        use ShipClass::*;
        match stype {
            1 => DE,
            2 => DD,
            3 => CL,
            4 => CLT,
            5 => CA,
            6 => CAV,
            7 => CVL,
            8 => FBB,
            9 | 12 => BB,
            10 => BBV,
            11 => CV,
            13 => SS,
            14 => SSV,
            15 => AP,
            16 => AV,
            17 => LHA,
            18 => CVB,
            19 => AR,
            20 => AS,
            21 => CT,
            22 => AO,
            _ => DD,
        }
    }

    pub fn is_carrier(self) -> bool {
        matches!(self, ShipClass::CVL | ShipClass::CV | ShipClass::CVB)
    }

    pub fn is_sub(self) -> bool {
        matches!(self, ShipClass::SS | ShipClass::SSV)
    }

    pub fn is_bb_class(self) -> bool {
        matches!(self, ShipClass::FBB | ShipClass::BB | ShipClass::BBV)
    }

    fn default_range(self) -> u8 {
        use ShipClass::*;
        match self {
            FBB | BB | BBV => 3,
            CL | CLT | CA | CAV | CT | AV | LHA | AO | AR | AS => 2,
            _ => 1,
        }
    }
}

/// Day artillery-spotting / carrier cut-in kinds (kcsim ARTILLERYSPOTDATA keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DayCi {
    /// 2: double attack
    DoubleAttack,
    /// 3: main + secondary
    MainSec,
    /// 4: main + secondary + radar
    MainRadar,
    /// 5: main + secondary + AP
    MainAp,
    /// 6: 2 main + AP
    MainMain,
    /// 71: fighter + dive + torpedo bomber
    CvciFba,
    /// 72: 2 dive + torpedo bomber
    CvciBba,
    /// 73: dive + torpedo bomber
    CvciBa,
    /// 74: jet fighter + 2 jet bombers
    CvciJfJbJb,
    /// 75: jet fighter + jet bomber
    CvciJfJb,
    /// 76: jet fighter + dive + torpedo bomber
    CvciJfBa,
    /// 200: 2 Zuiun seaplane bombers + main gun (瑞雲立体攻撃, Ise-class Kai Ni)
    Zuiun,
    /// 201: 2 Suisei (634 Air Group) + main gun (海空立体攻撃, Ise-class Kai Ni)
    Bomber634,
}

pub struct DayCiData {
    pub dmg: f64,
    pub acc: f64,
    pub chance: f64,
    pub double: bool,
}

impl DayCi {
    pub fn data(self) -> DayCiData {
        let (dmg, acc, chance, double) = match self {
            DayCi::DoubleAttack => (1.2, 1.1, 1.3, true),
            DayCi::MainSec => (1.1, 1.3, 1.2, false),
            DayCi::MainRadar => (1.2, 1.5, 1.3, false),
            DayCi::MainAp => (1.3, 1.3, 1.4, false),
            DayCi::MainMain => (1.5, 1.2, 1.5, false),
            DayCi::CvciFba => (1.25, 1.35, 1.25, false),
            DayCi::CvciBba => (1.2, 1.2, 1.4, false),
            DayCi::CvciBa => (1.15, 1.18, 1.55, false),
            DayCi::CvciJfJbJb => (1.35, 1.35, 1.35, false),
            DayCi::CvciJfJb => (1.3, 1.35, 1.25, false),
            DayCi::CvciJfBa => (1.27, 1.35, 1.15, false),
            DayCi::Zuiun => (1.35, 1.2, 1.2, false),
            DayCi::Bomber634 => (1.3, 1.2, 1.3, false),
        };
        DayCiData { dmg, acc, chance, double }
    }

    pub fn is_cvci(self) -> bool {
        matches!(self, DayCi::CvciFba | DayCi::CvciBba | DayCi::CvciBa | DayCi::CvciJfJbJb | DayCi::CvciJfJb | DayCi::CvciJfBa)
    }
}

/// Night attack kinds (kcsim NBATTACKDATA keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NightCi {
    /// 1
    DoubleAttack,
    /// 2: main + torpedo
    Mixed,
    /// 3: 2 torpedoes
    Torpedo,
    /// 4: 2 main + secondary
    GunSec,
    /// 5: 3 main
    GunMain,
    /// 7: DD main + torpedo + radar (x1); 11 = x2 variant
    DdGtr,
    /// 8: DD lookout + torpedo + radar; 12 = x2
    DdLtr,
    /// 9: DD TSLO + 2 torpedoes; 13 = x2
    DdTtl,
    /// 10: DD TSLO + torpedo + drum; 14 = x2
    DdTdl,
    /// Carrier night CI 61: 2 night fighters + night attacker.
    CvFfa,
    /// 62: night fighter + night attacker.
    CvFa,
    /// 63: night dive bomber / photoelectric-fuze Suisei + another night plane.
    CvBomber,
    /// 64: night fighter + 2 other night-capable planes.
    CvFOther,
}

pub struct NightCiData {
    pub dmg: f64,
    pub acc: f64,
    /// 0 = always (double attack, 99%).
    pub chance: f64,
    pub double: bool,
    pub torpedo: bool,
    /// (x2 variant, chance to replace) for DD cut-ins at level >= 80.
    pub replace: Option<(f64, f64, f64, f64)>,
}

impl NightCi {
    pub fn data(self) -> NightCiData {
        // (dmg, acc, chance, double, torpedo, replace(dmg2, acc2, chance2, replaceChance))
        let (dmg, acc, chance, double, torpedo, replace) = match self {
            NightCi::DoubleAttack => (1.2, 1.1, 0.0, true, false, None),
            NightCi::Mixed => (1.3, 1.5, 1.15, true, true, None),
            NightCi::Torpedo => (1.5, 1.65, 1.22, true, true, None),
            NightCi::GunSec => (1.75, 1.5, 1.3, false, false, None),
            NightCi::GunMain => (2.0, 2.0, 1.4, false, false, None),
            NightCi::DdGtr => (1.3, 1.1, 1.15, false, false, Some((1.3, 1.1, 1.3, 0.65))),
            NightCi::DdLtr => (1.2, 1.65, 1.4, false, false, Some((1.2, 1.65, 1.4, 0.5))),
            NightCi::DdTtl => (1.5, 1.65, 1.25, false, false, Some((1.5, 1.65, 1.25, 0.875))),
            NightCi::DdTdl => (1.3, 1.5, 1.22, false, false, Some((1.3, 1.5, 1.22, 0.55))),
            NightCi::CvFfa => (1.25, 1.25, 1.05, false, false, None),
            NightCi::CvFa => (1.2, 1.2, 1.2, false, false, None),
            NightCi::CvBomber => (1.2, 1.2, 1.2, false, false, None),
            NightCi::CvFOther => (1.18, 1.2, 1.3, false, false, None),
        };
        NightCiData { dmg, acc, chance, double, torpedo, replace }
    }

    pub fn is_carrier(self) -> bool {
        matches!(self, NightCi::CvFfa | NightCi::CvFa | NightCi::CvBomber | NightCi::CvFOther)
    }
}

/// Ships with built-in night aviation personnel (kcsim kcSHIPDATA `hasBuiltInNightCrew`): Saratoga
/// Mk.II, Akagi/Kaga Kai Ni E, Ryuuhou Kai Ni E, … and abyssal night carriers.
const BUILTIN_NIGHT_CREW_IDS: [u32; 6] = [545, 599, 610, 883, 1008, 1036];

fn builtin_night_crew(id: u32) -> bool {
    BUILTIN_NIGHT_CREW_IDS.contains(&id)
        || (1964..=1976).contains(&id)
        || (2041..=2046).contains(&id)
        || (2059..=2062).contains(&id)
        || (2105..=2108).contains(&id)
        || (2115..=2131).contains(&id)
        || (2146..=2151).contains(&id)
        || (2222..=2227).contains(&id)
        || (2256..=2261).contains(&id)
        || (2344..=2349).contains(&id)
        || (2368..=2373).contains(&id)
        || (2392..=2397).contains(&id)
}

impl ShipCore {
    /// Shells, cuts in and targets like a carrier: CVL/CV/CVB, or an air-capable AO with bombers
    /// (kcsim `CVshelltype`).
    pub fn cv_like(&self) -> bool {
        self.class.is_carrier() || self.air_ao
    }

    /// Carrier night air attack possible now (kcsim `CV.canNBAirAttack`; Ark Royal-class with a
    /// Swordfish also without night aviation personnel).
    pub fn can_night_air(&self, st: &ShipState) -> bool {
        let limit = if self.class == ShipClass::CVB { 0.25 } else { 0.5 };
        (self.night_air_gear || self.ark_swordfish) && st.hp_ratio(self.max_hp) > limit
    }

    /// Carrier night cut-in kinds available with the current plane counts (kcsim `CV.NBtypes`).
    pub fn night_cv_ci(&self, st: &ShipState) -> Vec<NightCi> {
        let (mut fuze, mut fi, mut at, mut db, mut b2) = (0, 0, 0, 0, 0);
        for (i, e) in self.slots.iter().enumerate() {
            let Some(e) = e else { continue };
            if self.is_player && st.planes[i] <= 0 {
                continue;
            }
            if e.has(f::NIGHT_FIGHTER) {
                fi += 1;
            } else if e.has(f::NIGHT_ATTACKER) {
                at += 1;
            } else if e.has(f::NIGHT_DIVE) {
                db += 1;
            } else if e.has(f::NIGHT_BOMBER2) {
                b2 += 1;
            }
            if e.id == crate::equipment::ID_NIGHT_FUZE {
                fuze += 1;
            }
        }
        let night = fi + at + db;
        let mut out = Vec::new();
        if fi >= 2 && at >= 1 {
            out.push(NightCi::CvFfa);
        }
        if fi >= 1 && at >= 1 {
            out.push(NightCi::CvFa);
        }
        if fuze + db >= 1 && night + fuze >= 2 {
            out.push(NightCi::CvBomber);
        }
        if fi >= 1 && night + b2 >= 3 {
            out.push(NightCi::CvFOther);
        }
        out
    }
}

/// Abyssal carriers without carrier cut-ins (kcsim kcSHIPDATA `cannotCVCI`): Nu / Wo-class, 新量産空母棲姫.
const CANNOT_CVCI_IDS: [u32; 26] = [
    1510, 1512, 1523, 1525, 1528, 1560, 1565, 1579, 1614, 1615, 1762, 1763, 1764, 1765, 1766, 1776, 1777, 1778, 1779, 1780, 2222, 2223,
    2224, 2225, 2226, 2227,
];
/// Ise-class Kai Ni (kcSHIPDATA `canZuiunCI`): Zuiun / 634 Air Group day cut-ins.
const ZUIUN_CI_IDS: [u32; 2] = [553, 554];
/// Ark Royal class (api_ctype).
const CLASS_ARK_ROYAL: u32 = 78;
/// Abyssal submarines that never fire opening torpedoes (kcsim kcSHIPDATA `canOpTorp: false`):
/// base Ka / Yo / So-class and 潜水棲姫.
const NO_OPENING_TORPEDO_IDS: [u32; 6] = [1530, 1531, 1570, 1644, 1645, 1646];
/// Player ships that always perform opening ASW (kcsim kcSHIPDATA `alwaysOASW` or Lv1 ASW ≥ 50):
/// Isuzu K2, Tatsuta K2, Jervis/Janus Kai, Samuel B. Roberts, Fletcher class, Taiyou class, Yuubari K2D, …
const ALWAYS_OASW_IDS: [u32; 26] = [
    141, 380, 381, 382, 394, 478, 529, 536, 562, 596, 624, 628, 629, 646, 681, 689, 692, 726, 737, 889, 893, 906, 920, 1040, 1062, 1067,
];
/// Player carriers that make plain night attacks (kcSHIPDATA `nightattack`): Graf Zeppelin / 改,
/// Saratoga, 大鷹改二, 神鷹改二, 加賀改二護, Lexington / 改, 雲鷹改二.
const NIGHT_ATTACKER_IDS: [u32; 9] = [353, 432, 433, 529, 536, 646, 735, 889, 966];
/// Fleet oilers that attack like carriers when they carry a dive or torpedo bomber (kcsim
/// kcSHIPDATA `canAirAttack`): 速吸改, 山汐丸改, しまね丸改. しまね丸改 (`canAirAttackNB`) also makes
/// night air attacks with night aviation personnel.
const AIR_AO_IDS: [u32; 3] = [352, 717, 1008];
const NIGHT_AIR_AO_ID: u32 = 1008;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stats {
    pub fp: f64,
    pub tp: f64,
    pub aa: f64,
    pub ar: f64,
    pub ev: f64,
    pub asw: f64,
    pub los: f64,
    pub luck: f64,
    pub acc: f64,
}

impl Stats {
    fn from_bonus(b: &EquipmentStats) -> Stats {
        let g = |v: Option<f64>| v.unwrap_or(0.0);
        Stats {
            fp: g(b.firepower),
            tp: g(b.torpedo),
            aa: g(b.anti_air),
            ar: g(b.armor),
            ev: g(b.evasion),
            asw: g(b.asw),
            los: g(b.los),
            luck: g(b.luck),
            acc: g(b.accuracy),
        }
    }
}

/// Immutable per-battle data of one ship.
#[derive(Clone, Debug)]
pub struct ShipCore {
    pub class: ShipClass,
    pub is_player: bool,
    pub level: f64,
    pub max_hp: i32,
    pub naked: Stats,
    pub bonus: Stats,
    /// Totals: naked + equipment + bonus (+ improvement armor).
    pub fp: f64,
    pub tp: f64,
    pub aa: f64,
    pub ar: f64,
    pub ev: f64,
    pub asw: f64,
    pub los: f64,
    pub luck: f64,
    /// Σ equipment accuracy (bonus accuracy is in `bonus.acc`, shelling only).
    pub acc: f64,
    /// Hidden flat accuracy (estimator input), added to every accuracy formula.
    pub hidden_acc: f64,
    /// Hidden torpedo accuracy (kcsim `TACC`), torpedo phases only.
    pub torp_acc_hidden: f64,
    pub range: u8,
    pub slots: [Option<Equip>; MAX_SLOTS],
    pub imp: Improves,
    /// Σ equipment LoS (artillery spotting).
    pub los_equip: f64,
    pub mguns: u32,
    pub sguns: u32,
    pub torps: u32,
    pub recons: u32,
    pub radars: u32,
    pub ap_shells: u32,
    pub has_sonar: bool,
    pub ap_type: u8,
    pub day_ci: Vec<DayCi>,
    pub night_ci: Vec<NightCi>,
    pub has_night_da: bool,
    pub nb_chance_base: f64,
    /// Late-model sub torpedoes / sub radar (sub torpedo cut-in variants).
    pub special_sub_torps: u32,
    pub has_sub_radar: bool,
    pub d_gun_k2: u32,
    pub d_gun_k3: u32,
    pub asw_power: f64,
    pub asw_penetrate: f64,
    pub sonar_acc: f64,
    pub plane_asw: u8,
    pub weighted_aa: f64,
    pub fleet_aa: f64,
    pub aaci: Vec<u8>,
    pub has_torp_stat: bool,
    pub has_midget_sub: bool,
    pub has_starshell: bool,
    pub searchlight: u8,
    pub has_lookout: bool,
    pub no_red_t: bool,
    /// Installation (陸上型): `target.kind` is `Some`.
    pub is_installation: bool,
    pub always_oasw: bool,
    pub night_attacker: bool,
    pub equip_asw_total: f64,
    /// Master id (`ShipInput.id`, 0 if absent) and ship class (`ShipInput.shipClass`, api_ctype).
    pub master_id: u32,
    pub ship_class: u32,
    /// Abyssal submarine type that never fires opening torpedoes.
    pub no_opening_torpedo: bool,
    /// Carrier (or night-capable air AO) with night aviation personnel (equipped or built in) and
    /// night planes.
    pub night_air_gear: bool,
    /// Air-capable AO with a dive / torpedo bomber equipped: shells, cuts in and does ASW like a carrier.
    pub air_ao: bool,
    /// Main-gun fit (friend ships, `fit::gun_fit`): accuracy in % added to shelling/night hit rate,
    /// firepower added to light cruiser shelling and night power.
    pub fit_acc: f64,
    pub fit_fp: f64,
    /// This ship as a target: installation kind, PT imp, supply depot, special target group.
    pub target: crate::install::TargetTraits,
    /// This ship's modifiers against installations / special targets / PT imps.
    pub vs: crate::install::VsMods,
    /// Surface radars (LoS ≥ 5): special-attack and night Zuiun radar bonuses.
    pub surface_radars: u32,
    /// Heavy cruiser night accuracy bonus in % (20.3cm guns, kcEQDATA `CANBbonus`).
    pub ca_night_acc: f64,
    /// Ark Royal-class with a Swordfish: night air attack without night personnel.
    pub ark_swordfish: bool,
    /// Night Zuiun cut-in capable (CL/CLT/CAV/BBV/AV with 2+ main guns and a Night Zuiun).
    pub night_zuiun: bool,
    /// Rocket barrage launchers (kcEQDATA `canBarrage`) on a CAV/BBV/carrier/AV.
    pub rocket_barrage: u32,
}

/// Mutable per-battle state of one ship.
#[derive(Clone, Debug)]
pub struct ShipState {
    pub hp: i32,
    pub planes: [i32; MAX_SLOTS],
    /// Proficiency experience per slot (reset to 0 when a slot is wiped out).
    pub exp: [f64; MAX_SLOTS],
    pub fuel: i32,
    pub fuel_max: i32,
    pub ammo: i32,
    pub ammo_max: i32,
    pub morale: i32,
    pub protected: bool,
    /// Slots that still hold an unused damage-control item.
    pub damecon_slots: u8,
    pub damecon_used: Option<u32>,
    pub dmg_dealt: i32,
}

impl ShipState {
    pub fn hp_ratio(&self, max_hp: i32) -> f64 {
        if max_hp <= 0 {
            0.0
        } else {
            self.hp as f64 / max_hp as f64
        }
    }
}

impl ShipCore {
    pub fn new(input: &ShipInput, is_player: bool) -> ShipCore {
        let class = ShipClass::from_stype(input.ship_type);
        let s = &input.stats;
        let naked = Stats {
            fp: s.firepower,
            tp: s.torpedo,
            aa: s.anti_air,
            ar: s.armor,
            ev: s.evasion.unwrap_or(0.0),
            asw: s.asw.unwrap_or(0.0),
            los: s.los.unwrap_or(0.0),
            luck: s.luck.unwrap_or(0.0),
            acc: 0.0,
        };
        let bonus = input.equip_bonus.as_ref().map(Stats::from_bonus).unwrap_or_default();
        let mut slots: [Option<Equip>; MAX_SLOTS] = Default::default();
        for (i, e) in input.slots.iter().take(EX_SLOT).enumerate() {
            slots[i] = e.as_ref().map(Equip::from_input);
        }
        slots[EX_SLOT] = input.ex_slot.as_ref().map(Equip::from_input);

        let mut core = ShipCore {
            class,
            is_player,
            level: input.level.unwrap_or(1.0).max(1.0),
            max_hp: input.max_hp.max(1),
            naked,
            bonus,
            fp: 0.0,
            tp: 0.0,
            aa: 0.0,
            ar: 0.0,
            ev: 0.0,
            asw: 0.0,
            los: 0.0,
            luck: 0.0,
            acc: 0.0,
            hidden_acc: 0.0,
            torp_acc_hidden: input.torpedo_accuracy.unwrap_or(0.0),
            range: input.range.map(|r| r.clamp(0.0, 5.0) as u8).unwrap_or_else(|| class.default_range()),
            slots,
            imp: Improves::default(),
            los_equip: 0.0,
            mguns: 0,
            sguns: 0,
            torps: 0,
            recons: 0,
            radars: 0,
            ap_shells: 0,
            has_sonar: false,
            ap_type: 0,
            day_ci: Vec::new(),
            night_ci: Vec::new(),
            has_night_da: false,
            nb_chance_base: 0.0,
            special_sub_torps: 0,
            has_sub_radar: false,
            d_gun_k2: 0,
            d_gun_k3: 0,
            asw_power: 0.0,
            asw_penetrate: 0.0,
            sonar_acc: 0.0,
            plane_asw: 0,
            weighted_aa: 0.0,
            fleet_aa: 0.0,
            aaci: Vec::new(),
            has_torp_stat: naked.tp > 0.0,
            has_midget_sub: false,
            has_starshell: false,
            searchlight: 0,
            has_lookout: false,
            no_red_t: false,
            is_installation: false,
            always_oasw: input.always_opening_asw.unwrap_or(is_player && ALWAYS_OASW_IDS.contains(&input.id.unwrap_or(0))),
            night_attacker: input.night_attacker.unwrap_or(is_player && NIGHT_ATTACKER_IDS.contains(&input.id.unwrap_or(0))),
            equip_asw_total: 0.0,
            master_id: input.id.unwrap_or(0),
            ship_class: input.ship_class.unwrap_or(0),
            no_opening_torpedo: !is_player && NO_OPENING_TORPEDO_IDS.contains(&input.id.unwrap_or(0)),
            night_air_gear: false,
            air_ao: false,
            fit_acc: 0.0,
            fit_fp: 0.0,
            target: Default::default(),
            vs: Default::default(),
            surface_radars: 0,
            ca_night_acc: 0.0,
            ark_swordfish: false,
            night_zuiun: false,
            rocket_barrage: 0,
        };
        if is_player {
            let mut ids = [(0u32, 0u32); MAX_SLOTS];
            let mut k = 0;
            for (_, e) in core.equips() {
                ids[k] = (e.id, e.cat);
                k += 1;
            }
            (core.fit_acc, core.fit_fp) = crate::fit::gun_fit(class, core.ship_class, core.master_id, core.level, &ids[..k]);
        }
        core.derive(input.hidden_accuracy.unwrap_or(0.0));
        (core.target, core.vs) = crate::install::derive(input, is_player, class, core.slots.iter().flatten());
        core.is_installation = core.target.kind.is_some();
        core
    }

    fn equips(&self) -> impl Iterator<Item = (usize, &Equip)> {
        self.slots.iter().enumerate().filter_map(|(i, e)| e.as_ref().map(|e| (i, e)))
    }

    fn derive(&mut self, hidden_acc: f64) {
        let n = self.naked;
        let b = self.bonus;
        self.hidden_acc = hidden_acc;
        self.air_ao = self.class == ShipClass::AO
            && AIR_AO_IDS.contains(&self.master_id)
            && self.equips().any(|(_, e)| matches!(e.cat, crate::equipment::cat::DIVE_BOMBER | crate::equipment::cat::TORP_BOMBER));
        let (mut fp, mut tp, mut aa, mut ar, mut ev, mut asw, mut los, mut luck, mut acc) =
            (n.fp + b.fp, n.tp + b.tp, n.aa + b.aa, n.ar + b.ar, n.ev + b.ev, n.asw + b.asw, n.los + b.los, n.luck + b.luck, 0.0);
        let mut imp = Improves::default();
        let mut range = self.range;
        let mut equip_asw_dmg = 0.0;
        let (mut has_sonar_s, mut has_dc, mut has_dc_proj, mut has_dc_only) = (false, false, false, false);
        let mut asw_pen = 0.0;
        let mut sonar_acc = 0.0;
        for e in self.slots.iter().flatten() {
            fp += e.fp;
            tp += e.tp;
            aa += e.aa;
            ar += e.ar;
            ev += e.ev;
            asw += e.asw;
            los += e.los;
            luck += e.luck;
            acc += e.acc;
            imp.add(&e.imp);
            range = range.max(e.range);
            self.los_equip += e.los;
            self.equip_asw_total += e.asw;
            if e.has(f::MAIN_GUN) {
                self.mguns += 1;
            }
            if e.has(f::SEC_GUN) {
                self.sguns += 1;
            }
            if e.has(f::TORPEDO) {
                self.torps += 1;
            }
            if e.has(f::RECON) {
                self.recons += 1;
            }
            if e.has(f::RADAR) {
                self.radars += 1;
            }
            if e.has(f::AP_SHELL) {
                self.ap_shells += 1;
            }
            if e.has(f::SONAR) {
                self.has_sonar = true;
                sonar_acc += 2.0 * e.asw;
            }
            if e.has(f::SONAR_SMALL) {
                has_sonar_s = true;
            }
            if e.has(f::DEPTH_CHARGE) {
                has_dc = true;
            }
            if e.has(f::DC_PROJECTOR) {
                has_dc_proj = true;
            }
            if e.has(f::DC_ONLY) {
                has_dc_only = true;
            }
            if e.has(f::ASW_PENETRATE) {
                asw_pen += ((e.asw - 2.0).max(0.0).sqrt() + if self.class == ShipClass::DE { 1.0 } else { 0.0 }).max(0.0);
            }
            if e.has(f::ASW_DAMAGE) {
                equip_asw_dmg += e.asw;
            }
            if e.has(f::MIDGET_SUB) {
                self.has_midget_sub = true;
            }
            if e.has(f::STARSHELL) {
                self.has_starshell = true;
            }
            if e.has(f::SEARCHLIGHT_S) {
                self.searchlight = self.searchlight.max(1);
            }
            if e.has(f::SEARCHLIGHT_L) {
                self.searchlight = 2;
            }
            if e.has(f::LOOKOUT) {
                self.has_lookout = true;
            }
            if e.has(f::NO_RED_T) {
                self.no_red_t = true;
            }
            if e.has(f::SUB_RADAR) {
                self.has_sub_radar = true;
            }
            if e.has(f::LATE_SUB_TORP) {
                self.special_sub_torps += 1;
            }
            if e.has(f::D_GUN_K2) {
                self.d_gun_k2 += 1;
            }
            if e.has(f::D_GUN_K3) {
                self.d_gun_k3 += 1;
            }
        }
        ar += imp.armor;
        self.fp = fp;
        self.tp = tp;
        self.aa = aa;
        self.ar = ar;
        self.ev = ev;
        self.asw = asw;
        self.los = los;
        self.luck = luck;
        self.acc = acc;
        self.imp = imp;
        self.range = range;
        self.asw_penetrate = asw_pen;
        self.sonar_acc = sonar_acc + imp.acc_asw;

        if self.ap_shells > 0 && self.mguns > 0 {
            self.ap_type = if self.radars > 0 && self.sguns > 0 {
                4
            } else if self.sguns > 0 {
                3
            } else if self.radars > 0 {
                2
            } else {
                1
            };
        }

        self.plane_asw = match self.class {
            ShipClass::CAV | ShipClass::BBV | ShipClass::AV | ShipClass::LHA => 1,
            ShipClass::CVL => 2,
            ShipClass::AO if self.air_ao => 2,
            _ => 0,
        };
        // ASWPower (kcsim): (2√nakedASW + 1.5·equipASW + class const + ★) × synergy.
        let mut synergy = 1.0;
        if has_dc_proj && has_dc_only {
            synergy *= if has_sonar_s { 1.25 } else { 1.1 };
        }
        if self.has_sonar && has_dc {
            synergy *= 1.15;
        }
        let class_asw = if self.plane_asw > 0 { 8.0 } else { 13.0 };
        self.asw_power =
            ((2.0 * n.asw.max(0.0).sqrt() + 1.5 * (equip_asw_dmg + b.asw) + class_asw + imp.p_asw) * synergy).max(0.0);

        self.derive_aa(n, b, imp);
        self.surface_radars = self.equips().filter(|(_, e)| e.has(f::SURFACE_RADAR)).count() as u32;
        self.derive_cutins();
        // kcships `CANBbonus`: 15 (20.3cm No.2 / No.3 …), 10 (20.3cm twin) overrides 15.
        if matches!(self.class, ShipClass::CA | ShipClass::CAV) {
            self.ca_night_acc = self
                .equips()
                .filter_map(|(_, e)| match e.id {
                    6 => Some(10.0),
                    50 | 90 | 520 => Some(15.0),
                    _ => None,
                })
                .fold(0.0, |m: f64, v| if m == 0.0 { v } else { m.min(v) });
        }
        self.ark_swordfish = self.class.is_carrier() && self.ship_class == CLASS_ARK_ROYAL && self.equips().any(|(_, e)| e.has(f::SWORDFISH));
        self.night_zuiun = matches!(self.class, ShipClass::CL | ShipClass::CLT | ShipClass::CAV | ShipClass::BBV | ShipClass::AV)
            && self.mguns >= 2
            && self.equips().any(|(_, e)| e.id == ID_NIGHT_ZUIUN);
        if matches!(self.class, ShipClass::CAV | ShipClass::BBV | ShipClass::CV | ShipClass::CVL | ShipClass::CVB | ShipClass::AV) {
            self.rocket_barrage = self.equips().filter(|(_, e)| e.has(f::ROCKET_BARRAGE)).count() as u32;
        }

        let mut nb = 0.0;
        if matches!(self.class, ShipClass::DD | ShipClass::CL | ShipClass::CLT) && self.equips().any(|(_, e)| e.id == ID_TSLO) {
            nb += 8.0;
        }
        if self.equips().any(|(_, e)| e.id == ID_SKILLED_LOOKOUTS) {
            nb += 5.0;
        }
        if self.luck >= 50.0 {
            nb += 65.0 + (self.luck - 50.0).sqrt().floor() + (self.level.sqrt() * 0.8).floor();
        } else {
            nb += (self.luck + 15.0 + self.level.sqrt() * 0.75).floor();
        }
        self.nb_chance_base = nb;
        let crew = builtin_night_crew(self.master_id) || self.equips().any(|(_, e)| e.has(f::NIGHT_CREW));
        let planes = self.equips().any(|(_, e)| e.has(f::NIGHT_FIGHTER | f::NIGHT_ATTACKER | f::NIGHT_DIVE));
        let night_air_ship = self.class.is_carrier() || (self.air_ao && self.master_id == NIGHT_AIR_AO_ID);
        self.night_air_gear = night_air_ship && crew && planes;
    }

    fn derive_aa(&mut self, n: Stats, b: Stats, imp: Improves) {
        // weightedAntiAir: player naked/2, enemy sqrt(total); + equipment AA × type weight.
        let mut w = if self.is_player { n.aa / 2.0 } else { self.aa.max(0.0).sqrt() };
        let mut fleet = 0.0;
        let mut any_equip = false;
        for (_, e) in self.equips() {
            any_equip = true;
            let wm = if e.has(f::HA_GUN | f::HAFD | f::AAFD) {
                2.0
            } else if e.has(f::AA_GUN) {
                3.0
            } else if e.has(f::AIR_RADAR) {
                1.5
            } else {
                0.0
            };
            w += e.aa * wm;
            let fm = if e.has(f::HA_GUN | f::HAFD | f::AAFD) {
                0.35
            } else if e.has(f::AIR_RADAR) {
                0.4
            } else if e.has(f::TYPE3_SHELL) {
                0.6
            } else {
                0.2
            };
            fleet += e.aa * fm;
        }
        if any_equip {
            w += imp.aa_self + b.aa * 0.75;
            w = w.floor();
        }
        self.weighted_aa = w;
        self.fleet_aa = (fleet + imp.aa_fleet).floor() + b.aa;

        // Every AACI kind needs one of these (HA gun, fire director, AA gun, radar, type 3 shell).
        const AA_GEAR: u64 = f::HA_GUN | f::AAFD | f::AA_GUN | f::RADAR | f::TYPE3_SHELL;
        if !self.slots.iter().flatten().any(|e| e.has(AA_GEAR)) {
            return;
        }
        let eqs: Vec<&Equip> = self.slots.iter().flatten().collect();
        self.aaci = crate::aaci::aaci_kinds(&crate::aaci::AaciShip {
            master_id: self.master_id,
            ship_class: self.ship_class,
            class: self.class,
            naked_aa: n.aa,
            equips: &eqs,
        });
    }

    fn derive_cutins(&mut self) {
        let (mg, sg, rad, ap, rec) = (self.mguns, self.sguns, self.radars, self.ap_shells, self.recons);
        let mut day = Vec::new();
        // kcships `AStype`: Ise-class Kai Ni 634 Air Group / Zuiun cut-ins (planes checked per attack).
        if ZUIUN_CI_IDS.contains(&self.master_id) && mg > 0 {
            if self.equips().filter(|(_, e)| e.has(f::BOMBER_634)).count() >= 2 {
                day.push(DayCi::Bomber634);
            }
            if self.equips().filter(|(_, e)| e.has(f::ZUIUN)).count() >= 2 {
                day.push(DayCi::Zuiun);
            }
        }
        if self.cv_like() && !CANNOT_CVCI_IDS.contains(&self.master_id) {
            use crate::equipment::cat;
            let has = |c: u32| self.equips().filter(|(_, e)| e.cat == c).count();
            let (fi, db, tb) = (has(cat::FIGHTER), has(cat::DIVE_BOMBER), has(cat::TORP_BOMBER));
            let (jf, jb) = (has(cat::JET_FIGHTER), has(cat::JET_BOMBER));
            if jf >= 1 && jb >= 2 {
                day.push(DayCi::CvciJfJbJb);
            }
            if jf >= 1 && jb >= 1 {
                day.push(DayCi::CvciJfJb);
            }
            if jf >= 1 && db >= 1 && tb >= 1 {
                day.push(DayCi::CvciJfBa);
            }
            if db >= 1 && tb >= 1 && fi >= 1 {
                day.push(DayCi::CvciFba);
            }
            if db >= 2 && tb >= 1 {
                day.push(DayCi::CvciBba);
            }
            if db >= 1 && tb >= 1 {
                day.push(DayCi::CvciBa);
            }
        }
        if rec > 0 && mg > 0 {
            if mg >= 2 && ap > 0 {
                day.push(DayCi::MainMain);
            }
            if sg > 0 && ap > 0 {
                day.push(DayCi::MainAp);
            }
            if sg > 0 && rad > 0 {
                day.push(DayCi::MainRadar);
            }
            if sg > 0 {
                day.push(DayCi::MainSec);
            }
            if mg >= 2 {
                day.push(DayCi::DoubleAttack);
            }
        }
        self.day_ci = day;

        let mut night = Vec::new();
        let surface_radar = self.equips().any(|(_, e)| e.has(f::SURFACE_RADAR));
        let mut torps = self.torps;
        if self.class == ShipClass::DD {
            let tslo = self.equips().any(|(_, e)| e.id == ID_TSLO);
            let drum = self.equips().any(|(_, e)| e.id == ID_DRUM);
            if mg > 0 && torps > 0 && surface_radar {
                night.push(NightCi::DdGtr);
            }
            if self.has_lookout && torps > 0 && surface_radar {
                night.push(NightCi::DdLtr);
            }
            if tslo && torps >= 2 {
                night.push(NightCi::DdTtl);
            }
            if tslo && torps > 0 && drum {
                night.push(NightCi::DdTdl);
            }
        }
        if self.has_sub_radar && self.special_sub_torps > 0 {
            torps += 1;
        }
        self.has_night_da = mg + sg >= 2;
        if mg >= 3 {
            night.push(NightCi::GunMain);
        } else if mg >= 2 && sg > 0 {
            night.push(NightCi::GunSec);
        } else if torps >= 2 {
            night.push(NightCi::Torpedo);
        } else if torps > 0 && mg > 0 {
            night.push(NightCi::Mixed);
        } else if mg + sg >= 2 {
            night.push(NightCi::DoubleAttack);
        }
        self.night_ci = night;
    }

    pub fn initial_state(&self, input: &ShipInput) -> ShipState {
        let mut planes = [0i32; MAX_SLOTS];
        let mut exp = [0.0f64; MAX_SLOTS];
        let mut damecon_slots = 0u8;
        for (i, e) in self.slots.iter().enumerate() {
            if let Some(e) = e {
                let src = if i == EX_SLOT { input.ex_slot.as_ref() } else { input.slots.get(i).and_then(|s| s.as_ref()) };
                if e.has(f::PLANE) && i != EX_SLOT {
                    planes[i] = src.and_then(|s| s.planes).unwrap_or(0).max(0);
                }
                exp[i] = e.exp;
                if self.is_player && e.has(f::DAMECON) && (e.id == ID_DAMECON_TEAM || e.id == ID_DAMECON_GODDESS) {
                    damecon_slots |= 1 << i;
                }
            }
        }
        let fuel_max = input.fuel_max.unwrap_or(100).max(1);
        let ammo_max = input.ammo_max.unwrap_or(100).max(1);
        let (fuel, ammo) = if self.is_player {
            (input.fuel.unwrap_or(fuel_max).clamp(0, fuel_max), input.ammo.unwrap_or(ammo_max).clamp(0, ammo_max))
        } else {
            (fuel_max, ammo_max)
        };
        ShipState {
            hp: input.hp.unwrap_or(input.max_hp).clamp(0, self.max_hp),
            planes,
            exp,
            fuel,
            fuel_max,
            ammo,
            ammo_max,
            morale: input.morale.unwrap_or(49).clamp(0, 100),
            protected: false,
            damecon_slots,
            damecon_used: None,
            dmg_dealt: 0,
        }
    }

    #[inline]
    pub fn equip(&self, slot: usize) -> Option<&Equip> {
        self.slots[slot].as_ref()
    }

    /// Ship has a slot with `flag` and planes > 0.
    pub fn has_planes(&self, st: &ShipState, flag: u64) -> bool {
        self.slots.iter().enumerate().any(|(i, e)| matches!(e, Some(e) if e.has(flag) && st.planes[i] > 0))
    }

    /// Proficiency effects (kcsim `updateProficiencyBonus`): (crit rate bonus %, crit damage
    /// multiplier, accuracy bonus %).
    pub fn proficiency(&self, st: &ShipState) -> (f64, f64, f64) {
        let mut crit_rate = 0.0;
        let mut crit_dmg = 1.0;
        let mut exp_sum = 0.0;
        let mut count = 0.0;
        for (i, e) in self.slots.iter().enumerate() {
            let Some(e) = e else { continue };
            if !e.has(f::ATTACK_PROF) {
                continue;
            }
            let exp = st.exp[i];
            if exp > 0.0 {
                let rank = rank_of(exp);
                let m = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 7.0, 10.0][rank as usize];
                let first = i == 0;
                crit_rate += m * if first { 0.8 } else { 0.6 };
                crit_dmg += (exp.sqrt() + m).floor() / if first { 100.0 } else { 200.0 };
                exp_sum += exp;
            }
            count += 1.0;
        }
        let mut acc = 0.0;
        if count > 0.0 {
            let avg = exp_sum / count;
            if avg >= 10.0 {
                acc = (avg * 0.1).sqrt();
            }
            acc += if avg >= 100.0 {
                9.0
            } else if avg >= 80.0 {
                6.0
            } else if avg >= 70.0 {
                4.0
            } else if avg >= 55.0 {
                3.0
            } else if avg >= 40.0 {
                2.0
            } else if avg >= 25.0 {
                1.0
            } else {
                0.0
            };
        }
        (crit_rate, crit_dmg, acc)
    }
}

fn rank_of(exp: f64) -> u32 {
    match exp {
        e if e >= 100.0 => 7,
        e if e >= 85.0 => 6,
        e if e >= 70.0 => 5,
        e if e >= 55.0 => 4,
        e if e >= 40.0 => 3,
        e if e >= 25.0 => 2,
        e if e >= 10.0 => 1,
        _ => 0,
    }
}
