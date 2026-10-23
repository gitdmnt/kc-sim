//! Air combat: fighter power → air state, stage 1 (fighter combat), stage 2 (AA fire, AACI of
//! both sides, plane AA resistance), contact, rocket barrage, stage 3 (airstrikes). Ported from
//! kcsim `compareAP`, `AADefenceFighters`, `getAAShotProp`, `getAAShotFlat`, `getAACI`,
//! `getContact`, `AADefenceBombersAndAirstrike`, `airstrike` and kcships `rocketBarrageChance`
//! (KC3Kai/kancolle-replay, MIT © fourinone41).
//!
//! Friend combined fleet vs a single enemy (kcsimcombined `simCombined` → `compareAP(F1,F2)`,
//! `airPhase(alive1.concat(alive1C), …)` without `includeEscort`): only the main fleet's planes
//! count for fighter power and launch; enemy planes target and are shot at by both fleets, with
//! the combined-fleet AA multipliers (escort ×0.48, main ×0.8 / ×0.72 in air raids).

use super::calc;
use super::{side_air, Battle, List};
use crate::equipment::{f, Equip};
use crate::formulas::{self, Roll};
use crate::model::{AirDefenseEvent, AttackKind, BattleKind, Side, SpecialAttack};
use crate::rng::Rng;
use crate::aaci::{priority, AACI_TABLE};
use crate::ship::MAX_SLOTS;

/// Friend plane loss in fighter combat (kcsim `AADefenceFighters`, side 0) for `n` planes at
/// friend air state `air`, multiplier `m` (jets 0.6).
pub(super) fn friend_fighter_loss(rng: &mut Rng, n: i32, air: i8, m: f64) -> i32 {
    let (rmin, rplus) = match air {
        2 => (0.025, 0.0333),
        1 => (0.075, 0.1),
        0 => (0.125, 0.1666),
        -1 => (0.175, 0.2333),
        _ => (0.25, 0.3333),
    };
    let randplus = rng.floor_mul((1000.0f64 * rplus).floor() + 1.0) / 1000.0;
    (n as f64 * (rmin + randplus) * m).floor() as i32
}

/// kcsim `getContact` over (equipment, planes) of the attacking side: contact multiplier, if any.
pub(super) fn contact_roll<'e, I>(rng: &mut Rng, air: i8, items: I) -> Option<f64>
where
    I: Iterator<Item = (&'e Equip, i32)> + Clone,
{
    let mut los_power = 1.0;
    for (e, planes) in items.clone() {
        if e.has(f::CAN_CONTACT) && e.los > 0.0 && !e.has(f::TORP_BOMBER) {
            los_power += ((planes.max(0) as f64).sqrt() * e.los).floor();
        }
    }
    let (chance, cmod) = match air {
        2 => (los_power / 25.0, 14.0),
        1 => (los_power / 40.0, 16.0),
        _ => (los_power / 55.0, 18.0),
    };
    if !rng.chance(chance) {
        return None;
    }
    let mut contact: Option<f64> = None;
    for (e, _) in items {
        if !e.has(f::CAN_CONTACT) || e.los <= 0.0 {
            continue;
        }
        if contact.is_some_and(|acc| acc >= e.acc) {
            continue;
        }
        if rng.chance(e.los / cmod) {
            contact = Some(e.acc);
        }
    }
    contact.map(|a| if a >= 3.0 { 1.2 } else if a >= 2.0 { 1.17 } else { 1.12 })
}

impl<'a> Battle<'a> {
    /// Ships `0..n` of `side` whose planes fight in the air phase: a combined friend fleet's main
    /// fleet only.
    fn air_fleet_end(&self, side: usize) -> usize {
        self.fleets[side].escort_start
    }

    fn air_power(&self, side: usize) -> f64 {
        let mut ap = 0.0;
        for i in 0..self.air_fleet_end(side) {
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
        (0..self.air_fleet_end(side)).any(|i| {
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
            for i in 0..self.air_fleet_end(side) {
                if self.alive(side, i) {
                    carriers[side].push(i);
                }
            }
        }
        let air = self.air;
        self.fighter_losses(0, carriers[0], f::FIGHTER, air);
        self.fighter_losses(1, carriers[1], f::FIGHTER, -air);
        if !friend_excluded && friend_bombs {
            self.stage23(0, carriers[0]);
        }
        self.stage23(1, carriers[1]);
    }

    /// Stage 1 losses of `side`'s `carriers` slots matching `filter`, at `side`'s air state `air`.
    pub(super) fn fighter_losses(&mut self, side: usize, carriers: List, filter: u64, air: i8) {
        for &i in carriers.as_slice() {
            let c = self.core(side, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                if !e.has(filter) {
                    continue;
                }
                let n = self.st[side][i].planes[s];
                if n <= 0 {
                    continue;
                }
                let lost = if side == 0 {
                    let mut m = if e.has(f::JET) { 0.6 } else { 1.0 };
                    if filter == f::FIGHTER && e.has(f::AUTOGYRO_LIKE) {
                        m = match air {
                            -2 => 0.9,
                            -1 => 0.5,
                            _ => 0.3,
                        };
                    }
                    friend_fighter_loss(self.rng(), n, air, m)
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

    /// kcsim `getAACI` (multi-roll, `aaciMultiRoll`): every afloat defender rolls each of its AACI
    /// kinds independently; the success with the best priority fires. Returns (table index, ship).
    fn roll_aaci(&mut self, def_side: usize) -> Option<(usize, usize)> {
        let mut best: Option<(usize, usize)> = None;
        for i in 0..self.len(def_side) {
            if !self.alive(def_side, i) {
                continue;
            }
            let kinds = &self.core(def_side, i).aaci;
            for &k in kinds {
                let Some(pri) = priority(k) else { continue };
                if best.is_none_or(|b| pri < b.0) && self.rng().chance(AACI_TABLE[pri].3) {
                    best = Some((pri, i));
                }
            }
        }
        best
    }

    fn log_air(&mut self, def_side: usize, ship: usize, aaci: Option<u8>, rocket_barrage: bool) {
        let phase = self.phase;
        if let Some(ev) = self.air_events.as_mut() {
            ev.push(AirDefenseEvent { phase, side: if def_side == 0 { Side::Friend } else { Side::Enemy }, ship, aaci, rocket_barrage });
        }
    }

    /// kcships `rocketBarrageChance` (CAV / BBV / carriers / AV with the 12cm 30-tube rocket
    /// launcher Kai 2): `(2·wAA + 0.9·luck) / (400 − (48 + 30 + 40·n + 70·[Ise class]))`
    /// [unverified: wikiwiki gives `(加重対空 + 運)/282 + 15%·(n − 1) + 25%·[Ise class]`].
    fn rocket_barrage_chance(&self, side: usize, i: usize) -> f64 {
        let c = self.core(side, i);
        if c.rocket_barrage == 0 {
            return 0.0;
        }
        let class_bonus = if c.ship_class == 2 { 70.0 } else { 0.0 };
        (2.0 * c.weighted_aa + 0.9 * c.luck) / (400.0 - (48.0 + 30.0 + 40.0 * c.rocket_barrage as f64 + class_bonus))
    }

    /// kcsim `getContact`: contact multiplier for the attacking side.
    fn roll_contact(&mut self, att_side: usize, carriers: List) -> f64 {
        let air = side_air(self.air, att_side);
        let fl = self.fleets[att_side];
        let st = &self.st[att_side];
        let items = carriers.as_slice().iter().flat_map(|&i| {
            let c = &fl.ships[i];
            (0..MAX_SLOTS).filter_map(move |s| c.slots[s].as_ref().map(|e| (e, st[i].planes[s])))
        });
        contact_roll(self.rng, air, items).unwrap_or(1.0)
    }

    /// kcsim `getAAShotProp` / `getAAShotFlat` multiplier of a defender in a friend combined fleet
    /// (`isRaid` lowers the main fleet's from 0.8 to 0.72).
    fn combined_aa_mod(&self, def_side: usize, d: usize) -> f64 {
        if def_side != 0 || self.combined.is_none() {
            1.0
        } else if d >= self.fleets[0].escort_start {
            0.48
        } else if self.setup.kind == BattleKind::AirRaid {
            0.72
        } else {
            0.8
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
        let aaci = self.roll_aaci(def_side);
        if let Some((p, ship)) = aaci {
            self.log_air(def_side, ship, Some(AACI_TABLE[p].0), false);
        }
        let (aaci_num, aaci_mod, aaci_num1) = aaci.map_or((0, 1.0, 0), |(p, _)| (AACI_TABLE[p].1, AACI_TABLE[p].2, AACI_TABLE[p].4));
        let air = side_air(self.air, att_side);
        let mut contact = if air != -2 && air != 0 { self.roll_contact(att_side, carriers) } else { 1.0 };
        // kcsim `AADefenceBombersAndAirstrike`: own balloons +2 % each, the target fleet's −5 % each.
        contact *= (1.0 + self.balloons(att_side) as f64 / 50.0) * (1.0 - self.balloons(def_side) as f64 / 20.0);
        let targets = self.surface(def_side);
        // Rocket barrage: a triggered ship evades every airstrike of this phase.
        let mut barrage = List::default();
        for &t in targets.as_slice() {
            let chance = self.rocket_barrage_chance(def_side, t);
            if chance > 0.0 && self.rng().chance(chance) {
                barrage.push(t);
                self.log_air(def_side, t, None, true);
            }
        }
        let mut defenders = List::default();
        for i in 0..self.len(def_side) {
            if self.alive(def_side, i) {
                defenders.push(i);
            }
        }
        let def_player = self.fleets[def_side].is_player;
        let flat_mod = if def_player { 0.2 } else { 0.1875 };
        let mut attacks: Vec<(usize, usize, usize, bool)> = Vec::new();
        for (i, s) in bombers {
            if !defenders.is_empty() {
                let d = defenders.as_slice()[self.rng().below(defenders.len())];
                let cfm = self.combined_aa_mod(def_side, d);
                let waa = self.core(def_side, d).weighted_aa;
                // kcEQDATA `aaResistShip` / `aaResistFleet` (1 = none).
                let (rs, rf) = self.core(att_side, i).slots[s].as_ref().map_or((1.0, 1.0), |e| (e.aa_resist_ship, e.aa_resist_fleet));
                let n = self.st[att_side][i].planes[s];
                let prop = if self.rng().chance(0.5) {
                    let saa = if rs != 1.0 { (waa * rs).floor() } else { waa };
                    (n as f64 * saa * cfm / 200.0).floor() as i32
                } else {
                    0
                };
                let flat = if self.rng().chance(0.5) {
                    let saa = (waa * rs).floor();
                    let mut faa = (self.fleet_aa[def_side] * rf).floor();
                    if def_player {
                        faa = (faa / 1.3).floor();
                    }
                    ((saa + faa) * cfm * flat_mod * aaci_mod).floor() as i32
                } else {
                    0
                };
                let mut fix = if def_player || aaci_num > 0 { 1 } else { 0 } + aaci_num;
                // kcsim `aaResist`: planes resisting both keep 60% of the AACI part `num1` (ship
                // resistance ≤ 0.5: 3 fewer).
                if rs != 1.0 && rf != 1.0 && fix > 0 {
                    let (n1, n2) = if aaci_num > 0 { (aaci_num1, fix - aaci_num1) } else { (fix, 0) };
                    fix = if rs <= 0.5 { (fix - 3).max(0) } else { (n1 as f64 * 0.6 + n2 as f64).floor() as i32 };
                }
                let st = &mut self.st[att_side][i];
                st.planes[s] = (n - prop - flat - fix).max(0);
                if st.planes[s] <= 0 {
                    st.exp[s] = 0.0;
                    continue;
                }
            }
            if !targets.is_empty() {
                let (t, covered) = self.choose_target(def_side, targets.as_slice(), 0);
                if !barrage.as_slice().contains(&t) {
                    attacks.push((i, s, t, covered));
                }
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
            let base = calc::AIR_BASE + self.unit(def_side, d).cf.air_pow;
            let mut pow = calc::air_power(att, slot, self.st[att_side][a].planes[slot], def, mult, contact, base);
            let (p, hi, lo) = calc::air_target_mod(att, slot, def);
            if hi != 1.0 || lo != 1.0 {
                pow *= if p >= 1.0 || self.rng().chance(p) { hi } else { lo };
            }
            // kcsim `airstrike` `postMod`: the attacker's event bonus (every plane group counts).
            pow = self.unit(att_side, a).bonus_dmg(pow, || true);
            let ammo = self.unit(att_side, a).ammo_mod();
            let dmg = formulas::damage_common(self.rng(), pow, roll, def.ar, ammo, hp_before);
            real = self.take_damage(def_side, d, dmg);
        }
        self.record(AttackKind::Air, SpecialAttack::Normal, att_side, a, d, covered, Some(slot), roll, real, hp_before, &acc.hc);
    }
}
