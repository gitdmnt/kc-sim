//! Installation (陸上型), special-target and PT imp (PT小鬼群) damage / accuracy modifiers of an
//! attacker, from its equipment. Ported from KC3Kai/kancolle-replay `js/kcships.js`
//! (`Ship.loadEquips`: `installeqs`, `softSkinMult`, `pillboxMult`, `isoMult`, `harbourSummerMult`,
//! `northernMult`, `supplyPostMult`, `installFlat`, `summer*PostMult`, `frenchBBPostMult`,
//! `euroWPPostMult`, `anchoragePostMult`, `dockPostMult`, `ptDmgMod`, `ptAccMod`; `shellPower` /
//! `NBPower`) and `js/kcsim.js` (`shell`, `NBattack`, `airstrike`), MIT © fourinone41. Only the
//! current mechanics (`MECHANICS.installRevamp`, `panzerIIIBuff`) are ported.
//!
//! The target's kind (`ShipInput.installationKind`, `ptImp`, `supplyDepot`, `targetGroup`,
//! `divebombWeak`) comes from the input (kcSHIPDATA flags via the adapter).

use crate::equipment::{cat, Equip};
use crate::model::{InstallationKind, ShipInput, TargetGroup};
use crate::ship::ShipClass;

/// Player ships that prefer PT targets and give adjacent destroyers PT accuracy (kcSHIPDATA
/// `isAntiPTShip`: 天霧改二 / 改二丁).
pub fn is_anti_pt_ship(id: u32) -> bool {
    id == 903 || id == 908
}

/// Player ships that prefer installation targets (kcSHIPDATA `isAntiInstall`: 第百一号輸送艦 / 改).
pub fn is_anti_install(id: u32) -> bool {
    id == 727 || id == 945
}

/// Dive bombers that can attack installations (kcEQDATA `canShellInstall`).
const SHELL_INSTALL_IDS: [u32; 14] = [64, 148, 233, 277, 305, 306, 319, 320, 391, 392, 420, 421, 474, 578];

pub fn can_shell_install(equip_id: u32) -> bool {
    SHELL_INSTALL_IDS.contains(&equip_id)
}

/// Skip bombers (反跳爆撃, kcEQDATA `isSkipBomber`): B-25 and abyssal assault planes.
const SKIP_BOMBER_IDS: [u32; 6] = [459, 1625, 1626, 1634, 1635, 1636];

/// kcsim `airstrike` (`enableSkipTorpBonus`): pre-cap multiplier of a skip bomber against `def`.
pub fn skip_bomber_mod(equip_id: u32, def_class: ShipClass, def_installation: bool) -> f64 {
    if !SKIP_BOMBER_IDS.contains(&equip_id) {
        return 1.0;
    }
    if def_installation {
        return 0.9;
    }
    use ShipClass::*;
    match def_class {
        DD => 1.9,
        CL | CLT | AV => 1.75,
        CA | CAV => 1.6,
        CVL | FBB | BB | BBV | CV | CVB | AP => 1.3,
        _ => 1.0,
    }
}

/// What a ship is as a target (from `ShipInput`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TargetTraits {
    /// Installation kind (`Some` ⇔ `ShipCore::is_installation`).
    pub kind: Option<InstallationKind>,
    /// Takes the supply-depot post-cap bonus (supply depot installations, kcSHIPDATA `isSupplyDepot`).
    pub supply_depot: bool,
    /// PT imp group.
    pub pt: bool,
    /// Dive-bomber airstrike multiplier (kcSHIPDATA `divebombWeak`, 1 = none).
    pub divebomb_weak: f64,
    /// Land-based airstrike pre-cap multiplier (kcSHIPDATA `LBWeak`, 1 = none).
    pub lb_weak: f64,
    pub group: Option<TargetGroup>,
}

impl Default for TargetTraits {
    fn default() -> Self {
        TargetTraits { kind: None, supply_depot: false, pt: false, divebomb_weak: 1.0, lb_weak: 1.0, group: None }
    }
}

/// A ship's modifiers as an attacker against installations, special targets and PT imps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VsMods {
    pub inst: InstallMods,
    /// (damage, accuracy) multipliers against PT imps (kcsim `ptDmgMod`, `ptAccMod`).
    pub pt_dmg: f64,
    pub pt_acc: f64,
    /// Flat accuracy against PT imps and PT targeting preference (kcships `Fleet.loadShips`
    /// `isAntiPTShip`: +64 for 天霧改二, +32 for the adjacent destroyers; set per fleet).
    pub pt_acc_flat: f64,
    pub anti_pt: bool,
    /// Prefers installation targets (kcSHIPDATA `isAntiInstall`).
    pub anti_install: bool,
    /// Submarine that shells installations (WG42 or an amphibious tank, kcships `SS.canShell`).
    pub sub_shell: bool,
    /// Abyssal BBV-type installation: shells with the carrier formula and needs bombers (kcships `BBV`).
    pub cv_shell: bool,
    /// Carries a barrage balloon (kcEQDATA `isBalloon`).
    pub balloon: bool,
}

impl Default for VsMods {
    fn default() -> Self {
        VsMods {
            inst: InstallMods::default(),
            pt_dmg: 1.0,
            pt_acc: 1.0,
            pt_acc_flat: 0.0,
            anti_pt: false,
            anti_install: false,
            sub_shell: false,
            cv_shell: false,
            balloon: false,
        }
    }
}

/// Barrage balloon equipment (player 513, abyssal 1640).
pub const BALLOON_IDS: [u32; 2] = [513, 1640];
/// Smoke generator (発煙装置) / Kai.
pub const ID_SMOKE: u32 = 500;
pub const ID_SMOKE_KAI: u32 = 501;

/// Traits and attacker modifiers of one ship (kcships `Ship.loadEquips` / `Fleet.loadShips`).
pub fn derive<'a>(input: &ShipInput, is_player: bool, class: ShipClass, equips: impl Iterator<Item = &'a Equip> + Clone) -> (TargetTraits, VsMods) {
    let id = input.id.unwrap_or(0);
    let kind = match input.is_installation {
        Some(false) => None,
        Some(true) => Some(input.installation_kind.unwrap_or(InstallationKind::SoftSkinned)),
        None => input.installation_kind,
    };
    let target = TargetTraits {
        kind,
        supply_depot: kind == Some(InstallationKind::SupplyDepot) || input.supply_depot.unwrap_or(false),
        pt: input.pt_imp.unwrap_or(false),
        divebomb_weak: input.divebomb_weak.unwrap_or(1.0),
        lb_weak: input.lb_weak.unwrap_or(1.0),
        group: input.target_group,
    };
    let it = || equips.clone();
    let (pt_dmg, pt_acc) = pt_mods(it(), class);
    let anti_pt = is_player && is_anti_pt_ship(id);
    let vs = VsMods {
        inst: InstallMods::derive(it(), class, id, input.ship_class.unwrap_or(0)),
        pt_dmg,
        pt_acc,
        pt_acc_flat: if anti_pt { 64.0 } else { 0.0 },
        anti_pt,
        anti_install: is_player && is_anti_install(id),
        sub_shell: class.is_sub() && it().any(|e| e.id == 126 || (e.cat == cat::LANDING_TANK && e.id != 525 && e.id != 526)),
        cv_shell: !is_player && class == ShipClass::BBV && kind.is_some(),
        balloon: it().any(|e| BALLOON_IDS.contains(&e.id)),
    };
    (target, vs)
}

/// kcships `Fleet.loadShips`: an anti-PT ship gives the adjacent destroyers / escorts +32 PT
/// accuracy and the PT targeting preference.
pub fn spread_anti_pt(ships: &mut [crate::ship::ShipCore]) {
    for i in 0..ships.len() {
        if !(ships[i].is_player && is_anti_pt_ship(ships[i].master_id)) {
            continue;
        }
        for j in [i.wrapping_sub(1), i + 1] {
            if let Some(s) = ships.get_mut(j) {
                if matches!(s.class, ShipClass::DD | ShipClass::DE) && !s.vs.anti_pt {
                    s.vs.anti_pt = true;
                    s.vs.pt_acc_flat = 32.0;
                }
            }
        }
    }
}

/// Post-cap airstrike bonus against a target (kcsim `airstrike`, `enableAirstrikeSpecialBonus`):
/// `(p, high, low)` = × `high` with probability `p`, else × `low`; a fixed multiplier has `p = 1`.
/// `divebomb_weak` is the target's dive-bomber multiplier (used when no special bonus applies).
pub fn airstrike_target_mod(target_id: u32, pt: bool, supply_depot: bool, dive: bool, divebomb_weak: f64) -> (f64, f64, f64) {
    match target_id {
        1557 => (0.4, 2.0, 1.4),
        1586 | 1620 | 1781 | 1782 | 2105..=2108 => (0.4, 2.2, 1.7),
        _ if pt => (0.4, 0.8, 0.5),
        _ if supply_depot => (0.5, 2.4, 1.5),
        1665..=1667 => (0.4, 1.7, 1.3),
        1696..=1698 => (0.4, 1.8, 1.3),
        1699..=1704 | 2023..=2028 | 2243..=2246 => (0.4, 1.4, 1.2),
        1708..=1710 => (0.4, 1.3, 1.0),
        1751 => (0.4, 1.6, 1.3),
        1755..=1760 => (0.4, 1.2, 0.9),
        2178 | 2179 | 2196 | 2197 => (0.4, 1.6, 1.4),
        2188..=2191 => (0.4, 1.9, 1.5),
        _ => {
            let m = if dive { divebomb_weak } else { 1.0 };
            (1.0, m, m)
        }
    }
}

/// An attacker's multipliers against installations and special targets (kcsim `installRevamp`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InstallMods {
    pub soft: f64,
    pub soft_day: f64,
    pub pillbox: f64,
    pub pillbox_day: f64,
    pub iso: f64,
    pub iso_day: f64,
    pub harbour: f64,
    pub harbour_day: f64,
    pub northern: f64,
    /// Post-cap multiplier against supply depots.
    pub supply_post: f64,
    /// Flat pre-cap bonus against installations (`installFlat`).
    pub flat: f64,
    /// Post-cap multipliers against the special target groups.
    pub summer_bb: f64,
    pub summer_ca: f64,
    pub summer_cv: f64,
    pub french_bb: f64,
    pub euro_wp: f64,
    pub anchorage: f64,
    pub dock: f64,
}

impl Default for InstallMods {
    fn default() -> Self {
        InstallMods {
            soft: 1.0,
            soft_day: 1.0,
            pillbox: 1.0,
            pillbox_day: 1.0,
            iso: 1.0,
            iso_day: 1.0,
            harbour: 1.0,
            harbour_day: 1.0,
            northern: 1.0,
            supply_post: 1.0,
            flat: 0.0,
            summer_bb: 1.0,
            summer_ca: 1.0,
            summer_cv: 1.0,
            french_bb: 1.0,
            euro_wp: 1.0,
            anchorage: 1.0,
            dock: 1.0,
        }
    }
}

/// kcsim `WGpower`: flat bonus by number of WG42.
fn wg_power(n: u32) -> f64 {
    match n {
        0 => 0.0,
        1 => 75.0,
        2 => 110.0,
        3 => 140.0,
        _ => 160.0,
    }
}

/// Flat bonus of mortars / anti-ground rockets by count (`installFlat` steps for 1, 2, 3, ≥4).
fn steps(n: i32, t: [f64; 4]) -> f64 {
    match n {
        n if n <= 0 => 0.0,
        n => t[(n.min(4) - 1) as usize],
    }
}

/// 特大発動艇+一式砲戦車 etc.: landing craft that count as `DH2` (kcEQDATA `btype: B_LC2`).
const LC2_IDS: [u32; 3] = [166, 449, 514];
/// Ships whose post-cap multiplier against summer / European princesses is ×1.1 / ×1.15
/// (kcships: Bismarck-class, Prinz Eugen, … master ids).
const EURO_SHIPS: [u32; 13] = [171, 172, 173, 176, 177, 178, 393, 515, 571, 574, 576, 579, 630];
/// Ships ×1.2 against 泊地水鬼 バカンスmode (kcships `anchoragePostMult`: Nagato-class, Yamato-class, …).
const ANCHORAGE_SHIPS: [u32; 13] = [80, 81, 131, 136, 143, 148, 275, 276, 541, 546, 573, 911, 916];
/// Ship classes ×1.15 against 戦艦仏棲姫 (Richelieu-class, …) and ×1.1 against 船渠棲姫.
const FRENCH_BB_CLASSES: [u32; 4] = [70, 79, 128, 129];
const DOCK_CLASSES: [u32; 7] = [58, 61, 64, 68, 80, 92, 113];

impl InstallMods {
    /// kcsim `Ship.loadEquips` installation part. `master_id` / `ctype`: the attacker's master id
    /// and ship class (api_ctype) for the ship-specific special-target bonuses.
    pub fn derive<'a>(equips: impl Iterator<Item = &'a Equip> + Clone, class: ShipClass, master_id: u32, ctype: u32) -> InstallMods {
        #[derive(Default)]
        struct C {
            dh1: i32,
            dh2: i32,
            dh3: i32,
            dh1_stars: f64,
            dh3_stars: f64,
            ap: i32,
            t3: i32,
            sb: i32,
            db: i32,
            jet_db: i32,
            tdh11: i32,
            tdh: i32,
            mortar: i32,
            mortar_c: i32,
            rocket4: i32,
            rocket4_c: i32,
            m4a1: i32,
            soukoutei: i32,
            armed_daihatsu: i32,
            panzer: i32,
            toku_t1: i32,
            panzer3: i32,
            panzer3j: i32,
            chiha: i32,
            chiha_kai: i32,
            t4: i32,
            t4_stars: f64,
            t4k: i32,
            r35: i32,
            wg: u32,
            army: i32,
            army_496: i32,
            army_497: i32,
            army_498: i32,
            army_499: i32,
            tank: i32,
            swordfish: i32,
            seaplane_bomber: i32,
            dive_bomber: i32,
            id194: i32,
        }
        let mut c = C::default();
        for e in equips.clone() {
            let lv = e.level as f64;
            match e.cat {
                cat::LANDING_CRAFT if LC2_IDS.contains(&e.id) => {
                    c.dh2 += 1;
                    c.dh1_stars += lv;
                }
                cat::LANDING_CRAFT => {
                    c.dh1 += 1;
                    c.dh1_stars += lv;
                }
                // 特四式内火艇 (525/526) have no btype in kcEQDATA: not DH3.
                cat::LANDING_TANK if e.id != 525 && e.id != 526 => {
                    c.dh3 += 1;
                    c.dh3_stars += lv;
                }
                cat::AP_SHELL => c.ap += 1,
                cat::TYPE3_SHELL => c.t3 += 1,
                cat::SEAPLANE_BOMBER | cat::SEAPLANE_FIGHTER => c.sb += 1,
                cat::DIVE_BOMBER | cat::JET_BOMBER => c.db += 1,
                _ => {}
            }
            match e.cat {
                cat::LANDING_TANK => c.tank += 1,
                cat::SEAPLANE_BOMBER => c.seaplane_bomber += 1,
                cat::SEAPLANE_FIGHTER => c.seaplane_bomber += 1,
                cat::DIVE_BOMBER => c.dive_bomber += 1,
                cat::JET_BOMBER => c.jet_db += 1,
                _ => {}
            }
            match e.id {
                230 => c.tdh11 += 1,
                193 => c.tdh += 1,
                346 => c.mortar += 1,
                347 => c.mortar_c += 1,
                348 => c.rocket4 += 1,
                349 => c.rocket4_c += 1,
                355 => c.m4a1 += 1,
                408 => c.soukoutei += 1,
                409 => c.armed_daihatsu += 1,
                436 => c.panzer += 1,
                449 => c.toku_t1 += 1,
                482 => {
                    c.panzer3 += 1;
                    // MECHANICS.panzerIIIBuff: counts as a DH2 and a Toku Daihatsu.
                    c.dh1 -= 1;
                    c.dh2 += 1;
                    c.tdh += 1;
                }
                514 => {
                    c.tdh += 1;
                    c.panzer3 += 1;
                    c.panzer3j += 1;
                }
                494 => c.chiha += 1,
                495 => c.chiha_kai += 1,
                525 | 526 => {
                    c.t4 += 1;
                    c.t4_stars += lv;
                    if e.id == 526 {
                        c.t4k += 1;
                    }
                }
                576 => c.r35 += 1,
                126 => c.wg += 1,
                242..=244 => c.swordfish += 1,
                194 => c.id194 += 1,
                _ => {}
            }
            if e.cat == cat::ARMY_UNIT {
                c.army += 1;
                match e.id {
                    496 => c.army_496 += 1,
                    497 => c.army_497 += 1,
                    498 => c.army_498 += 1,
                    499 => c.army_499 += 1,
                    _ => {}
                }
            }
        }

        // Improvement bonus of landing craft / type 4 tanks (×(1 + ★avg/50)) and of amphibious
        // tanks (×(1 + ★avg/30)).
        let mut bonus1 = 1.0;
        if c.dh1 + c.dh2 > 0 {
            bonus1 += c.dh1_stars / (c.dh1 + c.dh2) as f64 / 50.0;
        }
        if c.t4 > 0 {
            bonus1 += c.t4_stars / c.t4 as f64 / 50.0;
        }
        let mut bonus3 = 1.0;
        if c.dh3 > 0 {
            bonus3 += c.dh3_stars / c.dh3 as f64 / 30.0;
        }

        // `installModAll` (applied to every table) and `installFlat`: each step multiplies both
        // and then adds to the flat bonus.
        let mut all = 1.0;
        let mut flat = 0.0;
        let step = |all: &mut f64, flat: &mut f64, m: f64, add: f64| {
            *all *= m;
            *flat = *flat * m + add;
        };
        if c.tdh11 > 0 || c.toku_t1 > 0 || c.panzer3 > 0 {
            step(&mut all, &mut flat, 1.8, 25.0);
        }
        if c.m4a1 > 0 {
            step(&mut all, &mut flat, 1.4, 35.0);
        }
        if c.toku_t1 > 0 {
            step(&mut all, &mut flat, 1.3, 42.0);
        }
        if c.chiha > 0 {
            step(&mut all, &mut flat, 1.4, 28.0);
        }
        if c.chiha_kai > 0 {
            step(&mut all, &mut flat, 1.5, 33.0);
        }
        if c.army_496 > 0 || c.army_499 > 0 {
            step(&mut all, &mut flat, 1.2, 60.0);
        }
        if c.army_497 > 0 || c.army_498 > 0 {
            step(&mut all, &mut flat, 1.5, 70.0);
        }
        if c.army_498 > 0 {
            step(&mut all, &mut flat, 1.5, 50.0);
        }
        if c.army_499 > 0 {
            step(&mut all, &mut flat, 1.6, 70.0);
        }
        if c.army >= 2 {
            step(&mut all, &mut flat, 2.0, 100.0);
            if c.army_499 > 0 || c.army + c.tank >= 3 {
                step(&mut all, &mut flat, 3.0, 150.0);
            }
            if c.t4 > 0 {
                flat += 100.0;
            }
            if c.t4k > 0 {
                flat += 72.0;
            }
        }
        if c.t4 > 0 {
            step(&mut all, &mut flat, 1.2, 42.0);
        }
        if c.t4k > 0 {
            step(&mut all, &mut flat, 1.1, 28.0);
        }
        if c.panzer > 0 {
            step(&mut all, &mut flat, 1.15, 15.0);
        }
        if c.r35 > 0 {
            step(&mut all, &mut flat, 1.2, 20.0);
        }
        // Armored boat (装甲艇) / armed daihatsu (武装大発) synergy with other landing craft.
        let num_ab = c.soukoutei + c.armed_daihatsu;
        let (mut ab_mult, mut ab_flat) = (1.0, 0.0);
        if (c.soukoutei == 1 || c.armed_daihatsu == 1) && c.soukoutei < 2 && c.armed_daihatsu < 2 {
            let num_a = equips.clone().filter(|e| [68, 166, 193, 436, 449, 514, 525, 526, 576].contains(&e.id)).count();
            let num_b = equips.clone().filter(|e| [167, 230, 482, 494, 495, 514].contains(&e.id)).count();
            if c.soukoutei == 1 && c.armed_daihatsu == 1 {
                if num_a + num_b >= 2 {
                    (ab_mult, ab_flat) = (1.5, 25.0);
                } else if num_b > 0 {
                    (ab_mult, ab_flat) = (1.4, 20.0);
                } else if num_a > 0 {
                    (ab_mult, ab_flat) = (1.3, 15.0);
                }
            } else if num_a + num_b > 0 {
                (ab_mult, ab_flat) = (1.2, 10.0);
            }
        }
        step(&mut all, &mut flat, ab_mult, ab_flat);

        flat += wg_power(c.wg);
        flat += steps(c.mortar_c, [60.0, 110.0, 150.0, 180.0]);
        flat += steps(c.mortar, [30.0, 55.0, 75.0, 90.0]);
        flat += steps(c.rocket4, [55.0, 115.0, 160.0, 190.0]);
        flat += steps(c.rocket4_c, [80.0, 170.0, 230.0, 260.0]);

        let has_lc = c.dh1 > 0 || c.dh2 > 0 || c.t4 > 0 || c.army > 0;
        let n_mortar = c.mortar + c.mortar_c;
        let n_rocket = c.rocket4 + c.rocket4_c;
        let wg = c.wg;
        // Army units count as landing-craft tanks from here on.
        let tdh = c.tdh + c.army_496 + c.army_499;
        let dh2 = c.dh2 + c.army_496 + c.army_499;
        let panzer3 = c.panzer3 + c.army_496 + c.army_499;
        let panzer3j = c.panzer3j + c.army_499;
        let chiha = c.chiha + c.army_497;
        let chiha_kai = c.chiha_kai + c.army_498;
        let tanks_m4 = c.m4a1 + chiha_kai + panzer3j > 0;
        let dh2_group = dh2 + chiha + chiha_kai >= 2;
        let dh3_more = c.dh3 >= 2 || c.t4k > 0;
        // `xxxMultDay` exists only with an armored boat / armed daihatsu.
        let day = |first: f64, more: f64| {
            if num_ab > 0 {
                first * if num_ab >= 2 || c.t4 >= 2 { more } else { 1.0 }
            } else {
                1.0
            }
        };
        let k = |cond: bool, m: f64| if cond { m } else { 1.0 };

        let mut soft = k(c.t3 > 0, 2.5);
        soft *= k(wg > 0, 1.3) * k(wg >= 2, 1.4);
        soft *= k(n_mortar > 0, 1.2) * k(n_mortar >= 2, 1.3);
        soft *= k(n_rocket > 0, 1.25) * k(n_rocket >= 2, 1.5);
        soft *= k(has_lc, 1.4) * k(tdh > 0, 1.15) * k(tanks_m4, 1.1);
        soft *= k(c.panzer > 0, 1.5) * k(c.r35 > 0, 1.5) * k(dh2 > 0, 1.5) * k(dh2_group, 1.3);
        soft *= k(bonus1 > 1.0, bonus1);
        soft *= k(c.dh3 > 0, 1.5 * bonus3) * k(dh3_more, 1.2);
        soft *= k(c.sb > 0, 1.2);
        soft *= all;
        soft *= k(c.army > 0, 1.4) * k(c.army >= 2, 1.2) * k(c.army >= 3, 1.1);

        let mut pillbox = k(matches!(class, ShipClass::DD | ShipClass::CL), 1.4);
        pillbox *= k(wg >= 2, 2.72) * k(wg == 1, 1.6);
        pillbox *= k(n_mortar > 0, 1.3) * k(n_mortar >= 2, 1.5);
        pillbox *= k(n_rocket > 0, 1.5) * k(n_rocket >= 2, 1.8);
        pillbox *= k(has_lc, 1.8) * k(tdh > 0, 1.15) * k(tanks_m4, 2.0);
        pillbox *= k(c.panzer > 0, 1.5) * k(c.r35 > 0, 1.5) * k(dh2 > 0, 1.5) * k(dh2_group, 1.4);
        pillbox *= k(bonus1 > 1.0, bonus1);
        pillbox *= k(c.dh3 > 0, 2.4 * bonus3) * k(dh3_more, 1.35);
        pillbox *= k(c.db >= 2, 2.0);
        pillbox *= all;
        pillbox *= k(c.ap > 0, 1.85) * k(c.sb > 0, 1.5) * k(c.db > 0, 1.5);

        let mut iso = k(wg >= 2, 2.1) * k(wg == 1, 1.4);
        iso *= k(n_mortar > 0, 1.2) * k(n_mortar >= 2, 1.4);
        iso *= k(n_rocket > 0, 1.3) * k(n_rocket >= 2, 1.65);
        iso *= k(has_lc, 1.8) * k(tdh > 0, 1.15) * k(tanks_m4, 1.8);
        iso *= k(c.panzer > 0, 1.2) * k(c.r35 > 0, 1.2) * k(dh2 > 0, 1.2) * k(dh2_group, 1.4);
        iso *= k(bonus1 > 1.0, bonus1);
        iso *= k(c.dh3 > 0, 2.4 * bonus3) * k(dh3_more, 1.35);
        iso *= k(c.db >= 2, 1.75);
        iso *= all;
        iso *= k(c.t3 > 0, 1.75) * k(c.db > 0, 1.4);

        let mut harbour = k(wg > 0, 1.4) * k(wg >= 2, 1.2);
        // kcsim applies both rocket factors from one launcher (`numRocket4` tested twice).
        harbour *= k(n_rocket > 0, 1.25) * k(n_rocket > 0, 1.4);
        harbour *= k(n_mortar > 0, 1.1) * k(n_mortar >= 2, 1.15);
        harbour *= k(has_lc, 1.7) * k(tdh > 0, 1.2) * k(tanks_m4, 2.0);
        harbour *= k(c.panzer > 0, 1.6) * k(c.r35 > 0, 1.6) * k(dh2 > 0, 1.6) * k(dh2_group, 1.5);
        harbour *= k(bonus1 > 1.0, bonus1);
        harbour *= k(c.dh3 > 0, 2.8 * bonus3) * k(dh3_more, 1.5);
        harbour *= k(c.t3 > 0, 1.75) * k(c.ap > 0, 1.3) * k(c.db > 0, 1.3) * k(c.db >= 2, 1.25) * k(c.sb > 0, 1.3);
        harbour *= all;

        let mut northern = k(wg >= 2, 2.1) * k(wg == 1, 1.4);
        northern *= k(tdh > 0, 1.8) * k(c.tdh11 > 0, 2.2) * k(c.t3 > 0, 1.75);

        let mut supply = k(wg > 0, 1.25) * k(wg >= 2, 1.3);
        supply *= k(n_rocket > 0, 1.2) * k(n_rocket >= 2, 1.4);
        supply *= k(n_mortar > 0, 1.15) * k(n_mortar >= 2, 1.2);
        supply *= k(has_lc, 1.7 * bonus1) * k(tdh > 0, 1.2) * k(dh2 > 0, 1.3 * bonus1) * k(dh2_group, 1.6);
        supply *= k(tanks_m4, 1.2) * k(c.panzer > 0, 1.3 * bonus1) * k(c.r35 > 0, 1.3 * bonus1);
        supply *= k(c.dh3 > 0, 1.7 * bonus3) * k(dh3_more, 1.5);
        supply *= k(num_ab > 0, 1.5) * k(num_ab >= 2 || c.t4 >= 2, 1.1);
        supply *= k(c.army > 0, 1.85) * k(c.army >= 2, 1.45) * k(c.army >= 3, 1.2);

        let euro = EURO_SHIPS.contains(&master_id);
        let sw = c.swordfish;
        let sp = c.seaplane_bomber > 0;
        let summer_bb = k(c.ap > 0, 1.2) * k(sp, 1.1) * k(sw > 0, 1.15) * k(sw >= 2, 1.05) * k(euro, 1.1);
        let summer_ca = k(c.ap > 0, 1.1) * k(sp, 1.15) * k(sw > 0, 1.15) * k(sw >= 2, 1.05) * k(euro, 1.1);
        let summer_cv = k(c.ap > 0, 1.1) * k(sp, 1.1) * k(c.dive_bomber > 0, 1.1) * k(c.dive_bomber >= 2, 1.1) * k(sw > 0, 1.1) * k(sw >= 2, 1.2) * k(euro, 1.1);
        let french_bb = k(c.ap > 0, 1.2) * k(sp, 1.1) * k(c.id194 > 0, 1.2) * k(c.dive_bomber > 0, 1.1) * k(c.dive_bomber >= 2, 1.15)
            * k(FRENCH_BB_CLASSES.contains(&ctype), 1.15);
        let euro_wp = k(c.ap > 0, 1.15) * k(sp, 1.1) * k(sw > 0, 1.2) * k(sw >= 2, 1.2) * k(euro, 1.15);

        let mut anchorage = k(n_mortar > 0, 1.1) * k(n_rocket > 0, 1.15) * k(n_rocket >= 2, 1.4);
        anchorage *= k(wg > 0, 1.2) * k(wg >= 2, 1.3);
        anchorage *= k(has_lc, 1.4 * bonus1) * k(tdh > 0, 1.15) * k(dh2 > 0, 1.2) * k(dh2_group, 1.4);
        anchorage *= k(c.dh3 > 0, 2.4 * bonus3) * k(dh3_more, 1.35);
        anchorage *= k(tanks_m4, 1.8) * k(c.panzer > 0, 1.2) * k(c.r35 > 0, 1.2) * k(c.t3 > 0, 1.45);
        anchorage *= k(c.db > 0, 1.4) * k(c.db >= 2 || c.jet_db > 0, 1.75);
        anchorage *= k(num_ab > 0, 1.2) * k(num_ab >= 2 || c.t4 >= 2, 1.1);
        anchorage *= k(ANCHORAGE_SHIPS.contains(&master_id), 1.2);

        let mut dock = k(c.db > 0, 1.1) * k(c.db >= 2, 1.1) * k(c.sb > 0, 1.1);
        dock *= k(wg > 0, 1.1) * k(wg >= 2, 1.2) * k(c.t3 > 0, 1.3);
        dock *= k(c.dh3 > 0, 1.2 * bonus3) * k(dh3_more, 1.2) * k(has_lc, 1.1);
        dock *= k(c.tdh11 > 0 || c.toku_t1 > 0 || panzer3 > 0, 1.4);
        dock *= k(dh2 > 0, 1.15 * bonus1) * k(dh2_group, 1.15) * k(tanks_m4, 1.1);
        dock *= k(c.panzer > 0, 1.15) * k(c.panzer >= 2, 1.15) * k(c.r35 > 0, 1.15) * k(c.r35 >= 2, 1.15);
        dock *= k(num_ab > 0, 1.1) * k(DOCK_CLASSES.contains(&ctype), 1.1);

        InstallMods {
            soft,
            soft_day: day(1.1, 1.1),
            pillbox,
            pillbox_day: day(1.3, 1.2),
            iso,
            iso_day: day(1.3, 1.1),
            harbour,
            harbour_day: day(1.5, 1.1),
            northern,
            supply_post: supply,
            flat,
            summer_bb,
            summer_ca,
            summer_cv,
            french_bb,
            euro_wp,
            anchorage,
            dock,
        }
    }

    /// Pre-cap (multiplier, day-only multiplier) against `kind` (supply depots use the
    /// soft-skinned table).
    pub fn mult(&self, kind: InstallationKind) -> (f64, f64) {
        use InstallationKind::*;
        match kind {
            Artillery => (self.pillbox, self.pillbox_day),
            IsolatedIsland => (self.iso, self.iso_day),
            Northernmost => (self.northern, 1.0),
            HarbourSummer => (self.harbour, self.harbour_day),
            SoftSkinned | SupplyDepot => (self.soft, self.soft_day),
        }
    }

    /// Post-cap multiplier against a special target group.
    pub fn group(&self, g: TargetGroup) -> f64 {
        match g {
            TargetGroup::SummerBattleship => self.summer_bb,
            TargetGroup::SummerHeavyCruiser => self.summer_ca,
            TargetGroup::SummerCarrier => self.summer_cv,
            TargetGroup::FrenchBattleship => self.french_bb,
            TargetGroup::EuropeanPrincess => self.euro_wp,
            TargetGroup::Anchorage => self.anchorage,
            TargetGroup::Dock => self.dock,
        }
    }
}

/// kcsim `ptDmgMod` / `ptAccMod` of an attacker against PT imps: (damage, accuracy).
pub fn pt_mods<'a>(equips: impl Iterator<Item = &'a Equip> + Clone, class: ShipClass) -> (f64, f64) {
    let n = |f: &dyn Fn(&Equip) -> bool| equips.clone().filter(|e| f(e)).count();
    let guns = n(&|e| e.cat == cat::MAIN_GUN_S);
    let sec = n(&|e| e.cat == cat::SEC_GUN || e.cat == cat::SEC_GUN2);
    let db = n(&|e| e.cat == cat::DIVE_BOMBER);
    let jb = n(&|e| e.cat == cat::JET_BOMBER);
    let sb = n(&|e| e.cat == cat::SEAPLANE_BOMBER || e.cat == cat::SEAPLANE_FIGHTER);
    let aa = n(&|e| e.cat == cat::AA_GUN);
    let lookout = n(&|e| e.cat == cat::LOOKOUT);
    let ad = n(&|e| e.id == 408 || e.id == 409);
    let t4 = n(&|e| e.id == 525 || e.id == 526);
    let k = |cond: bool, m: f64| if cond { m } else { 1.0 };
    let mut dmg = k(guns > 0, 1.5) * k(guns >= 2, 1.4) * k(sec > 0, 1.3);
    let ndb = db.max(jb);
    dmg *= k(ndb > 0, 1.4) * k(ndb >= 2, 1.3) * k(sb > 0, 1.2) * k(aa > 0, 1.2) * k(aa >= 2, 1.2) * k(lookout > 0, 1.1);
    dmg *= k(ad > 0, 1.2) * k(ad >= 2 || t4 >= 2, 1.1);
    let mut acc = match class {
        ShipClass::DD | ShipClass::DE => 1.0,
        ShipClass::CL | ShipClass::CLT | ShipClass::CT => 0.82,
        _ => 0.7,
    };
    acc *= k(guns > 0, 1.3) * k(guns >= 2, 1.15) * k(sec > 0, 1.55) * k(aa > 0, 1.45) * k(aa >= 2, 1.35) * k(lookout > 0, 1.75);
    acc *= k(db > 0, 1.38) * k(db >= 2, 1.2) * k(sb > 0, 1.5) * k(ad > 0, 1.45) * k(ad >= 2 || t4 >= 2, 1.3);
    (dmg, acc)
}

/// kcsim PT accuracy transform of a hit fraction `h`.
#[inline]
pub fn pt_acc(h: f64) -> f64 {
    (0.3 * h + (h * 100.0).max(0.0).sqrt() / 100.0 + 0.15) * 1.2
}

/// kcsim PT damage transform of a post-cap power.
#[inline]
pub fn pt_pow(p: f64) -> f64 {
    p * 0.3 + p.max(0.0).sqrt() + 10.0
}

/// Probabilities of 0 (failure), 1, 2, 3 smoke layers (kcships `Fleet.getSmokeRates`, the
/// wikiwiki 発煙装置(煙幕) estimates). `n` = generators + 2 × Kai, `luck` = flagship luck,
/// `stars` / `stars_kai` = Σ★ of each kind.
pub fn smoke_rates(n: f64, luck: f64, stars: f64, stars_kai: f64) -> [f64; 4] {
    if n <= 0.0 {
        return [1.0, 0.0, 0.0, 0.0];
    }
    let s = 1.5 * luck.sqrt() + 0.3 * stars + 0.5 * stars_kai;
    let mut r = [0.0f64; 3];
    if n >= 3.0 {
        r[2] = (3.0 * (5.0 * n - 15.0 + s).ceil() + 1.0).min(100.0);
        r[1] = (100.0 - r[2]).min(30.0);
        r[0] = (100.0 - r[2] - r[1]).max(0.0);
    } else if n >= 2.0 {
        r[1] = (3.0 * (5.0 * n - 5.0 + s).ceil() + 1.0).min(100.0);
        r[0] = (100.0 - r[1]).max(0.0);
    } else {
        r[0] = 100.0;
    }
    let fail = (3.2 - 0.2 * (luck.sqrt() + 0.3 * stars + 0.5 * stars_kai).ceil() - n).clamp(0.0, 1.0);
    let k = (1.0 - fail) / 100.0;
    [fail, r[0] * k, r[1] * k, r[2] * k]
}

/// Smoke layers for a uniform roll `u` ∈ [0, 1) (kcsim `getSmokeType`: 3, 2, 1 in that order).
pub fn smoke_layers(u: f64, n: f64, luck: f64, stars: f64, stars_kai: f64) -> u8 {
    let p = smoke_rates(n, luck, stars, stars_kai);
    let mut acc = 0.0;
    for t in [3u8, 2, 1] {
        acc += p[t as usize];
        if u < acc {
            return t;
        }
    }
    0
}
