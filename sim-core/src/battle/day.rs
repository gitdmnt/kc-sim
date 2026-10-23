//! Opening ASW and day shelling (rounds 1 and 2). Ported from kcsim `shellPhase`,
//! `shellPhaseTarget`, `shell`, `ASW`, `orderByRange` and kcships `canASW`, `canOASW`, `canShell`,
//! `canAS`, `ASchance` (KC3Kai/kancolle-replay, MIT © fourinone41).

use super::calc::{self, Unit};
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

/// Ship may take a turn in this shelling round (order construction).
pub fn can_shell(c: &ShipCore, st: &ShipState, opening: bool) -> bool {
    if st.hp <= 0 {
        return false;
    }
    if c.cv_like() {
        return opening
            || (0..MAX_SLOTS).any(|s| {
                c.slots[s].as_ref().is_some_and(|e| matches!(e.cat, cat::DIVE_BOMBER | cat::TORP_BOMBER | cat::JET_BOMBER)) && st.planes[s] > 0
            });
    }
    !c.class.is_sub()
}

/// Ship can still act when its turn comes (kcsim `canStillShell`).
pub fn can_still_shell(c: &ShipCore, st: &ShipState, opening: bool) -> bool {
    if st.hp <= 0 {
        return false;
    }
    if c.cv_like() && !opening {
        let limit = if c.class == ShipClass::CVB { 0.25 } else { 0.5 };
        return st.hp_ratio(c.max_hp) > limit;
    }
    true
}

/// Artillery spotting / CVCI possible right now (kcsim `canAS`).
fn can_as(c: &ShipCore, st: &ShipState) -> bool {
    if c.day_ci.is_empty() || st.hp_ratio(c.max_hp) <= 0.25 {
        return false;
    }
    if c.cv_like() {
        let has = |k: u32| (0..MAX_SLOTS).any(|s| c.slots[s].as_ref().is_some_and(|e| e.cat == k) && st.planes[s] > 0);
        return has(cat::DIVE_BOMBER) && has(cat::TORP_BOMBER);
    }
    c.has_planes(st, f::RECON)
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
            let mut l = List::default();
            for i in self.engaged(side) {
                if can_shell(self.core(side, i), &self.st[side][i], false) {
                    l.push(i);
                }
            }
            orders[side] = if second { l } else { self.order_by_range(side, l) };
        }
        self.shell_phase(orders, false);
    }

    fn shell_phase(&mut self, orders: [List; 2], opening: bool) {
        let n = orders[0].len().max(orders[1].len());
        for k in 0..n {
            for side in 0..2 {
                if k < orders[side].len() {
                    let a = orders[side].as_slice()[k];
                    if can_still_shell(self.core(side, a), &self.st[side][a], opening) {
                        self.shell_turn(side, a, opening);
                    }
                }
                if !self.any_alive(1 - side) {
                    return;
                }
            }
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
        let has_dive_planes = c.cv_like()
            && (0..MAX_SLOTS).any(|s| {
                c.slots[s].as_ref().is_some_and(|e| matches!(e.cat, cat::DIVE_BOMBER | cat::JET_BOMBER)) && self.st[side][a].planes[s] > 0
            });
        for &t in surface.as_slice() {
            let inst = self.core(def, t).is_installation;
            let ok = if has_dive_planes {
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
        let (t, covered) = self.choose_target(def, targets.as_slice(), 0);
        self.shell_attack(side, a, t, covered);
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

    fn shell_attack(&mut self, side: usize, a: usize, d: usize, covered: bool) {
        let def = 1 - side;
        let mut ci = None;
        let chance = self.as_chance(side, a);
        if chance > 0.0 {
            let c = self.core(side, a);
            let target_inst = self.core(def, d).is_installation;
            for &k in &c.day_ci {
                if k.is_cvci() && target_inst {
                    continue;
                }
                if self.rng().chance(chance / k.data().chance) {
                    ci = Some(k);
                    break;
                }
            }
        }
        let hits = if ci.is_some_and(|k| k.data().double) { 2 } else { 1 };
        let (acc, pow) = {
            let au = self.unit(side, a);
            let du = self.unit(def, d);
            (calc::shelling_acc(&au, &du, ci), calc::shelling_power(&au, &du, self.eng, ci))
        };
        let ammo = self.unit(side, a).ammo_mod();
        let armor = self.core(def, d).ar;
        for _ in 0..hits {
            let roll = formulas::roll_hit(self.rng(), &acc.hc, acc.crit_dmg);
            let hp_before = self.st[def][d].hp;
            let dmg = match roll {
                Roll::Miss if ci.is_some() => formulas::scratch(self.rng(), hp_before),
                Roll::Miss => 0,
                _ => formulas::damage_common(self.rng(), pow, roll, armor, ammo, hp_before),
            };
            let real = self.take_damage(def, d, dmg);
            self.record(AttackKind::Shelling, day_ci_special(ci), side, a, d, covered, None, roll, real, hp_before, &acc.hc);
        }
    }

    /// kcsim `ASW`. `night_scratch`: night ASW in a day→night battle (power 0).
    pub(super) fn asw_attack(&mut self, side: usize, a: usize, d: usize, covered: bool, opening: bool, night_scratch: bool) {
        let def = 1 - side;
        let (acc, pow) = {
            let au: Unit = self.unit(side, a);
            let du = self.unit(def, d);
            (calc::asw_acc(&au, &du, opening), calc::asw_power(&au, self.eng, night_scratch))
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
