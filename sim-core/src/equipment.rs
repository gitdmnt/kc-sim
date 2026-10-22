//! Equipment classification by master `api_type` and improvement / proficiency effects.
//! Ported from KC3Kai/kancolle-replay `js/kcEQDATA.js` (EQTDATA) and `js/kcships.js`
//! (`Equip.setImprovement`, `Equip.setProficiency`), MIT © fourinone41.

use crate::model::EquipmentInput;

/// `api_type[2]` categories used by the engine.
pub mod cat {
    pub const MAIN_GUN_S: u32 = 1;
    pub const MAIN_GUN_M: u32 = 2;
    pub const MAIN_GUN_L: u32 = 3;
    pub const SEC_GUN: u32 = 4;
    pub const TORPEDO: u32 = 5;
    pub const FIGHTER: u32 = 6;
    pub const DIVE_BOMBER: u32 = 7;
    pub const TORP_BOMBER: u32 = 8;
    pub const CARRIER_SCOUT: u32 = 9;
    pub const SEAPLANE: u32 = 10;
    pub const SEAPLANE_BOMBER: u32 = 11;
    pub const RADAR_S: u32 = 12;
    pub const RADAR_L: u32 = 13;
    pub const SONAR_S: u32 = 14;
    pub const DEPTH_CHARGE: u32 = 15;
    pub const ENGINE: u32 = 17;
    pub const TYPE3_SHELL: u32 = 18;
    pub const AP_SHELL: u32 = 19;
    pub const AA_GUN: u32 = 21;
    pub const MIDGET_SUB: u32 = 22;
    pub const DAMECON: u32 = 23;
    pub const LANDING_CRAFT: u32 = 24;
    pub const AUTOGYRO: u32 = 25;
    pub const ASW_PLANE: u32 = 26;
    pub const BULGE_M: u32 = 27;
    pub const BULGE_L: u32 = 28;
    pub const SEARCHLIGHT: u32 = 29;
    pub const SUB_TORPEDO: u32 = 32;
    pub const STARSHELL: u32 = 33;
    pub const FCF: u32 = 34;
    pub const AIR_PERSONNEL: u32 = 35;
    pub const AAFD: u32 = 36;
    pub const WG42: u32 = 37;
    pub const MAIN_GUN_L2: u32 = 38;
    pub const LOOKOUT: u32 = 39;
    pub const SONAR_L: u32 = 40;
    pub const FLYING_BOAT: u32 = 41;
    pub const SEARCHLIGHT_L: u32 = 42;
    pub const SEAPLANE_FIGHTER: u32 = 45;
    pub const LANDING_TANK: u32 = 46;
    pub const LAND_BOMBER: u32 = 47;
    pub const INTERCEPTOR: u32 = 48;
    pub const LAND_SCOUT: u32 = 49;
    pub const SUB_EQUIP: u32 = 51;
    pub const ARMY_UNIT: u32 = 52;
    pub const LAND_BOMBER_L: u32 = 53;
    pub const SMOKE: u32 = 54;
    pub const JET_FIGHTER: u32 = 56;
    pub const JET_BOMBER: u32 = 57;
    pub const JET_ATTACKER: u32 = 58;
    pub const JET_SCOUT: u32 = 59;
    pub const RADAR_L2: u32 = 93;
    pub const CARRIER_SCOUT2: u32 = 94;
    pub const SEC_GUN2: u32 = 95;
}

/// `api_type[3]` icon of high-angle guns.
const ICON_HA_GUN: u32 = 16;

// Master-id based rules.
pub const ID_DAMECON_TEAM: u32 = 42;
pub const ID_DAMECON_GODDESS: u32 = 43;
pub const ID_SKILLED_LOOKOUTS: u32 = 129;
pub const ID_TSLO: u32 = 412;
pub const ID_DRUM: u32 = 75;
const SAIUN_IDS: [u32; 3] = [54, 212, 273];
const NIGHT_SCOUT_IDS: [u32; 7] = [102, 469, 471, 510, 515, 538, 540];
const D_GUN_K2: u32 = 267;
const D_GUN_K3: u32 = 366;
const LATE_SUB_TORP_IDS: [u32; 8] = [213, 214, 383, 441, 443, 457, 461, 512];
const FIGHTER_BOMBER_IDS: [u32; 5] = [60, 154, 219, 447, 487];
const DC_PROJECTOR_IDS: [u32; 7] = [44, 45, 287, 288, 377, 472, 569];
const DC_ONLY_IDS: [u32; 5] = [226, 227, 378, 439, 488];
const ASW_PENETRATE_IDS: [u32; 7] = [226, 227, 377, 378, 439, 472, 488];
// Night aircraft (kcsim kcEQDATA btype B_NIGHTFIGHTER / B_NIGHTBOMBER / B_NIGHTBOMBER2 /
// B_NIGHTCREW / B_NIGHTBOMBER_DB), player and abyssal ids.
const NIGHT_FIGHTER_IDS: [u32; 8] = [254, 255, 338, 339, 473, 1581, 1617, 1650];
const NIGHT_ATTACKER_IDS: [u32; 10] = [257, 344, 345, 373, 374, 389, 545, 1583, 1619, 1652];
const NIGHT_BOMBER2_IDS: [u32; 8] = [154, 242, 243, 244, 320, 1582, 1618, 1651];
const NIGHT_CREW_IDS: [u32; 2] = [258, 259];
const NIGHT_DIVE_IDS: [u32; 3] = [552, 557, 558];
/// Suisei Model 12 (w/ Type 31 Photoelectric Fuze Bombs) counts towards night CVCI 63.
pub const ID_NIGHT_FUZE: u32 = 320;

/// Equipment flag bits.
pub mod f {
    pub const MAIN_GUN: u64 = 1 << 0;
    pub const SEC_GUN: u64 = 1 << 1;
    pub const TORPEDO: u64 = 1 << 2;
    /// Seaplane / seaplane bomber: enables artillery spotting, counts for fleet LoS.
    pub const RECON: u64 = 1 << 3;
    pub const RADAR: u64 = 1 << 4;
    pub const SURFACE_RADAR: u64 = 1 << 5;
    pub const AIR_RADAR: u64 = 1 << 6;
    pub const AP_SHELL: u64 = 1 << 7;
    pub const SONAR: u64 = 1 << 8;
    pub const SONAR_SMALL: u64 = 1 << 9;
    pub const DEPTH_CHARGE: u64 = 1 << 10;
    pub const DC_PROJECTOR: u64 = 1 << 11;
    pub const DC_ONLY: u64 = 1 << 12;
    pub const ASW_PENETRATE: u64 = 1 << 13;
    /// Takes part in fighter combat (air power + stage 1).
    pub const FIGHTER: u64 = 1 << 14;
    /// Takes part in stage 2/3 (bombing).
    pub const BOMBER: u64 = 1 << 15;
    pub const DIVE: u64 = 1 << 16;
    pub const TORP_BOMBER: u64 = 1 << 17;
    pub const JET: u64 = 1 << 18;
    pub const PLANE: u64 = 1 << 19;
    pub const CAN_CONTACT: u64 = 1 << 20;
    pub const ATTACK_PROF: u64 = 1 << 21;
    pub const ASW_PLANE: u64 = 1 << 22;
    /// Counts for ASW power (sonar, depth charge, ASW-capable aircraft).
    pub const ASW_DAMAGE: u64 = 1 << 23;
    pub const MIDGET_SUB: u64 = 1 << 24;
    pub const STARSHELL: u64 = 1 << 25;
    pub const SEARCHLIGHT_S: u64 = 1 << 26;
    pub const SEARCHLIGHT_L: u64 = 1 << 27;
    pub const LOOKOUT: u64 = 1 << 28;
    pub const NIGHT_SCOUT: u64 = 1 << 29;
    pub const NO_RED_T: u64 = 1 << 30;
    pub const SUB_RADAR: u64 = 1 << 31;
    pub const LATE_SUB_TORP: u64 = 1 << 32;
    pub const DAMECON: u64 = 1 << 33;
    pub const HA_GUN: u64 = 1 << 34;
    pub const HAFD: u64 = 1 << 35;
    pub const AAFD: u64 = 1 << 36;
    pub const AA_GUN: u64 = 1 << 37;
    pub const CONCENTRATED: u64 = 1 << 38;
    pub const TYPE3_SHELL: u64 = 1 << 39;
    pub const LARGE_GUN: u64 = 1 << 40;
    pub const FIGHTER_BOMBER: u64 = 1 << 41;
    pub const D_GUN_K2: u64 = 1 << 42;
    pub const D_GUN_K3: u64 = 1 << 43;
    pub const CARRIER_ATTACKER: u64 = 1 << 44;
    pub const AUTOGYRO_LIKE: u64 = 1 << 45;
    pub const NIGHT_FIGHTER: u64 = 1 << 46;
    pub const NIGHT_ATTACKER: u64 = 1 << 47;
    /// Night-capable plane without the per-plane +3 power (Swordfish, Suisei 12 (634/Night), …).
    pub const NIGHT_BOMBER2: u64 = 1 << 48;
    pub const NIGHT_CREW: u64 = 1 << 49;
    pub const NIGHT_DIVE: u64 = 1 << 50;
    pub const NIGHT_PLANE: u64 = NIGHT_FIGHTER | NIGHT_ATTACKER | NIGHT_BOMBER2 | NIGHT_DIVE;
}

/// Improvement (★) effects summed per ship. Field names follow kcsim's `improves` keys.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Improves {
    pub p_shell: f64,
    pub p_nb: f64,
    pub p_torp: f64,
    pub p_asw: f64,
    pub acc_shell: f64,
    pub acc_nb: f64,
    pub acc_torp: f64,
    pub acc_asw: f64,
    pub ev_shell: f64,
    pub ev_torp: f64,
    pub armor: f64,
    pub aa_self: f64,
    pub aa_fleet: f64,
}

impl Improves {
    pub fn add(&mut self, o: &Improves) {
        self.p_shell += o.p_shell;
        self.p_nb += o.p_nb;
        self.p_torp += o.p_torp;
        self.p_asw += o.p_asw;
        self.acc_shell += o.acc_shell;
        self.acc_nb += o.acc_nb;
        self.acc_torp += o.acc_torp;
        self.acc_asw += o.acc_asw;
        self.ev_shell += o.ev_shell;
        self.ev_torp += o.ev_torp;
        self.armor += o.armor;
        self.aa_self += o.aa_self;
        self.aa_fleet += o.aa_fleet;
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Equip {
    pub id: u32,
    pub cat: u32,
    pub flags: u64,
    pub fp: f64,
    pub tp: f64,
    pub aa: f64,
    pub ar: f64,
    pub ev: f64,
    pub asw: f64,
    pub los: f64,
    pub acc: f64,
    pub bomb: f64,
    pub luck: f64,
    pub range: u8,
    pub level: u32,
    /// Proficiency rank 0..7 and internal experience (kcsim mapping).
    pub rank: u32,
    pub exp: f64,
    pub imp: Improves,
    /// Fighter-power improvement bonus (added to AA).
    pub aa_improve: f64,
    /// Airstrike power improvement bonus.
    pub air_power_improve: f64,
    /// Fighter-power proficiency bonus.
    pub ap_bonus: f64,
}

impl Equip {
    #[inline]
    pub fn has(&self, flag: u64) -> bool {
        self.flags & flag != 0
    }

    pub fn from_input(input: &EquipmentInput) -> Equip {
        let c = input.types.get(2).copied().unwrap_or(0);
        let icon = input.types.get(3).copied().unwrap_or(0);
        let s = input.stats.clone().unwrap_or_default();
        let g = |v: Option<f64>| v.unwrap_or(0.0);
        let id = input.id;
        let mut e = Equip {
            id,
            cat: c,
            flags: 0,
            fp: g(s.firepower),
            tp: g(s.torpedo),
            aa: g(s.anti_air),
            ar: g(s.armor),
            ev: g(s.evasion),
            asw: g(s.asw),
            los: g(s.los),
            acc: g(s.accuracy),
            bomb: g(s.bombing),
            luck: g(s.luck),
            range: g(s.range).clamp(0.0, 5.0) as u8,
            level: input.improvement.unwrap_or(0).min(10),
            rank: 0,
            exp: 0.0,
            imp: Improves::default(),
            aa_improve: 0.0,
            air_power_improve: 0.0,
            ap_bonus: 0.0,
        };
        e.flags = classify(c, icon, id, &e);
        e.apply_improvement();
        e.set_proficiency(input.proficiency.unwrap_or(0).min(7));
        e
    }

    /// kcsim `Equip.setImprovement`.
    fn apply_improvement(&mut self) {
        let lv = self.level as f64;
        if self.level == 0 {
            return;
        }
        let sq = lv.sqrt();
        let mut imp = Improves::default();
        use cat::*;
        match self.cat {
            FIGHTER | SEAPLANE_FIGHTER | INTERCEPTOR => self.aa_improve = 0.2 * lv,
            DIVE_BOMBER | TORP_BOMBER | JET_BOMBER => {
                if self.has(f::FIGHTER_BOMBER) {
                    self.aa_improve = 0.25 * lv;
                    if self.id == 487 {
                        imp.p_asw = 0.2 * lv;
                    }
                } else {
                    imp.p_shell = 0.2 * lv;
                    imp.p_asw = 0.2 * lv;
                    self.air_power_improve = 0.2 * lv;
                }
            }
            SEAPLANE_BOMBER => self.air_power_improve = 0.2 * lv,
            AUTOGYRO => imp.p_asw = if self.asw >= 11.0 { 0.3 * lv } else { 0.2 * lv },
            ASW_PLANE => imp.p_asw = if self.asw >= 8.0 { 0.3 * lv } else { 0.2 * lv },
            LAND_BOMBER | LAND_BOMBER_L => {
                self.aa_improve = 0.5 * sq;
                self.air_power_improve = 0.7 * sq;
            }
            BULGE_M => imp.armor = 0.2 * lv,
            BULGE_L => imp.armor = 0.3 * lv,
            _ => {}
        }
        // EQTDATA[type].improve, each × sqrt(★); overrides the linear values above when present.
        let (p_shell, p_nb, p_torp, p_asw, acc_shell, acc_nb, acc_torp, acc_asw, ev_shell, ev_torp): (
            f64, f64, f64, f64, f64, f64, f64, f64, f64, f64,
        ) = match self.cat {
            MAIN_GUN_S | MAIN_GUN_M => (1.0, 1.0, 0.0, 0.0, 1.0, 1.3, 0.0, 0.0, 0.0, 0.0),
            MAIN_GUN_L | MAIN_GUN_L2 => (1.5, 1.0, 0.0, 0.0, 1.0, 1.3, 0.0, 0.0, 0.0, 0.0),
            SEC_GUN | SEC_GUN2 | AP_SHELL | TYPE3_SHELL | AAFD | SEARCHLIGHT | SEARCHLIGHT_L
            | LOOKOUT | WG42 | FCF | AIR_PERSONNEL | LANDING_CRAFT | LANDING_TANK | ARMY_UNIT
            | SMOKE => (1.0, 1.0, 0.0, 0.0, 1.0, 1.3, 0.0, 0.0, 0.0, 0.0),
            TORPEDO => (0.0, 1.0, 1.2, 0.0, 0.0, 1.3, 2.0, 0.0, 0.0, 0.0),
            MIDGET_SUB => (0.0, 1.0, 0.0, 0.0, 0.0, 1.3, 0.0, 0.0, 0.0, 0.0),
            AA_GUN => (1.0, 0.0, 1.2, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0),
            SONAR_S | SONAR_L => (0.75, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.3, 0.0, 1.5),
            DEPTH_CHARGE => (0.75, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.3, 0.0, 0.0),
            RADAR_S | RADAR_L | RADAR_L2 => (0.0, 0.0, 0.0, 0.0, 1.0, 1.3, 0.0, 0.0, 0.0, 0.0),
            ENGINE => (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.5, 0.0),
            _ => (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        };
        let has_table = p_shell + p_nb + p_torp + p_asw + acc_shell + acc_nb + acc_torp + acc_asw
            + ev_shell
            + ev_torp
            > 0.0;
        if has_table {
            let mut ps = p_shell;
            if p_shell == 1.0 && self.fp >= 13.0 {
                ps = 1.5;
            } else if p_shell == 1.5 && self.fp < 13.0 {
                ps = 1.0;
            }
            imp.p_shell = ps * sq;
            imp.p_nb = p_nb * sq;
            imp.p_torp = p_torp * sq;
            imp.p_asw = p_asw * sq;
            imp.acc_shell = acc_shell * sq;
            imp.acc_nb = acc_nb * sq;
            imp.acc_torp = acc_torp * sq;
            imp.acc_asw = acc_asw * sq;
            imp.ev_shell = ev_shell * sq;
            imp.ev_torp = ev_torp * sq;
        }
        if self.has(f::HAFD) {
            imp.aa_fleet = 3.0 * sq;
            imp.aa_self = 1.5 * sq;
        } else if self.has(f::HA_GUN) {
            imp.aa_fleet = 2.0 * sq;
            imp.aa_self = sq;
        }
        if self.has(f::AA_GUN) {
            imp.aa_self = if self.aa >= 8.0 { 3.0 } else { 2.0 } * sq;
        }
        if self.has(f::AAFD) {
            imp.aa_self = if self.aa >= 8.0 { 1.5 } else { 1.0 } * sq;
        }
        if self.cat == SEC_GUN || self.cat == SEC_GUN2 {
            if [12, 234, 247, 463, 467].contains(&self.id) {
                imp.p_shell = 0.3 * lv;
                imp.p_nb = 0.3 * lv;
            } else if ![11, 77, 130, 134, 135].contains(&self.id) {
                imp.p_shell = 0.2 * lv;
                imp.p_nb = 0.2 * lv;
            }
        }
        if self.cat == SUB_TORPEDO {
            imp.p_torp = 0.2 * lv;
            imp.p_nb = 0.2 * lv;
        }
        if self.has(f::RADAR) {
            if self.acc >= 3.0 {
                imp.acc_shell = 1.7 * sq;
                imp.acc_nb = 1.6 * sq;
            }
            if self.aa >= 2.0 {
                imp.aa_fleet = 1.5 * sq;
            }
        }
        if [226, 227, 488].contains(&self.id) {
            imp.p_shell = 0.0;
        }
        if self.cat == FLYING_BOAT && self.level >= 4 {
            self.aa_improve = 0.5;
        }
        if [486, 487].contains(&self.id) {
            self.aa_improve = 0.3 * lv;
        }
        self.imp = imp;
    }

    /// kcsim `Equip.setProficiency` (rank → internal experience, fighter-power bonus).
    pub fn set_proficiency(&mut self, rank: u32) {
        if !self.has(f::PLANE) {
            return;
        }
        const EXP: [f64; 8] = [0.0, 10.0, 25.0, 40.0, 55.0, 70.0, 85.0, 120.0];
        self.rank = rank.min(7);
        self.exp = EXP[self.rank as usize];
        let mut bonus = (self.exp * 0.1).sqrt();
        use cat::*;
        match self.cat {
            FIGHTER | SEAPLANE_FIGHTER | INTERCEPTOR | JET_FIGHTER => {
                bonus += [0.0, 0.0, 2.0, 5.0, 9.0, 14.0, 14.0, 22.0][self.rank as usize]
            }
            SEAPLANE_BOMBER => bonus += [0.0, 0.0, 1.0, 1.0, 1.0, 3.0, 3.0, 6.0][self.rank as usize],
            TORP_BOMBER | DIVE_BOMBER | JET_BOMBER => {}
            _ => bonus = 0.0,
        }
        self.ap_bonus = bonus;
    }
}

fn classify(c: u32, icon: u32, id: u32, e: &Equip) -> u64 {
    use cat::*;
    let mut fl: u64 = 0;
    match c {
        MAIN_GUN_S | MAIN_GUN_M => fl |= f::MAIN_GUN,
        MAIN_GUN_L | MAIN_GUN_L2 => fl |= f::MAIN_GUN | f::LARGE_GUN,
        SEC_GUN | SEC_GUN2 => fl |= f::SEC_GUN,
        TORPEDO | SUB_TORPEDO => fl |= f::TORPEDO,
        MIDGET_SUB => fl |= f::MIDGET_SUB,
        SEAPLANE => fl |= f::RECON | f::PLANE | f::CAN_CONTACT,
        SEAPLANE_BOMBER => {
            fl |= f::RECON
                | f::PLANE
                | f::ATTACK_PROF
                | f::BOMBER
                | f::FIGHTER
                | f::DIVE
                | f::ASW_PLANE
                | f::ASW_DAMAGE
        }
        RADAR_S | RADAR_L | RADAR_L2 => {
            fl |= f::RADAR;
            if e.los >= 5.0 {
                fl |= f::SURFACE_RADAR;
            }
            if e.aa >= 2.0 {
                fl |= f::AIR_RADAR;
            }
        }
        AP_SHELL => fl |= f::AP_SHELL,
        SONAR_S => fl |= f::SONAR | f::SONAR_SMALL | f::ASW_DAMAGE,
        SONAR_L => fl |= f::SONAR | f::ASW_DAMAGE,
        DEPTH_CHARGE => fl |= f::DEPTH_CHARGE | f::ASW_DAMAGE,
        TYPE3_SHELL => fl |= f::TYPE3_SHELL,
        AA_GUN => {
            fl |= f::AA_GUN;
            if e.aa >= 9.0 {
                fl |= f::CONCENTRATED;
            }
        }
        AAFD => fl |= f::AAFD,
        FIGHTER => fl |= f::PLANE | f::FIGHTER,
        DIVE_BOMBER => {
            fl |= f::PLANE
                | f::FIGHTER
                | f::BOMBER
                | f::DIVE
                | f::ATTACK_PROF
                | f::ASW_PLANE
                | f::ASW_DAMAGE
                | f::CARRIER_ATTACKER
        }
        TORP_BOMBER => {
            fl |= f::PLANE
                | f::FIGHTER
                | f::BOMBER
                | f::TORP_BOMBER
                | f::ATTACK_PROF
                | f::CAN_CONTACT
                | f::ASW_PLANE
                | f::ASW_DAMAGE
                | f::CARRIER_ATTACKER
        }
        CARRIER_SCOUT | CARRIER_SCOUT2 => fl |= f::PLANE | f::CAN_CONTACT,
        AUTOGYRO | ASW_PLANE => {
            fl |= f::PLANE | f::FIGHTER | f::ASW_PLANE | f::ASW_DAMAGE | f::AUTOGYRO_LIKE
        }
        FLYING_BOAT => fl |= f::PLANE | f::ATTACK_PROF | f::CAN_CONTACT | f::ASW_PLANE,
        SEAPLANE_FIGHTER => fl |= f::PLANE | f::FIGHTER,
        LAND_BOMBER | LAND_BOMBER_L => fl |= f::PLANE | f::ATTACK_PROF | f::DIVE | f::TORP_BOMBER,
        INTERCEPTOR => fl |= f::PLANE,
        LAND_SCOUT => fl |= f::PLANE | f::CAN_CONTACT,
        JET_FIGHTER => fl |= f::PLANE | f::FIGHTER | f::JET,
        JET_BOMBER => {
            fl |= f::PLANE | f::FIGHTER | f::BOMBER | f::DIVE | f::JET | f::ATTACK_PROF | f::CARRIER_ATTACKER
        }
        JET_ATTACKER | JET_SCOUT => fl |= f::PLANE | f::JET,
        SEARCHLIGHT => fl |= f::SEARCHLIGHT_S,
        SEARCHLIGHT_L => fl |= f::SEARCHLIGHT_L,
        STARSHELL => fl |= f::STARSHELL,
        LOOKOUT => fl |= f::LOOKOUT,
        DAMECON => fl |= f::DAMECON,
        SUB_EQUIP => fl |= f::SUB_RADAR,
        _ => {}
    }
    if icon == ICON_HA_GUN {
        fl |= f::HA_GUN;
        if e.aa >= 8.0 {
            fl |= f::HAFD;
        }
    }
    if SAIUN_IDS.contains(&id) {
        fl |= f::NO_RED_T;
    }
    if NIGHT_SCOUT_IDS.contains(&id) {
        fl |= f::NIGHT_SCOUT;
    }
    if LATE_SUB_TORP_IDS.contains(&id) {
        fl |= f::LATE_SUB_TORP;
    }
    if FIGHTER_BOMBER_IDS.contains(&id) {
        fl |= f::FIGHTER_BOMBER;
    }
    if DC_PROJECTOR_IDS.contains(&id) {
        fl |= f::DC_PROJECTOR;
    }
    if DC_ONLY_IDS.contains(&id) {
        fl |= f::DC_ONLY;
    }
    if ASW_PENETRATE_IDS.contains(&id) {
        fl |= f::ASW_PENETRATE;
    }
    if id == D_GUN_K2 {
        fl |= f::D_GUN_K2;
    }
    if id == D_GUN_K3 {
        fl |= f::D_GUN_K3;
    }
    if NIGHT_FIGHTER_IDS.contains(&id) {
        fl |= f::NIGHT_FIGHTER;
    }
    if NIGHT_ATTACKER_IDS.contains(&id) {
        fl |= f::NIGHT_ATTACKER;
    }
    if NIGHT_BOMBER2_IDS.contains(&id) {
        fl |= f::NIGHT_BOMBER2;
    }
    if NIGHT_CREW_IDS.contains(&id) {
        fl |= f::NIGHT_CREW;
    }
    if NIGHT_DIVE_IDS.contains(&id) {
        fl |= f::NIGHT_DIVE;
    }
    fl
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::EquipmentStats;

    fn eq(id: u32, c: u32, icon: u32, stats: EquipmentStats, lv: u32) -> Equip {
        Equip::from_input(&EquipmentInput {
            id,
            types: vec![0, 0, c, icon, 0],
            stats: Some(stats),
            improvement: Some(lv),
            proficiency: None,
            planes: None,
        })
    }

    #[test]
    fn classification_and_improvement() {
        // 41cm twin gun ★4: large main gun, Pshell 1.5*sqrt(4)=3 (FP 20 >= 13)
        let g = eq(8, cat::MAIN_GUN_L, 3, EquipmentStats { firepower: Some(20.0), ..Default::default() }, 4);
        assert!(g.has(f::MAIN_GUN) && g.has(f::LARGE_GUN));
        assert!((g.imp.p_shell - 3.0).abs() < 1e-9);
        assert!((g.imp.acc_shell - 2.0).abs() < 1e-9);
        // 12.7cm HA ★9 (icon 16, AA 7 -> HA without FD): AAfleet 2*3, AAself 3
        let h = eq(10, cat::MAIN_GUN_S, 16, EquipmentStats { anti_air: Some(7.0), ..Default::default() }, 9);
        assert!(h.has(f::HA_GUN) && !h.has(f::HAFD));
        assert!((h.imp.aa_fleet - 6.0).abs() < 1e-9 && (h.imp.aa_self - 3.0).abs() < 1e-9);
        // Type 22 radar with ACC 3: surface radar, acc_shell 1.7*sqrt(lv)
        let r = eq(28, cat::RADAR_S, 11, EquipmentStats { los: Some(5.0), accuracy: Some(3.0), ..Default::default() }, 4);
        assert!(r.has(f::SURFACE_RADAR) && !r.has(f::AIR_RADAR));
        assert!((r.imp.acc_shell - 3.4).abs() < 1e-9);
        // secondary gun: linear 0.2*lv
        let s = eq(66, cat::SEC_GUN, 4, EquipmentStats::default(), 10);
        assert!((s.imp.p_shell - 2.0).abs() < 1e-9);
    }

    #[test]
    fn proficiency_bonus() {
        let mut fi = eq(21, cat::FIGHTER, 6, EquipmentStats { anti_air: Some(6.0), ..Default::default() }, 0);
        fi.set_proficiency(7);
        assert!((fi.ap_bonus - (12.0f64.sqrt() + 22.0)).abs() < 1e-9);
        let mut tb = eq(18, cat::TORP_BOMBER, 8, EquipmentStats::default(), 0);
        tb.set_proficiency(7);
        assert!((tb.ap_bonus - 12.0f64.sqrt()).abs() < 1e-9);
        assert_eq!(tb.exp, 120.0);
    }
}
