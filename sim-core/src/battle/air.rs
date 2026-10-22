//! Air combat: fighter power → air state, stage 1 (fighter combat), stage 2 (AA fire, generic
//! AACI), contact, stage 3 (airstrikes). Ported from kcsim `compareAP`, `AADefenceFighters`,
//! `getAAShotProp`, `getAAShotFlat`, `getAACI`, `getContact`, `AADefenceBombersAndAirstrike`,
//! `airstrike` (KC3Kai/kancolle-replay, MIT © fourinone41).

use super::calc;
use super::{side_air, Battle, List};
use crate::equipment::f;
use crate::formulas::{self, Roll};
use crate::model::{AttackKind, SpecialAttack};
use crate::ship::{AACI_TABLE, MAX_SLOTS};

impl<'a> Battle<'a> {
    fn air_power(&self, side: usize) -> f64 {
        let mut ap = 0.0;
        for i in 0..self.len(side) {
            if !self.alive(side, i) {
                continue;
            }
            let c = self.core(side, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                let n = self.st[side][i].planes[s];
                if n <= 0 || !e.has(f::FIGHTER) {
                    continue;
                }
                ap += ((e.aa + e.aa_improve) * (n as f64).sqrt() + e.ap_bonus).floor();
            }
        }
        ap.floor()
    }

    fn has_fighter_slots(&self, side: usize) -> bool {
        (0..self.len(side)).any(|i| {
            self.alive(side, i) && {
                let c = self.core(side, i);
                (0..MAX_SLOTS).any(|s| c.slots[s].as_ref().is_some_and(|e| e.has(f::FIGHTER)) && self.st[side][i].planes[s] > 0)
            }
        })
    }

    /// `friend_excluded`: detection failed, the friend fleet does not take part in air combat.
    /// `friend_bombs`: false in air raids (friend fighters and AA only).
    pub(super) fn air_phase(&mut self, friend_excluded: bool, friend_bombs: bool) {
        let friend_has = !friend_excluded && self.has_fighter_slots(0);
        let enemy_has = self.has_fighter_slots(1);
        if !friend_has && !enemy_has {
            self.air_combat = false;
            self.air = 0;
            return;
        }
        self.air_combat = true;
        let ap1 = if friend_excluded { 0.0 } else { self.air_power(0) };
        let ap2 = self.air_power(1);
        self.air = if ap1 >= ap2 * 3.0 {
            2
        } else if ap1 >= ap2 * 1.5 {
            1
        } else if ap2 >= ap1 * 3.0 {
            -2
        } else if ap2 >= ap1 * 1.5 {
            -1
        } else {
            0
        };
        // Carriers: ships afloat at the start of the phase (both sides launch simultaneously).
        let mut carriers = [List::default(), List::default()];
        for side in 0..2 {
            if side == 0 && friend_excluded {
                continue;
            }
            for i in 0..self.len(side) {
                if self.alive(side, i) {
                    carriers[side].push(i);
                }
            }
        }
        self.stage1(0, carriers[0]);
        self.stage1(1, carriers[1]);
        if !friend_excluded && friend_bombs {
            self.stage23(0, carriers[0]);
        }
        self.stage23(1, carriers[1]);
    }

    fn stage1(&mut self, side: usize, carriers: List) {
        let air = side_air(self.air, side);
        for &i in carriers.as_slice() {
            let c = self.core(side, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                if !e.has(f::FIGHTER) {
                    continue;
                }
                let n = self.st[side][i].planes[s];
                if n <= 0 {
                    continue;
                }
                let lost = if side == 0 {
                    let (rmin, rplus) = match air {
                        2 => (0.025, 0.0333),
                        1 => (0.075, 0.1),
                        0 => (0.125, 0.1666),
                        -1 => (0.175, 0.2333),
                        _ => (0.25, 0.3333),
                    };
                    let randplus = self.rng().floor_mul((1000.0f64 * rplus).floor() + 1.0) / 1000.0;
                    let mut m = if e.has(f::JET) { 0.6 } else { 1.0 };
                    if e.has(f::AUTOGYRO_LIKE) {
                        m = match air {
                            -2 => 0.9,
                            -1 => 0.5,
                            _ => 0.3,
                        };
                    }
                    (n as f64 * (rmin + randplus) * m).floor() as i32
                } else {
                    let rmax = match air {
                        2 => 2.0,
                        1 => 5.0,
                        0 => 7.0,
                        -1 => 9.0,
                        _ => 11.0,
                    };
                    let m = self.rng().floor_mul(rmax) * 0.35 + self.rng().floor_mul(rmax) * 0.65;
                    let jet = if e.has(f::JET) { 0.6 } else { 1.0 };
                    (n as f64 * m * jet / 10.0).floor() as i32
                };
                let st = &mut self.st[side][i];
                st.planes[s] = (n - lost).max(0);
                if st.planes[s] == 0 {
                    st.exp[s] = 0.0;
                }
            }
        }
    }

    /// Fixed AA shot-down of the defending side's AACI roll: (fixed count, multiplier).
    fn roll_aaci(&mut self, def_side: usize) -> (i32, f64) {
        if !self.fleets[def_side].is_player {
            return (0, 1.0);
        }
        let mut best: Option<usize> = None;
        for i in 0..self.len(def_side) {
            if !self.alive(def_side, i) {
                continue;
            }
            let kinds = &self.core(def_side, i).aaci;
            for &k in kinds {
                let Some(pri) = AACI_TABLE.iter().position(|t| t.0 == k) else { continue };
                if best.is_none_or(|b| pri < b) && self.rng().chance(AACI_TABLE[pri].3) {
                    best = Some(pri);
                }
            }
        }
        match best {
            Some(p) => (AACI_TABLE[p].1, AACI_TABLE[p].2),
            None => (0, 1.0),
        }
    }

    /// kcsim `getContact`: contact multiplier for the attacking side.
    fn roll_contact(&mut self, att_side: usize, carriers: List) -> f64 {
        let air = side_air(self.air, att_side);
        let mut los_power = 1.0;
        for &i in carriers.as_slice() {
            let c = self.core(att_side, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                if e.has(f::CAN_CONTACT) && e.los > 0.0 && !e.has(f::TORP_BOMBER) {
                    los_power += ((self.st[att_side][i].planes[s].max(0) as f64).sqrt() * e.los).floor();
                }
            }
        }
        let (chance, cmod) = match air {
            2 => (los_power / 25.0, 14.0),
            1 => (los_power / 40.0, 16.0),
            _ => (los_power / 55.0, 18.0),
        };
        if !self.rng().chance(chance) {
            return 1.0;
        }
        let mut contact: Option<f64> = None;
        for &i in carriers.as_slice() {
            let c = self.core(att_side, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                if !e.has(f::CAN_CONTACT) || e.los <= 0.0 {
                    continue;
                }
                if contact.is_some_and(|acc| acc >= e.acc) {
                    continue;
                }
                if self.rng().chance(e.los / cmod) {
                    contact = Some(e.acc);
                }
            }
        }
        match contact {
            Some(a) if a >= 3.0 => 1.2,
            Some(a) if a >= 2.0 => 1.17,
            Some(_) => 1.12,
            None => 1.0,
        }
    }

    fn stage23(&mut self, att_side: usize, carriers: List) {
        let def_side = 1 - att_side;
        let mut bombers: Vec<(usize, usize)> = Vec::new();
        for &i in carriers.as_slice() {
            let c = self.core(att_side, i);
            for s in 0..MAX_SLOTS {
                if c.slots[s].as_ref().is_some_and(|e| e.has(f::BOMBER)) && self.st[att_side][i].planes[s] > 0 {
                    bombers.push((i, s));
                }
            }
        }
        if bombers.is_empty() {
            return;
        }
        let (aaci_num, aaci_mod) = self.roll_aaci(def_side);
        let air = side_air(self.air, att_side);
        let contact = if air != -2 && air != 0 { self.roll_contact(att_side, carriers) } else { 1.0 };
        let mut defenders = List::default();
        for i in 0..self.len(def_side) {
            if self.alive(def_side, i) {
                defenders.push(i);
            }
        }
        let targets = self.surface(def_side);
        let def_player = self.fleets[def_side].is_player;
        let fleet_aa = if def_player { (self.fleet_aa[def_side] / 1.3).floor() } else { self.fleet_aa[def_side] };
        let flat_mod = if def_player { 0.2 } else { 0.1875 };
        let mut attacks: Vec<(usize, usize, usize, bool)> = Vec::new();
        for (i, s) in bombers {
            if !defenders.is_empty() {
                let d = defenders.as_slice()[self.rng().below(defenders.len())];
                let waa = self.core(def_side, d).weighted_aa;
                let n = self.st[att_side][i].planes[s];
                let prop = if self.rng().chance(0.5) { (n as f64 * waa / 200.0).floor() as i32 } else { 0 };
                let flat = if self.rng().chance(0.5) { ((waa + fleet_aa) * flat_mod * aaci_mod).floor() as i32 } else { 0 };
                let fix = if def_player || aaci_num > 0 { 1 } else { 0 } + aaci_num;
                let st = &mut self.st[att_side][i];
                st.planes[s] = (n - prop - flat - fix).max(0);
                if st.planes[s] <= 0 {
                    st.exp[s] = 0.0;
                    continue;
                }
            }
            if !targets.is_empty() {
                let (t, covered) = self.choose_target(def_side, targets.as_slice(), 0);
                attacks.push((i, s, t, covered));
            }
        }
        for (i, s, t, covered) in attacks {
            self.airstrike(att_side, i, s, t, covered, contact);
        }
    }

    fn airstrike(&mut self, att_side: usize, a: usize, slot: usize, d: usize, covered: bool, contact: f64) {
        let def_side = 1 - att_side;
        let acc = calc::air_acc(&self.unit(att_side, a), &self.unit(def_side, d));
        let roll = formulas::roll_hit(self.rng(), &acc.hc, acc.crit_dmg);
        let hp_before = self.st[def_side][d].hp;
        let mut real = 0;
        if roll != Roll::Miss {
            let att = self.core(att_side, a);
            let def = self.core(def_side, d);
            let (_, dive) = calc::air_plane_base(att, slot, def);
            let mult = if dive {
                1.0
            } else if self.rng().chance(0.5) {
                0.8
            } else {
                1.5
            };
            let pow = calc::air_power(att, slot, self.st[att_side][a].planes[slot], def, mult, contact);
            let ammo = self.unit(att_side, a).ammo_mod();
            let dmg = formulas::damage_common(self.rng(), pow, roll, def.ar, ammo, hp_before);
            real = self.take_damage(def_side, d, dmg);
        }
        self.record(AttackKind::Air, SpecialAttack::Normal, att_side, a, d, covered, Some(slot), roll, real, hp_before, &acc.hc);
    }
}
