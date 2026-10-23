//! Land-based air squadrons (基地航空隊): waves attacking the enemy fleet before the air phase.
//! Ported from KC3Kai/kancolle-replay `js/kcsim.js` (`LBASPhase`, `airstrikeLBAS`, `compareAP`,
//! `AADefenceFighters`, `getContact`) and `js/kcships.js` (`LandBase`, `LandBase.airPower`,
//! `Equip.setProficiency(rank, forLBAS)`), MIT © fourinone41, with `MECHANICS.LBASBuff`,
//! `hayabusa65Buff` and `SIMCONSTS.enableLBASFormula2` / `enableAirstrikeSpecialBonus` on (their
//! defaults).
//!
//! Per wave: fighter power of the base (interceptor evasion ×1.5, land recon multiplier) vs the
//! enemy's planes of every kind → air state; stage 1 losses on both sides; for each bomber
//! squadron a stage 2 AA roll by a random enemy ship, then a target; all attacks land after the
//! targeting pass. Jets also attack in the waves (×0.7 + 0.5, wikiwiki 基地航空隊 種別倍率 噴式機
//! 0.7071) after their own jet assault ([`super::jet`]). Waves of one base at one node (集中)
//! both start from the squadron sizes before the first wave (wikiwiki 基地航空隊 「同じマスに
//! 集中させた場合」: the first wave's losses are undone; jet-assault losses are not). Against an
//! enemy combined fleet (kcsim `LBASPhase` / `airstrikeLBAS`): the main fleet is targeted 45% of
//! the time, evasion constant `lbasEvaModCombined` 0.68 (B-25 0.7), post-cap ×1.1. Target bonuses
//! (kcsim `airstrikeLBAS`: special abyssals, PT imps, `LBWeak`, `divebombWeak`) and balloons are
//! applied. Not modelled: plane-specific bonuses beyond the equipment ids listed in
//! [`Battle::lb_strike`].
//!
//! Base radius (wikiwiki 基地航空隊 戦闘行動半径): shortest radius of the squadrons with planes, plus
//! round(√(longest recon radius − shortest)) ≤ 3 for flying boats / carrier, seaplane and land
//! recon; the extension is void with an autogyro or ASW patrol plane other than ids 489 / 491.

use super::air::{contact_roll, friend_fighter_loss};
use super::{Battle, List};
use crate::equipment::{cat, f, Equip};
use crate::formulas::{self, evade, evade_luck, hit_term, soft_cap, PlaneBonus, Roll};
use crate::model::{AttackEvent, AttackKind, EquipmentInput, HitResult, Phase, ShipInput, ShipStats, Side, SpecialAttack};
use crate::bonus::BaseBonus;
use crate::ship::{ShipClass, ShipCore, ShipState, MAX_SLOTS};

/// Squadrons per base.
pub const MAX_SQUADRONS: usize = 4;
/// Waves of one battle input (3 bases × 2) and bases of a sortie.
pub const MAX_WAVES: usize = 6;
/// Squadron sizes per base (indexed like the battle's base list).
pub type LbPlanes = [[i32; MAX_SQUADRONS]; MAX_WAVES];

/// kcsim `SIMCONSTS.lbasDmgCap`.
const CAP_LBAS: f64 = 220.0;
/// kcsim `SIMCONSTS.lbasAccBase`.
const ACC_BASE: f64 = 0.9;
/// kcsim `SIMCONSTS.lbasEvaModSingle` / `lbasEvaModCombined` / `lbasEvaModCombinedB25`.
const EV_POST_SINGLE: f64 = 0.86;
const EV_POST_COMBINED: f64 = 0.68;
const EV_POST_COMBINED_B25: f64 = 0.7;
const FIGHTER_TABLE: [f64; 8] = [0.0, 0.0, 2.0, 5.0, 9.0, 14.0, 14.0, 22.0];

/// One land base: its squadrons and derived constants.
#[derive(Clone, Debug)]
pub struct LandBaseCore {
    pub squadrons: Vec<Equip>,
    /// Full squadron sizes.
    pub planes: [i32; MAX_SQUADRONS],
    /// Fighter-power proficiency bonus per squadron (`setProficiency(rank, forLBAS)`).
    pub(super) ap_bonus: [f64; MAX_SQUADRONS],
    /// Land recon fighter-power multiplier (×1.15 / ×1.18).
    recon_ap: f64,
    /// Land recon multiplier on attack power (×1.12 / ×1.15).
    recon_contact: f64,
    /// Air-defence fighter-power recon multiplier (wikiwiki 基地航空隊 防空時 偵察機補正).
    pub(super) recon_defense: f64,
    /// Combat radius; `None` when a squadron with planes has no `radius`.
    pub radius: Option<u32>,
    /// Jet squadrons as one-plane carriers for the jet assault (kcships `createJetLandBase`:
    /// level 1, luck 3): (squadron, core, state).
    pub(super) jets: Vec<(usize, ShipCore, ShipState)>,
}

/// Squadron size of an item without an explicit `planes`: recon 4, large land-based bomber 9,
/// else 18.
fn default_planes(c: u32) -> i32 {
    match c {
        cat::CARRIER_SCOUT | cat::CARRIER_SCOUT2 | cat::SEAPLANE | cat::FLYING_BOAT | cat::LAND_SCOUT => 4,
        cat::LAND_BOMBER_L => 9,
        _ => 18,
    }
}

/// kcsim `Equip.setProficiency(rank, true)`: √(exp/10), plus the fighter / seaplane bomber tables
/// (and the fighter table for ids 489, 491 under `MECHANICS.aswPlaneAir`).
fn lb_ap_bonus(e: &Equip) -> f64 {
    let r = e.rank as usize;
    let mut b = (e.exp * 0.1).sqrt();
    match e.cat {
        cat::FIGHTER | cat::SEAPLANE_FIGHTER | cat::INTERCEPTOR | cat::JET_FIGHTER => b += FIGHTER_TABLE[r],
        cat::SEAPLANE_BOMBER => b += [0.0, 0.0, 1.0, 1.0, 1.0, 3.0, 3.0, 6.0][r],
        _ => {}
    }
    if e.id == 489 || e.id == 491 {
        b = (e.exp * 0.1).sqrt() + FIGHTER_TABLE[r];
    }
    b
}

/// kcsim `isdivebomber` of a land-base squadron (dive bombers, seaplane bombers, land bombers,
/// jet bombers, autogyros and ASW patrol planes).
fn lb_dive(e: &Equip) -> bool {
    e.has(f::DIVE) || e.cat == cat::AUTOGYRO || e.cat == cat::ASW_PLANE
}

fn is_land_bomber(e: &Equip) -> bool {
    e.cat == cat::LAND_BOMBER || e.cat == cat::LAND_BOMBER_L
}

impl LandBaseCore {
    pub fn new(what: &str, inputs: &[EquipmentInput]) -> Result<LandBaseCore, String> {
        if inputs.len() > MAX_SQUADRONS {
            return Err(format!("{what}: {} squadrons (max {MAX_SQUADRONS})", inputs.len()));
        }
        let squadrons: Vec<Equip> = inputs.iter().map(Equip::from_input).collect();
        let mut planes = [0; MAX_SQUADRONS];
        let mut ap_bonus = [0.0; MAX_SQUADRONS];
        let (mut recon_ap, mut recon_contact, mut recon_defense) = (1.0f64, 1.0f64, 1.0f64);
        let mut jets = Vec::new();
        for (k, (e, input)) in squadrons.iter().zip(inputs).enumerate() {
            planes[k] = input.planes.unwrap_or_else(|| default_planes(e.cat)).max(0);
            ap_bonus[k] = lb_ap_bonus(e);
            if e.cat == cat::LAND_SCOUT {
                if e.los >= 9.0 {
                    recon_ap = 1.18;
                } else if recon_ap < 1.15 {
                    recon_ap = 1.15;
                }
                if e.acc >= 3.0 {
                    recon_contact = 1.15;
                } else if recon_contact < 1.12 {
                    recon_contact = 1.12;
                }
            }
            recon_defense = recon_defense.max(defense_recon_mod(e));
            if e.has(f::JET) && e.has(f::PLANE) {
                let ship = ShipInput {
                    ship_type: 11,
                    level: Some(1.0),
                    max_hp: 1,
                    stats: ShipStats { luck: Some(3.0), ..Default::default() },
                    slots: vec![Some(EquipmentInput { planes: Some(planes[k]), ..input.clone() })],
                    ..Default::default()
                };
                let core = ShipCore::new(&ship, true);
                let st = core.initial_state(&ship);
                jets.push((k, core, st));
            }
        }
        let radius = base_radius(&squadrons, inputs, &planes);
        Ok(LandBaseCore { squadrons, planes, ap_bonus, recon_ap, recon_contact, recon_defense, radius, jets })
    }

    /// Whether the base has any jet squadron (kcsim `hasjet`).
    pub(super) fn has_jets(&self) -> bool {
        !self.jets.is_empty()
    }

    /// kcsim `LandBase.airPower('isPlane')` (sortie): every plane, interceptors add 1.5 × evasion.
    /// Empty squadrons count 0.
    fn air_power(&self, planes: &[i32; MAX_SQUADRONS]) -> f64 {
        let mut ap = 0.0;
        for (k, e) in self.squadrons.iter().enumerate() {
            if !e.has(f::PLANE) || planes[k] <= 0 {
                continue;
            }
            let mut base = e.aa + e.aa_improve;
            if e.cat == cat::INTERCEPTOR {
                base += e.ev * 1.5;
            }
            ap += (base * (planes[k] as f64).sqrt() + self.ap_bonus[k]).floor();
        }
        (ap * self.recon_ap).floor()
    }
}

/// Air-defence recon multiplier of one squadron (wikiwiki 基地航空隊 防空時 偵察機補正; kcships
/// `LandBase.airPowerDefend` has the same values, land recon by accuracy instead of LoS).
fn defense_recon_mod(e: &Equip) -> f64 {
    match e.cat {
        cat::SEAPLANE | cat::FLYING_BOAT if e.los >= 9.0 => 1.16,
        cat::SEAPLANE | cat::FLYING_BOAT if e.los >= 8.0 => 1.13,
        cat::SEAPLANE | cat::FLYING_BOAT => 1.1,
        cat::CARRIER_SCOUT | cat::CARRIER_SCOUT2 if e.los >= 9.0 => 1.3,
        cat::CARRIER_SCOUT | cat::CARRIER_SCOUT2 => 1.2,
        cat::LAND_SCOUT if e.los >= 9.0 => 1.23,
        cat::LAND_SCOUT => 1.18,
        _ => 1.0,
    }
}

/// Base radius (see the module docs).
fn base_radius(squadrons: &[Equip], inputs: &[EquipmentInput], planes: &[i32; MAX_SQUADRONS]) -> Option<u32> {
    let mut min: Option<u32> = None;
    let mut recon = 0;
    let mut no_ext = false;
    for (k, (e, input)) in squadrons.iter().zip(inputs).enumerate() {
        if planes[k] <= 0 {
            continue;
        }
        let r = input.radius?;
        min = Some(min.map_or(r, |m| m.min(r)));
        match e.cat {
            cat::FLYING_BOAT | cat::CARRIER_SCOUT | cat::CARRIER_SCOUT2 | cat::SEAPLANE | cat::LAND_SCOUT => recon = recon.max(r),
            cat::AUTOGYRO | cat::ASW_PLANE if e.id != 489 && e.id != 491 => no_ext = true,
            _ => {}
        }
    }
    let min = min?;
    let ext = if no_ext || recon <= min { 0 } else { (((recon - min) as f64).sqrt().round() as u32).min(3) };
    Some(min + ext)
}

/// Initial squadron sizes of `bases` (≤ [`MAX_WAVES`]).
pub fn initial_planes(bases: &[LandBaseCore]) -> LbPlanes {
    let mut p = [[0; MAX_SQUADRONS]; MAX_WAVES];
    for (dst, b) in p.iter_mut().zip(bases) {
        *dst = b.planes;
    }
    p
}

/// kcsim `compareAP`: air state of the first side (2 AS+ .. −2 AI).
pub(super) fn compare_ap(ap1: f64, ap2: f64) -> i8 {
    if ap1 >= ap2 * 3.0 {
        2
    } else if ap1 >= ap2 * 1.5 {
        1
    } else if ap2 >= ap1 * 3.0 {
        -2
    } else if ap2 >= ap1 * 1.5 {
        -1
    } else {
        0
    }
}

/// Per-battle carry-over between waves (kcsim `LandBase.airStatePrev` / `contactPrev`).
#[derive(Default)]
struct WaveMemo {
    air: i8,
    contact: Option<f64>,
}

impl<'a> Battle<'a> {
    /// All land-base waves of this battle (kcsim `sim`: "lbas" block). Each wave starts from its
    /// base's pre-battle squadron sizes; the base keeps the sizes after its last wave.
    pub(super) fn lbas_phase(&mut self) {
        let Some(run) = self.lbas.take() else { return };
        let (bases, waves) = (run.bases, run.waves);
        let mut planes = run.planes;
        let start = planes;
        let mut memo = WaveMemo::default();
        let phase = self.phase;
        self.phase = Phase::LandBase;
        for (w, &b) in waves.iter().enumerate() {
            let base = &bases[b];
            if base.squadrons.is_empty() || !(self.any_alive(0) && self.any_alive(1)) {
                continue;
            }
            planes[b] = start[b];
            // Event bonus of this base (kcsim `LBASPhase`: `bonusSpecialPSelf` and base-wide groups).
            let bonus = self.lb_bonus.get(b).and_then(Option::as_ref);
            self.lb_wave(w, base, &mut planes[b], &mut memo, bonus);
        }
        self.phase = phase;
        self.lbas = Some(super::LbRun { bases, waves, planes });
    }

    /// kcsim `compareAP(lbas, F2, 'isPlane')` + `LBASPhase`.
    fn lb_wave(&mut self, w: usize, base: &LandBaseCore, planes: &mut [i32; MAX_SQUADRONS], memo: &mut WaveMemo, bonus: Option<&BaseBonus>) {
        // Enemy fighter power over every plane type.
        let mut ap2 = 0.0;
        let mut enemy_air = false;
        let mut carriers = List::default();
        for i in self.engaged(1) {
            if !self.alive(1, i) {
                continue;
            }
            carriers.push(i);
            let c = self.core(1, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                let n = self.st[1][i].planes[s];
                if n <= 0 || !e.has(f::PLANE) {
                    continue;
                }
                enemy_air = true;
                ap2 += ((e.aa + e.aa_improve) * (n as f64).sqrt() + e.ap_bonus).floor();
            }
        }
        let lb_air = base.squadrons.iter().zip(planes.iter()).any(|(e, &n)| e.has(f::PLANE) && n > 0);
        let air = if lb_air || enemy_air { compare_ap(base.air_power(planes), ap2.floor()) } else { 0 };

        // Stage 1.
        for (k, e) in base.squadrons.iter().enumerate() {
            if !e.has(f::PLANE) || planes[k] <= 0 {
                continue;
            }
            let m = if e.has(f::JET) { 0.6 } else { 1.0 };
            let lost = friend_fighter_loss(self.rng(), planes[k], air, m);
            planes[k] = (planes[k] - lost).max(0);
        }
        self.fighter_losses(1, carriers, f::PLANE, -air);

        // Contact: parity reuses the previous wave's air state, denial-or-worse the previous contact.
        let air_c = if air == 0 {
            memo.air
        } else {
            memo.air = air;
            air
        };
        let mut contact = 1.0;
        if air_c != -2 && air_c != 0 {
            let items = base.squadrons.iter().zip(planes.iter().copied());
            if let Some(m) = contact_roll(self.rng, air_c, items) {
                contact = m;
                memo.contact = Some(m);
            }
        }
        if air_c == -2 {
            if let Some(m) = memo.contact {
                contact = m;
            }
        }

        // Stage 2 and targeting.
        let mut defenders = List::default();
        for i in self.engaged(1) {
            if self.alive(1, i) {
                defenders.push(i);
            }
        }
        let fleet_aa = self.fleet_aa[1];
        let mut attacks: [(usize, usize, bool); MAX_SQUADRONS] = [(0, 0, false); MAX_SQUADRONS];
        let mut n_attacks = 0;
        for (k, e) in base.squadrons.iter().enumerate() {
            if !e.has(f::PLANE) {
                continue;
            }
            let (dive, torp) = (lb_dive(e), e.has(f::TORP_BOMBER));
            let asw_plane = e.asw >= 7.0;
            let surface_plane = (dive || torp) && (e.bomb > 0.0 || !(e.cat == cat::AUTOGYRO || e.cat == cat::ASW_PLANE));
            if !surface_plane && !asw_plane {
                continue;
            }
            if !defenders.is_empty() && (dive || torp) {
                let d = defenders.as_slice()[self.rng().below(defenders.len())];
                let waa = self.core(1, d).weighted_aa;
                let n = planes[k];
                let prop = if self.rng().chance(0.5) { (n as f64 * waa / 200.0).floor() as i32 } else { 0 };
                let flat = if self.rng().chance(0.5) { ((waa + fleet_aa) * 0.1875).floor() as i32 } else { 0 };
                planes[k] = (n - prop - flat).max(0);
                if planes[k] <= 0 {
                    continue;
                }
            }
            let cands = if self.enemy_combined() {
                self.lb_targets_combined(asw_plane, surface_plane)
            } else {
                let subs = self.subs(1);
                if asw_plane && !subs.is_empty() {
                    subs
                } else if surface_plane {
                    self.surface(1)
                } else {
                    continue;
                }
            };
            if cands.is_empty() {
                continue;
            }
            let (t, covered) = self.choose_target(1, cands.as_slice(), 0);
            attacks[n_attacks] = (k, t, covered);
            n_attacks += 1;
        }
        for &(k, t, covered) in &attacks[..n_attacks] {
            let bonus = bonus.map_or((1.0, 1.0), |bb| bb.mods(k, &planes[..]));
            self.lb_strike(w, base, k, planes[k], t, covered, contact, bonus);
        }
    }

    /// The enemy is a combined fleet (main + escort).
    pub(super) fn enemy_combined(&self) -> bool {
        self.fleets[1].escort_start < self.fleets[1].ships.len()
    }

    /// kcsim `LBASPhase` targets against an enemy combined fleet: ASW planes submarines (with
    /// surface planes: submarines and surface ships), then the main fleet 45% / the escort 55%,
    /// then an ASW plane keeps only the submarines of that fleet if any.
    fn lb_targets_combined(&mut self, asw_plane: bool, surface_plane: bool) -> List {
        let (subs, surface) = (self.subs(1), self.surface(1));
        let mut all = List::default();
        for &i in subs.as_slice().iter().filter(|_| asw_plane).chain(surface.as_slice().iter().filter(|_| surface_plane)) {
            all.push(i);
        }
        let es = self.fleets[1].escort_start;
        let has_main = all.as_slice().iter().any(|&i| i < es);
        let has_escort = all.as_slice().iter().any(|&i| i >= es);
        let main = if has_main && has_escort { self.rng().chance(0.45) } else { has_main };
        let mut picked = List::default();
        for &i in all.as_slice().iter().filter(|&&i| (i < es) == main) {
            picked.push(i);
        }
        if asw_plane && picked.as_slice().iter().any(|&i| self.core(1, i).class.is_sub()) {
            let mut only = List::default();
            for &i in picked.as_slice().iter().filter(|&&i| self.core(1, i).class.is_sub()) {
                only.push(i);
            }
            return only;
        }
        picked
    }

    /// kcsim `airstrikeLBAS` of squadron `k` (`n` planes) on enemy ship `t`.
    /// `bonus`: the squadron's event (damage, accuracy) multipliers.
    #[allow(clippy::too_many_arguments)]
    fn lb_strike(&mut self, w: usize, base: &LandBaseCore, k: usize, n: i32, t: usize, covered: bool, contact: f64, bonus: (f64, f64)) {
        use ShipClass::*;
        let e = &base.squadrons[k];
        let def = self.core(1, t);
        let class = def.class;
        let inst = def.is_installation;
        let sub = class.is_sub();
        let mid = def.master_id;
        let any = |set: &[ShipClass]| set.contains(&class);
        let big = [CVL, FBB, BB, BBV, CV];

        // Accuracy and proficiency (LBASBuff: land bombers use proficiency too).
        let (mut exp, mut rank) = (e.exp, e.rank);
        if e.cat == cat::AUTOGYRO || e.cat == cat::ASW_PLANE {
            exp *= 0.825;
            rank = rank.saturating_sub(1);
        }
        let (acc_plane, critval) = match rank {
            0 => (0.0, 0.0),
            r => {
                let (a, c) = [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 4.0), (4.0, 5.0), (6.0, 7.0), (9.0, 10.0)][r as usize - 1];
                ((exp * 0.1).sqrt() + a, c)
            }
        };
        let crit_dmg = 1.0 + ((exp.sqrt() + critval).floor()) / 100.0;
        let mut acc = ACC_BASE + 0.07 * e.acc;
        if [1557, 1586].contains(&mid) {
            acc *= 1.1;
        }
        if [1665, 1666, 1667, 2178, 2179, 2196, 2197].contains(&mid) {
            acc *= 1.06;
        }
        if [2180, 2181].contains(&mid) {
            acc *= 1.15;
        }
        match e.id {
            444 => {
                if class == DD {
                    acc -= 0.07;
                }
                if any(&[CL, CLT, CVL, FBB, BB, BBV, CV]) {
                    acc += 0.07;
                }
            }
            484 => {
                if class == DD {
                    acc -= 0.05;
                }
                if any(&[CL, CLT, CA, CAV, CVL, FBB, BB, BBV, CV]) {
                    acc += 0.05;
                }
            }
            453 if class == DD => acc += 0.07,
            454 => {
                if class == DD {
                    acc -= 0.17;
                }
                if any(&[CL, CLT]) {
                    acc += 0.07;
                }
                if any(&[CA, CAV, CVL, FBB, BB, BBV, CV]) {
                    acc += 0.05;
                }
            }
            _ => {}
        }
        if e.id == 459 {
            if inst {
                acc -= 0.09;
            } else if any(&[FBB, BB, BBV, CVL, CV, CVB]) {
                acc += 0.31;
            } else if any(&[CA, CAV]) {
                acc += 0.22;
            } else if any(&[CL, CLT, AV]) {
                acc += 0.18;
            } else if class == DD {
                acc += 0.13;
            }
        }
        acc *= bonus.1;
        let hc = {
            let du = self.unit(1, t);
            let ev = du.evasion(1.0, 0.0);
            let plane = Some(PlaneBonus { acc: acc_plane, crit_rate: critval * 0.8 });
            let ev_post = match (self.enemy_combined(), e.id) {
                (false, _) => EV_POST_SINGLE,
                (true, 459) => EV_POST_COMBINED_B25,
                (true, _) => EV_POST_COMBINED,
            };
            formulas::hit_crit_post(hit_term(acc), evade(ev.ev, evade_luck(ev.luck), 1.0), &ev, 0.0, plane, 0.0, ev_post)
        };
        let roll = formulas::roll_hit(self.rng(), &hc, crit_dmg);
        let hp_before = self.st[1][t].hp;
        let mut real = 0;
        if roll != Roll::Miss {
            let lb = is_land_bomber(e);
            let mut pb = if lb {
                if inst { e.bomb } else { e.tp }
            } else if lb_dive(e) {
                e.bomb
            } else if inst {
                (e.tp / 2.0).floor()
            } else {
                e.tp
            };
            if sub {
                pb = e.asw;
            }
            if class == DD && e.id == 224 {
                pb = 25.0;
            }
            if class == DD && e.id == 491 {
                pb = 30.0;
            }
            if !inst {
                match e.id {
                    405 if class == DD => pb *= 1.1,
                    406 if any(&[FBB, BB, BBV]) => pb *= 1.5,
                    444 | 454 => {
                        let (small, large) = if e.id == 444 { (1.15, 1.13) } else { (1.16, 1.14) };
                        if any(&[DD, CL, CLT, CA, CAV]) {
                            pb *= small;
                        }
                        if any(&big) {
                            pb *= large;
                        }
                    }
                    562 => {
                        if class == DD {
                            pb *= 1.25;
                        }
                        if any(&[FBB, BB, BBV]) {
                            pb *= 1.15;
                        }
                    }
                    _ => {}
                }
            }
            if e.id == 484 {
                if inst {
                    pb += 2.1;
                } else {
                    if any(&[DD, CL, CLT, CA, CAV]) {
                        pb += 2.6;
                    }
                    if any(&big) {
                        pb += 2.25;
                    }
                }
            }
            if pb != 0.0 && !sub {
                pb += e.air_power_improve;
            }
            let dmg_base = 25.0 + pb * (1.8 * n as f64).sqrt();
            let mut pre = if lb { 0.8 } else { 1.0 };
            if sub {
                pre = if pb >= 10.0 { 0.7 + self.rng().f64() * 0.3 } else { 0.35 + self.rng().f64() * 0.45 };
            }
            pre *= base.recon_contact;
            let mut post = if e.cat == cat::LAND_BOMBER { 1.8 } else { 1.0 };
            if self.enemy_combined() {
                post *= 1.1;
            }
            if e.id == 459 {
                if inst {
                    pre *= 0.9;
                } else if class == DD {
                    pre *= 1.9;
                } else if any(&[CL, CLT, AV]) {
                    pre *= 1.75;
                } else if any(&[CA, CAV]) {
                    pre *= 1.6;
                } else if any(&[CVL, FBB, BB, BBV, CV, CVB]) {
                    pre *= 1.3;
                }
            }
            // SIMCONSTS.enableAirstrikeSpecialBonus: random multipliers against specific bosses and
            // PT imps, else the target's `LBWeak` (pre-cap) and `divebombWeak` (dive bombers).
            let tt = &self.core(1, t).target;
            let special: Option<(f64, f64, f64)> = match mid {
                1557 | 1586 | 1620 => Some((0.35, 3.0, 1.7)),
                _ if tt.pt => Some((0.4, 0.7, 0.4)),
                1653..=1658 => Some((0.4, 3.5, 1.7)),
                1665..=1667 => Some((0.5, 2.5, 1.6)),
                1668..=1672 => Some((0.4, 2.0, 1.5)),
                1696..=1698 => Some((0.4, 1.8, 1.5)),
                1699..=1704 | 2023..=2028 | 2243..=2246 => Some((0.5, 1.5, 1.2)),
                1751 => Some((0.4, 1.7, 1.3)),
                2178 | 2179 | 2196 | 2197 => Some((0.5, 2.2, 1.5)),
                2180 | 2181 => Some((0.5, 1.6, 1.3)),
                2188..=2191 => Some((0.4, 1.8, 1.4)),
                _ => None,
            };
            if let Some((p, hi, lo)) = special {
                post *= if self.rng().chance(p) { hi } else { lo };
            } else {
                pre *= tt.lb_weak;
                if lb_dive(e) {
                    post *= tt.divebomb_weak;
                }
            }
            post *= bonus.0;
            if e.cat == cat::SEAPLANE {
                post = 0.0;
            }
            let mut pow = dmg_base * pre;
            if e.has(f::JET) {
                pow = pow * 0.7 + 0.5;
            }
            pow = soft_cap(pow, CAP_LBAS).floor();
            // kcsim `LBASPhase`: friend balloons +2 % each, the target fleet's −5 % each.
            let balloon = (1.0 + self.balloons(0) as f64 / 50.0) * (1.0 - self.balloons(1) as f64 / 20.0);
            pow *= contact * balloon * post;
            let armor = self.core(1, t).ar;
            let dmg = formulas::damage_common(self.rng(), pow, roll, armor, 1.0, hp_before);
            real = self.take_damage(1, t, dmg);
        }
        if let Some(ev) = self.events.as_mut() {
            ev.push(AttackEvent {
                phase: Phase::LandBase,
                kind: AttackKind::Air,
                special: SpecialAttack::Normal,
                attacker_side: Side::Friend,
                attacker: w,
                defender: t,
                covered,
                slot: Some(k),
                hit: match roll {
                    Roll::Miss => HitResult::Miss,
                    Roll::Hit => HitResult::Hit,
                    Roll::Crit(_) => HitResult::Critical,
                },
                damage: real,
                defender_hp_before: hp_before,
                defender_hp_after: self.st[1][t].hp,
                p_hit: hc.p_hit(),
                p_crit: hc.p_crit(),
            });
        }
    }
}
