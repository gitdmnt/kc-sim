//! Opening ASW and day shelling (rounds 1 and 2). Ported from kcsim `shellPhase`,
//! `shellPhaseTarget`, `shell`, `ASW`, `orderByRange` and kcships `canASW`, `canOASW`, `canShell`,
//! `canAS`, `ASchance` (KC3Kai/kancolle-replay, MIT © fourinone41).

use super::calc::{self, Special, Unit};
use super::special::Fsa;
use super::{side_air, Battle, List};
use crate::equipment::{cat, f};
use crate::formulas::{self, Roll};
use crate::model::{AttackKind, SpecialAttack};
use crate::ship::{DayCi, ShipClass, ShipCore, ShipState, MAX_SLOTS};

/// kcsim `canASW` (with plane checks against the current plane counts).
pub fn can_asw(c: &ShipCore, st: &ShipState, opening: bool) -> bool {
    let asw_plane = || {
        (0..MAX_SLOTS).any(|s| c.slots[s].as_ref().is_some_and(|e| e.has(f::ASW_PLANE) && e.asw > 0.0) && st.planes[s] > 0)
    };
    let has_dc = || c.slots.iter().flatten().any(|e| e.cat == cat::DEPTH_CHARGE);
    match c.class {
        ShipClass::DD | ShipClass::CL | ShipClass::CLT | ShipClass::CT | ShipClass::DE | ShipClass::AO => c.naked.asw > 0.0,
        ShipClass::CAV | ShipClass::AV | ShipClass::BBV | ShipClass::LHA => (!c.is_player && c.naked.asw > 0.0) || asw_plane(),
        ShipClass::CVL => (opening && !c.is_player) || asw_plane(),
        ShipClass::AS | ShipClass::AR => has_dc(),
        _ => false,
    }
}

/// kcsim `canASWNight`.
pub fn can_asw_night(c: &ShipCore, st: &ShipState) -> bool {
    match c.plane_asw {
        1 => false,
        2 => c.naked.asw > 0.0,
        _ => can_asw(c, st, false),
    }
}

/// kcsim `canOASW`.
pub fn can_oasw(c: &ShipCore, st: &ShipState) -> bool {
    match c.class {
        ShipClass::DE => (c.has_sonar && c.asw >= 60.0) || (c.asw >= 75.0 && c.equip_asw_total >= 4.0),
        ShipClass::CVL => {
            let eqs = || c.slots.iter().flatten();
            if !eqs().any(|e| [cat::DIVE_BOMBER, cat::TORP_BOMBER, cat::AUTOGYRO, cat::ASW_PLANE].contains(&e.cat) && e.asw > 0.0) {
                return false;
            }
            if c.always_oasw {
                return true;
            }
            if eqs().any(|e| [cat::TORP_BOMBER, cat::AUTOGYRO, cat::ASW_PLANE].contains(&e.cat) && e.asw >= 7.0) {
                let threshold = if c.has_sonar { 50.0 } else { 65.0 };
                if c.asw >= threshold {
                    return true;
                }
            }
            c.has_sonar && c.asw >= 100.0
        }
        _ => can_asw(c, st, true) && (c.always_oasw || (c.asw >= 100.0 && c.has_sonar && c.is_player)),
    }
}

/// Ship may take a turn in this shelling round (order construction). `vs_install`: an enemy
/// installation is afloat (kcsim `orderByRange(…, hasInstall)`: only then do submarines with a
/// WG42 / amphibious tank shell).
pub fn can_shell(c: &ShipCore, st: &ShipState, opening: bool, vs_install: bool) -> bool {
    if st.hp <= 0 {
        return false;
    }
    if c.cv_like() || c.vs.cv_shell {
        return opening
            || (0..MAX_SLOTS).any(|s| {
                c.slots[s].as_ref().is_some_and(|e| matches!(e.cat, cat::DIVE_BOMBER | cat::TORP_BOMBER | cat::JET_BOMBER)) && st.planes[s] > 0
            });
    }
    if c.class.is_sub() {
        return vs_install && c.vs.sub_shell;
    }
    true
}

/// Ship can still act when its turn comes (kcsim `canStillShell`).
pub fn can_still_shell(c: &ShipCore, st: &ShipState, opening: bool) -> bool {
    if st.hp <= 0 {
        return false;
    }
    if (c.cv_like() || c.vs.cv_shell) && !opening {
        let limit = if c.class == ShipClass::CVB { 0.25 } else { 0.5 };
        return st.hp_ratio(c.max_hp) > limit;
    }
    true
}

/// Slots with `pred` and planes left.
fn plane_slots(c: &ShipCore, st: &ShipState, pred: impl Fn(&crate::equipment::Equip) -> bool) -> usize {
    (0..MAX_SLOTS).filter(|&s| c.slots[s].as_ref().is_some_and(&pred) && st.planes[s] > 0).count()
}

/// Cut-in kind usable with the current plane counts: each carrier cut-in needs its plane types,
/// Zuiun / 634 cut-ins two such slots (kcsim `canASZuiun`), artillery spotting a recon plane.
fn ci_available(c: &ShipCore, st: &ShipState, k: DayCi) -> bool {
    let n = |k: u32| plane_slots(c, st, |e| e.cat == k);
    match k {
        DayCi::Zuiun => plane_slots(c, st, |e| e.has(f::ZUIUN)) >= 2,
        DayCi::Bomber634 => plane_slots(c, st, |e| e.has(f::BOMBER_634)) >= 2,
        DayCi::CvciFba => n(cat::FIGHTER) > 0 && n(cat::DIVE_BOMBER) > 0 && n(cat::TORP_BOMBER) > 0,
        DayCi::CvciBba => n(cat::DIVE_BOMBER) >= 2 && n(cat::TORP_BOMBER) > 0,
        DayCi::CvciBa => n(cat::DIVE_BOMBER) > 0 && n(cat::TORP_BOMBER) > 0,
        DayCi::CvciJfJbJb => n(cat::JET_FIGHTER) > 0 && n(cat::JET_BOMBER) >= 2,
        DayCi::CvciJfJb => n(cat::JET_FIGHTER) > 0 && n(cat::JET_BOMBER) > 0,
        DayCi::CvciJfBa => n(cat::JET_FIGHTER) > 0 && n(cat::DIVE_BOMBER) > 0 && n(cat::TORP_BOMBER) > 0,
        _ => c.has_planes(st, f::RECON),
    }
}

/// Artillery spotting / CVCI possible right now (kcsim `canAS` / `CV.canAS`).
fn can_as(c: &ShipCore, st: &ShipState) -> bool {
    !c.day_ci.is_empty() && st.hp_ratio(c.max_hp) > 0.25 && c.day_ci.iter().any(|&k| ci_available(c, st, k))
}

pub fn day_ci_special(ci: Option<DayCi>) -> SpecialAttack {
    match ci {
        None => SpecialAttack::Normal,
        Some(DayCi::DoubleAttack) => SpecialAttack::DoubleAttack,
        Some(DayCi::MainSec) => SpecialAttack::CutinMainSecondary,
        Some(DayCi::MainRadar) => SpecialAttack::CutinMainRadar,
        Some(DayCi::MainAp) => SpecialAttack::CutinMainAp,
        Some(DayCi::MainMain) => SpecialAttack::CutinMainMain,
        Some(DayCi::CvciFba) => SpecialAttack::CvciFba,
        Some(DayCi::CvciBba) => SpecialAttack::CvciBba,
        Some(DayCi::CvciBa) => SpecialAttack::CvciBa,
        Some(DayCi::CvciJfJbJb) => SpecialAttack::CvciJfJbJb,
        Some(DayCi::CvciJfJb) => SpecialAttack::CvciJfJb,
        Some(DayCi::CvciJfBa) => SpecialAttack::CvciJfBa,
        Some(DayCi::Zuiun) => SpecialAttack::ZuiunCutin,
        Some(DayCi::Bomber634) => SpecialAttack::Bomber634Cutin,
    }
}

pub fn special_day_ci(s: SpecialAttack) -> Option<DayCi> {
    match s {
        SpecialAttack::DoubleAttack => Some(DayCi::DoubleAttack),
        SpecialAttack::CutinMainSecondary => Some(DayCi::MainSec),
        SpecialAttack::CutinMainRadar => Some(DayCi::MainRadar),
        SpecialAttack::CutinMainAp => Some(DayCi::MainAp),
        SpecialAttack::CutinMainMain => Some(DayCi::MainMain),
        SpecialAttack::CvciFba => Some(DayCi::CvciFba),
        SpecialAttack::CvciBba => Some(DayCi::CvciBba),
        SpecialAttack::CvciBa => Some(DayCi::CvciBa),
        SpecialAttack::CvciJfJbJb => Some(DayCi::CvciJfJbJb),
        SpecialAttack::CvciJfJb => Some(DayCi::CvciJfJb),
        SpecialAttack::CvciJfBa => Some(DayCi::CvciJfBa),
        SpecialAttack::ZuiunCutin => Some(DayCi::Zuiun),
        SpecialAttack::Bomber634Cutin => Some(DayCi::Bomber634),
        _ => None,
    }
}

impl<'a> Battle<'a> {
    pub(super) fn opening_asw(&mut self) {
        let mut orders = [List::default(), List::default()];
        for side in 0..2 {
            let mut l = List::default();
            for i in self.engaged(side) {
                let c = self.core(side, i);
                if self.alive(side, i) && !c.class.is_sub() && can_oasw(c, &self.st[side][i]) {
                    l.push(i);
                }
            }
            orders[side] = self.order_by_range(side, l);
        }
        if !orders[0].is_empty() || !orders[1].is_empty() {
            self.shell_phase(orders, true);
        }
    }

    pub(super) fn shelling(&mut self, second: bool) {
        let mut orders = [List::default(), List::default()];
        for side in 0..2 {
            let vs_install = self.has_installation(1 - side);
            let mut l = List::default();
            for i in self.engaged(side) {
                if can_shell(self.core(side, i), &self.st[side][i], false, vs_install) {
                    l.push(i);
                }
            }
            orders[side] = if second { l } else { self.order_by_range(side, l) };
        }
        self.shell_phase(orders, false);
    }

    /// An installation of `side` is afloat (kcsim `hasInstall`).
    fn has_installation(&self, side: usize) -> bool {
        (0..self.len(side)).any(|i| self.alive(side, i) && self.core(side, i).is_installation)
    }

    fn shell_phase(&mut self, orders: [List; 2], opening: bool) {
        let n = orders[0].len().max(orders[1].len());
        for k in 0..n {
            for side in 0..2 {
                if k < orders[side].len() {
                    let a = orders[side].as_slice()[k];
                    if can_still_shell(self.core(side, a), &self.st[side][a], opening) {
                        // kcsim `shellPhase`: the friend main flagship's turn may become a fleet special attack.
                        let special = if side == 0 && a == 0 && !opening && !self.surface(1).is_empty() { self.try_fleet_special(false, 0) } else { None };
                        match special {
                            Some((kind, attackers)) => self.special_shelling(kind, attackers),
                            None => self.shell_turn(side, a, opening),
                        }
                    }
                }
                if !self.any_alive(1 - side) {
                    return;
                }
            }
        }
    }

    /// Fleet special attack in the day battle: each attacker shells a surface target (kcsim
    /// `getSpecialAttackShips` + `shellPhaseTarget(ship, alive2, [])` + `shell(…, attackSpecial)`).
    fn special_shelling(&mut self, kind: Fsa, attackers: List) {
        for &a in attackers.as_slice() {
            let targets = self.surface(1);
            if targets.is_empty() {
                break;
            }
            if !self.alive(0, a) {
                continue;
            }
            let (t, covered) = self.choose_preferred(0, a, targets.as_slice(), true, 0);
            let sp = self.special_mods(kind, 0, a);
            self.shell_attack(0, a, t, covered, Some((sp, kind.event())));
        }
    }

    /// kcsim `shellPhaseTarget` + attack.
    fn shell_turn(&mut self, side: usize, a: usize, opening: bool) {
        let def = 1 - side;
        let subs = self.subs(def);
        let c = self.core(side, a);
        if !subs.is_empty() && can_asw(c, &self.st[side][a], opening) {
            let (t, covered) = self.choose_target(def, subs.as_slice(), 0);
            self.asw_attack(side, a, t, covered, opening, false);
            return;
        }
        if opening {
            return;
        }
        let surface = self.surface(def);
        let mut targets = List::default();
        // kcsim `CV.canShellInstallation`: carriers with dive bombers skip installations unless a
        // bomber that can attack them is aboard.
        let st = &self.st[side][a];
        let has_dive_planes = (c.cv_like() || c.vs.cv_shell)
            && (0..MAX_SLOTS).any(|s| c.slots[s].as_ref().is_some_and(|e| matches!(e.cat, cat::DIVE_BOMBER | cat::JET_BOMBER)) && st.planes[s] > 0);
        let can_install = !has_dive_planes
            || (0..MAX_SLOTS).any(|s| c.slots[s].as_ref().is_some_and(|e| crate::install::can_shell_install(e.id)) && st.planes[s] > 0);
        for &t in surface.as_slice() {
            let inst = self.core(def, t).is_installation;
            let ok = if !can_install {
                !inst
            } else if c.class.is_sub() {
                inst
            } else {
                true
            };
            if ok {
                targets.push(t);
            }
        }
        if targets.is_empty() {
            return;
        }
        let (t, covered) = self.choose_preferred(side, a, targets.as_slice(), true, 0);
        self.shell_attack(side, a, t, covered, None);
    }

    /// Artillery spotting chance (kcsim `ASchance`), 0 when not possible.
    fn as_chance(&self, side: usize, a: usize) -> f64 {
        let air = side_air(self.air, side);
        if !self.air_combat || air < 1 {
            return 0.0;
        }
        let c = self.core(side, a);
        if !can_as(c, &self.st[side][a]) {
            return 0.0;
        }
        // Each fleet of a combined fleet spots with its own fleet LoS.
        let base = if side == 0 && a >= self.fleets[0].escort_start { self.fleet_los_escort } else { self.fleet_los[side] };
        let fleet_los = (base.max(0.0).sqrt() + base * 0.1).floor();
        let luck_los = (c.luck.max(0.0).sqrt() + 10.0).floor();
        let mut chance = if air == 2 {
            (luck_los + 10.0 + 0.7 * (c.los_equip * 1.6 + fleet_los)).floor()
        } else {
            (luck_los + 0.6 * (c.los_equip * 1.2 + fleet_los)).floor()
        };
        if a == 0 {
            chance += 15.0;
        }
        chance * 0.01
    }

    /// One shelling attack; `special`: fleet special attack modifiers and event kind (no spotting roll).
    fn shell_attack(&mut self, side: usize, a: usize, d: usize, covered: bool, special: Option<(Special, SpecialAttack)>) {
        let def = 1 - side;
        let mut ci = None;
        let chance = if special.is_none() { self.as_chance(side, a) } else { 0.0 };
        if chance > 0.0 {
            let c = self.core(side, a);
            let target_inst = self.core(def, d).is_installation;
            for &k in &c.day_ci {
                if (k.is_cvci() && target_inst) || !ci_available(c, &self.st[side][a], k) {
                    continue;
                }
                if self.rng().chance(chance / k.data().chance) {
                    ci = Some(k);
                    break;
                }
            }
        }
        let sp = special.map(|s| s.0);
        let hits = if ci.is_some_and(|k| k.data().double) { 2 } else { 1 };
        let (acc, pow) = {
            let au = self.unit(side, a);
            let du = self.unit(def, d);
            (calc::shelling_acc(&au, &du, ci, sp), calc::shelling_power(&au, &du, self.eng, ci, sp))
        };
        let cutin = ci.is_some() || special.is_some();
        let event = special.map_or_else(|| day_ci_special(ci), |s| s.1);
        let ammo = self.unit(side, a).ammo_mod();
        let armor = self.core(def, d).ar;
        for _ in 0..hits {
            let roll = formulas::roll_hit(self.rng(), &acc.hc, acc.crit_dmg);
            let hp_before = self.st[def][d].hp;
            let dmg = match roll {
                Roll::Miss if cutin => formulas::scratch(self.rng(), hp_before),
                Roll::Miss => 0,
                _ => formulas::damage_common(self.rng(), pow, roll, armor, ammo, hp_before),
            };
            let real = self.take_damage(def, d, dmg);
            self.record(AttackKind::Shelling, event, side, a, d, covered, None, roll, real, hp_before, &acc.hc);
        }
    }

    /// kcsim `ASW`. `night_scratch`: night ASW in a day→night battle (power 0).
    pub(super) fn asw_attack(&mut self, side: usize, a: usize, d: usize, covered: bool, opening: bool, night_scratch: bool) {
        let def = 1 - side;
        let (acc, pow) = {
            let au: Unit = self.unit(side, a);
            let du = self.unit(def, d);
            (calc::asw_acc(&au, &du, opening), calc::asw_power(&au, self.eng, night_scratch, opening))
        };
        let roll = formulas::roll_hit(self.rng(), &acc.hc, acc.crit_dmg);
        let hp_before = self.st[def][d].hp;
        let mut real = 0;
        if roll != Roll::Miss {
            let armor = calc::effective_armor(self.core(side, a), self.core(def, d));
            let ammo = self.unit(side, a).ammo_mod();
            let dmg = formulas::damage_common(self.rng(), pow, roll, armor, ammo, hp_before);
            real = self.take_damage(def, d, dmg);
        }
        self.record(AttackKind::Asw, SpecialAttack::Normal, side, a, d, covered, None, roll, real, hp_before, &acc.hc);
    }
}
