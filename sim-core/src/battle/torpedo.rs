//! Opening and closing torpedo salvos (kcsim `torpedoPhase`, KC3Kai/kancolle-replay,
//! MIT © fourinone41). All targets and attack powers are fixed before any torpedo lands.
//! The main fleet of a combined fleet never fires torpedoes, except the opening torpedo of
//! kcSHIPDATA `canOpTorpMain` abyssals. Against an enemy combined fleet (`combinedAll`) a
//! closing-torpedo shot at a combined side picks its main fleet with 35%, else its escort (en wiki
//! Shooting Order and Targeting: closing torpedo 35% / 65%).

use super::calc;
use super::{Battle, List};
use crate::formulas::{self, Roll};
use crate::model::{AttackKind, Formation, SpecialAttack};
use crate::ship::{ShipCore, ShipState};

/// Opening torpedo: a midget sub, a submarine from level 10, or an abyssal that fires one by
/// itself (kcSHIPDATA `canOpTorp`) — the latter not from a diamond formation: the KCNav packets
/// show 駆逐ラ級 firing in 225 of 226 battles in other formations and in none of 105 in diamond
/// [inference: rule or node design].
fn can_open_torp(c: &ShipCore, st: &ShipState, form: Formation) -> bool {
    st.hp > 0
        && (c.has_midget_sub
            || (c.opening_torpedo && form != Formation::Diamond)
            || (c.class.is_sub() && c.level >= 10.0 && !c.no_opening_torpedo))
}

fn can_close_torp(c: &ShipCore, st: &ShipState) -> bool {
    st.hp > 0 && c.has_torp_stat && st.hp_ratio(c.max_hp) > 0.5
}

impl<'a> Battle<'a> {
    pub(super) fn torpedo_phase(&mut self, opening: bool) {
        let mut targets = [List::default(), List::default()];
        for side in 0..2 {
            for &i in self.surface(side).as_slice() {
                if !self.core(side, i).is_installation {
                    targets[side].push(i);
                }
            }
        }
        // (side, attacker, target, covered, power)
        let mut shots: Vec<(usize, usize, usize, bool, f64)> = Vec::with_capacity(14);
        for side in 0..2 {
            let def = 1 - side;
            if targets[def].is_empty() {
                continue;
            }
            // Closing salvo vs a combined side: main / escort target pools.
            let des = self.fleets[def].escort_start;
            let mut pools = [List::default(), List::default()];
            if self.ecombined && !opening && self.has_escort(def) {
                for &t in targets[def].as_slice() {
                    pools[(t >= des) as usize].push(t);
                }
            }
            let split = !pools[0].is_empty() && !pools[1].is_empty();
            // Main-fleet ships of a combined side do not fire.
            let att_main_end = if self.has_escort(side) { self.fleets[side].escort_start } else { 0 };
            let order = {
                let mut l = self.surface(side);
                for &s in self.subs(side).as_slice() {
                    l.push(s);
                }
                l
            };
            // kcsim `torpedoPhase` with `useAtoll`: at an atoll node the friend opening salvo is the
            // anti-atoll ships' amphibious tanks, one shot each (submarines from level 10), nothing else.
            let atoll = opening && side == 0 && self.setup.atoll;
            for &a in order.as_slice() {
                let c = self.core(side, a);
                let st = &self.st[side][a];
                let shots_of = if atoll {
                    if st.hp > 0 && (!c.class.is_sub() || c.level >= 10.0) { c.atoll_attacks } else { 0 }
                } else {
                    (if opening { can_open_torp(c, st, self.setup.formations[side]) } else { can_close_torp(c, st) }) as u8
                };
                if shots_of == 0 || (a < att_main_end && !(opening && c.opening_torpedo_main)) {
                    continue;
                }
                let ratio = st.hp_ratio(c.max_hp);
                let power = calc::torpedo_power(&self.unit(side, a), self.eng, ratio);
                for _ in 0..shots_of {
                    let cands = if !split {
                        targets[def]
                    } else if self.rng().chance(0.35) {
                        pools[0]
                    } else {
                        pools[1]
                    };
                    let (t, covered) = self.choose_target(def, cands.as_slice(), 0);
                    shots.push((side, a, t, covered, power));
                }
            }
        }
        for (side, a, d, covered, power) in shots {
            let def = 1 - side;
            let acc = calc::torpedo_acc(&self.unit(side, a), &self.unit(def, d), power);
            let roll = formulas::roll_hit(self.rng(), &acc.hc, 1.0);
            let hp_before = self.st[def][d].hp;
            let mut real = 0;
            if roll != Roll::Miss {
                let ammo = self.unit(side, a).ammo_mod();
                let armor = self.core(def, d).ar;
                // kcsim `torpedoPhase` `postMod`: the attacker's event bonus (before the PT transform).
                let power = self.unit(side, a).bonus_dmg(power, || false);
                let pow = calc::torpedo_target_power(self.core(side, a), self.core(def, d), power);
                let dmg = formulas::damage_common(self.rng(), pow, roll, armor, ammo, hp_before);
                real = self.take_damage(def, d, dmg);
            }
            self.record(AttackKind::Torpedo, SpecialAttack::Normal, side, a, d, covered, None, roll, real, hp_before, &acc.hc);
        }
    }
}
