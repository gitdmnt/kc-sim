//! Night battle (kcsim `nightPhase`, `nightPhaseTarget`, `NBattack`, `getNightEquipsScout`; fleet
//! special attacks and night Zuiun cut-ins via `canSpecialAttack`), KC3Kai/kancolle-replay,
//! MIT © fourinone41.

use super::calc::{self, NightAttack, NightEnv, Special};
use super::day::can_asw_night;
use super::special::Fsa;
use super::{side_air, Battle, List};
use crate::equipment::f;
use crate::formulas::{self, Roll};
use crate::model::{AttackKind, Phase, SpecialAttack};
use crate::ship::{NightCi, ShipCore, ShipState, MAX_SLOTS};

pub fn can_night(c: &ShipCore, st: &ShipState) -> bool {
    if c.class.is_carrier() {
        return (c.night_attacker && st.hp_ratio(c.max_hp) > 0.25) || c.can_night_air(st);
    }
    st.hp_ratio(c.max_hp) > 0.25
}

pub fn night_special(na: NightAttack) -> SpecialAttack {
    match (na.ci, na.double_variant) {
        (None, _) => SpecialAttack::Normal,
        (Some(NightCi::DoubleAttack), _) => SpecialAttack::NightDoubleAttack,
        (Some(NightCi::Mixed), _) => SpecialAttack::NightCutinMixed,
        (Some(NightCi::Torpedo), _) => SpecialAttack::NightCutinTorpedo,
        (Some(NightCi::GunSec), _) => SpecialAttack::NightCutinGunSecondary,
        (Some(NightCi::GunMain), _) => SpecialAttack::NightCutinGunMain,
        (Some(NightCi::DdGtr), false) => SpecialAttack::DdciGunTorpRadar,
        (Some(NightCi::DdGtr), true) => SpecialAttack::DdciGunTorpRadarDouble,
        (Some(NightCi::DdLtr), false) => SpecialAttack::DdciLookoutTorpRadar,
        (Some(NightCi::DdLtr), true) => SpecialAttack::DdciLookoutTorpRadarDouble,
        (Some(NightCi::DdTtl), false) => SpecialAttack::DdciTorpLookoutTorp,
        (Some(NightCi::DdTtl), true) => SpecialAttack::DdciTorpLookoutTorpDouble,
        (Some(NightCi::DdTdl), false) => SpecialAttack::DdciTorpLookoutDrum,
        (Some(NightCi::DdTdl), true) => SpecialAttack::DdciTorpLookoutDrumDouble,
        (Some(NightCi::CvFfa), _) => SpecialAttack::NightCvciFfa,
        (Some(NightCi::CvFa), _) => SpecialAttack::NightCvciFa,
        (Some(NightCi::CvBomber), _) => SpecialAttack::NightCvciBomber,
        (Some(NightCi::CvFOther), _) => SpecialAttack::NightCvciFOther,
    }
}

pub fn special_night(s: SpecialAttack) -> NightAttack {
    let (ci, double_variant) = match s {
        SpecialAttack::NightDoubleAttack => (Some(NightCi::DoubleAttack), false),
        SpecialAttack::NightCutinMixed => (Some(NightCi::Mixed), false),
        SpecialAttack::NightCutinTorpedo => (Some(NightCi::Torpedo), false),
        SpecialAttack::NightCutinGunSecondary => (Some(NightCi::GunSec), false),
        SpecialAttack::NightCutinGunMain => (Some(NightCi::GunMain), false),
        SpecialAttack::DdciGunTorpRadar => (Some(NightCi::DdGtr), false),
        SpecialAttack::DdciGunTorpRadarDouble => (Some(NightCi::DdGtr), true),
        SpecialAttack::DdciLookoutTorpRadar => (Some(NightCi::DdLtr), false),
        SpecialAttack::DdciLookoutTorpRadarDouble => (Some(NightCi::DdLtr), true),
        SpecialAttack::DdciTorpLookoutTorp => (Some(NightCi::DdTtl), false),
        SpecialAttack::DdciTorpLookoutTorpDouble => (Some(NightCi::DdTtl), true),
        SpecialAttack::DdciTorpLookoutDrum => (Some(NightCi::DdTdl), false),
        SpecialAttack::DdciTorpLookoutDrumDouble => (Some(NightCi::DdTdl), true),
        SpecialAttack::NightCvciFfa => (Some(NightCi::CvFfa), false),
        SpecialAttack::NightCvciFa => (Some(NightCi::CvFa), false),
        SpecialAttack::NightCvciBomber => (Some(NightCi::CvBomber), false),
        SpecialAttack::NightCvciFOther => (Some(NightCi::CvFOther), false),
        _ => (None, false),
    };
    NightAttack { ci, double_variant }
}

#[derive(Clone, Copy, Default)]
struct SideNight {
    starshell: bool,
    searchlight: u8,
    contact: Option<f64>,
}

fn env(sides: &[SideNight; 2], side: usize) -> NightEnv {
    NightEnv {
        own_starshell: sides[side].starshell,
        enemy_starshell: sides[1 - side].starshell,
        own_searchlight: sides[side].searchlight > 0,
        enemy_searchlight: sides[1 - side].searchlight > 0,
        contact_acc: sides[side].contact,
    }
}

impl<'a> Battle<'a> {
    fn night_setup(&mut self, side: usize, night_only: bool) -> SideNight {
        let mut s = SideNight::default();
        // Star shell: each equipping ship in order, 71% unless HP ≤ 4 (wikiwiki 照明弾; kcsim 70%).
        for i in self.engaged(side) {
            let (c, st) = (self.core(side, i), &self.st[side][i]);
            if c.has_starshell && st.hp > 4 && self.rng().chance(0.71) {
                s.starshell = true;
                break;
            }
        }
        for i in self.engaged(side) {
            if self.alive(side, i) {
                s.searchlight = s.searchlight.max(self.core(side, i).searchlight);
            }
        }
        let air = if self.air_combat { side_air(self.air, side) } else { 0 };
        if self.any_alive(side) && air != -2 && (night_only || air != 0) {
            // kcsim `getNightEquipsScout(fleet.ships)`: the night fleet's own ships.
            for i in self.engaged(side) {
                let c = self.core(side, i);
                for slot in 0..MAX_SLOTS {
                    let Some(e) = c.slots[slot].as_ref() else { continue };
                    if !e.has(f::NIGHT_SCOUT) {
                        continue;
                    }
                    if s.contact.is_some_and(|a| e.acc <= a) {
                        continue;
                    }
                    let p = (c.level.sqrt() * e.los.max(0.0).sqrt()).floor() / 25.0;
                    if self.rng().chance(p) {
                        s.contact = Some(e.acc);
                    }
                }
            }
        }
        s
    }

    /// Night battle; a combined friend fleet fights with its escort (kcsimcombined `simCombined`).
    pub(super) fn night_phase(&mut self, night_only: bool) {
        self.phase = Phase::Night;
        self.engaged[0] = self.night_range();
        let mut sides = [self.night_setup(0, night_only), self.night_setup(1, night_only)];
        let ranges = [self.engaged(0), self.engaged(1)];
        let n = ranges[0].len().max(ranges[1].len());
        'rounds: for k in 0..n {
            for side in 0..2 {
                let a = ranges[side].start + k;
                if a < ranges[side].end && can_night(self.core(side, a), &self.st[side][a]) {
                    let cand = side == 0 && (a == ranges[0].start || self.core(0, a).night_zuiun);
                    let special = if cand && !self.surface(1).is_empty() { self.night_special_roll(a, ranges[0].start, &sides) } else { None };
                    match special {
                        Some((kind, attackers)) => self.special_night_attack(kind, ranges[0].start, attackers, &mut sides),
                        None => {
                            let env = env(&sides, side);
                            self.night_turn(side, a, &env, sides[1 - side].searchlight, night_only);
                        }
                    }
                }
                if !self.any_alive(1 - side) {
                    break 'rounds;
                }
            }
        }
        self.engaged[0] = (0, self.len(0));
    }

    /// kcsim `canSpecialAttack(ship, isNB)` for friend ship `a` (night fleet flagship `flag`): a
    /// fleet special attack on the flagship's turn, else a night Zuiun cut-in.
    fn night_special_roll(&mut self, a: usize, flag: usize, sides: &[SideNight; 2]) -> Option<(Fsa, List)> {
        if a == flag {
            if let Some(s) = self.try_fleet_special(true, flag) {
                return Some(s);
            }
        }
        if !self.core(0, a).night_zuiun {
            return None;
        }
        let e = env(sides, 0);
        let mut chance = self.core(0, a).nb_chance_base + if self.is_flagship(0, a) { 15.0 } else { 0.0 };
        chance += 4.0 * e.own_starshell as u8 as f64 - 10.0 * e.enemy_starshell as u8 as f64;
        chance += 7.0 * e.own_searchlight as u8 as f64 - 5.0 * e.enemy_searchlight as u8 as f64;
        let kind = self.try_night_zuiun(a, chance, e.own_starshell, e.own_searchlight)?;
        let mut l = List::default();
        l.push(a);
        l.push(a);
        Some((kind, l))
    }

    /// Special attack at night: each attacker makes a night attack on a surface target with the
    /// special modifiers (kcsim `nightPhase` special branch + `NBattack(…, attackSpecial)`). A night
    /// Zuiun cut-in lights the enemy like an own star shell for the rest of the battle.
    fn special_night_attack(&mut self, kind: Fsa, flag: usize, attackers: List, sides: &mut [SideNight; 2]) {
        for &a in attackers.as_slice() {
            let targets = self.surface(1);
            if targets.is_empty() {
                break;
            }
            // Attackers that cannot attack at night sit out, except in Nelson Touch (kcsim `NBattack`).
            if !self.alive(0, a) || (!can_night(self.core(0, a), &self.st[0][a]) && kind != Fsa::Nelson) {
                continue;
            }
            let (t, covered) = self.choose_preferred(0, a, targets.as_slice(), false, sides[1].searchlight);
            if matches!(kind, Fsa::NightZuiun(_)) {
                sides[0].starshell = true;
            }
            let e = env(sides, 0);
            let sp = self.special_mods(kind, flag, a);
            self.night_attack(0, a, t, covered, &e, Some((sp, kind.event())));
        }
    }

    fn night_turn(&mut self, side: usize, a: usize, env: &NightEnv, sl_rerolls: u8, night_only: bool) {
        let def = 1 - side;
        let subs = self.subs(def);
        let surface = self.surface(def);
        let c = self.core(side, a);
        let air = c.can_night_air(&self.st[side][a]);
        if !subs.is_empty() && can_asw_night(c, &self.st[side][a]) && (!air || surface.is_empty()) {
            let (t, covered) = self.choose_target(def, subs.as_slice(), 0);
            // wikiwiki 夜戦: night ASW after a day battle does 0 power (scratch) except at night-start
            // nodes and for combined-fleet escorts (kcsim `!NBonly && !isescort`).
            let escort = self.fleets[side].combined.is_some() && a >= self.fleets[side].escort_start;
            self.asw_attack(side, a, t, covered, false, !night_only && !escort);
            return;
        }
        if surface.is_empty() {
            return;
        }
        let (t, covered) = self.choose_preferred(side, a, surface.as_slice(), false, sl_rerolls);
        self.night_attack(side, a, t, covered, env, None);
    }

    fn roll_night_ci(&mut self, side: usize, a: usize, d: usize, env: &NightEnv) -> NightAttack {
        let c = self.core(side, a);
        let st = &self.st[side][a];
        let mut chance = c.nb_chance_base + if self.is_flagship(side, a) { 15.0 } else { 0.0 };
        if env.own_starshell {
            chance += 4.0;
        }
        if env.enemy_starshell {
            chance -= 10.0;
        }
        if env.own_searchlight {
            chance += 7.0;
        }
        if env.enemy_searchlight {
            chance -= 5.0;
        }
        if st.hp_ratio(c.max_hp) <= 0.5 {
            chance += 18.0;
        }
        chance *= 0.01;
        let target_inst = self.core(1 - side, d).is_installation;
        // kcsim `CV.NBtypes`: carrier night cut-ins need night aviation personnel (not Ark Royal's Swordfish).
        let kinds = if c.night_air_gear && c.can_night_air(st) { c.night_cv_ci(st) } else { c.night_ci.clone() };
        for &k in &kinds {
            let data = k.data();
            let mut kind = k;
            let mut double_variant = false;
            let mut chance_mod = data.chance;
            if let Some((_, _, ch2, replace_chance)) = data.replace {
                if c.level >= 80.0 && self.rng().chance(replace_chance) {
                    double_variant = true;
                    chance_mod = ch2;
                }
            }
            let dd_ci = matches!(k, NightCi::DdGtr | NightCi::DdLtr | NightCi::DdTtl | NightCi::DdTdl);
            if target_inst && dd_ci && c.mguns == 0 {
                continue;
            }
            if target_inst && data.torpedo {
                if c.has_night_da {
                    kind = NightCi::DoubleAttack;
                    chance_mod = 0.0;
                } else {
                    continue;
                }
            }
            let mut p = if chance_mod == 0.0 { 0.99 } else { chance / chance_mod };
            if kind == NightCi::Torpedo {
                if c.special_sub_torps > 0 && c.has_sub_radar {
                    p = chance / 1.05;
                } else if c.special_sub_torps >= 2 {
                    p = chance / 1.1;
                }
            }
            if self.rng().chance(p) {
                return NightAttack { ci: Some(kind), double_variant };
            }
        }
        NightAttack { ci: None, double_variant: false }
    }

    /// One night attack; `special`: special attack modifiers and event kind (no cut-in roll).
    fn night_attack(&mut self, side: usize, a: usize, d: usize, covered: bool, env: &NightEnv, special: Option<(Special, SpecialAttack)>) {
        let def = 1 - side;
        let na = if special.is_some() { NightAttack { ci: None, double_variant: false } } else { self.roll_night_ci(side, a, d, env) };
        let mods = calc::night_mods(self.core(side, a), na);
        let sp = special.map(|s| s.0);
        let (acc, pow) = {
            let au = self.unit(side, a);
            let du = self.unit(def, d);
            (calc::night_acc(&au, &du, env, na, sp), calc::night_power(&au, &du, env, na, sp))
        };
        let ammo = self.unit(side, a).ammo_mod();
        let armor = self.core(def, d).ar;
        let event = special.map_or_else(|| night_special(na), |s| s.1);
        let cutin = na.ci.is_some() || special.is_some();
        for _ in 0..mods.hits {
            // kcsim `NBattack`: night air attacks take the planes' proficiency critical bonus.
            let roll = formulas::roll_hit(self.rng(), &acc.hc, acc.crit_dmg);
            let hp_before = self.st[def][d].hp;
            let dmg = match roll {
                Roll::Miss if cutin => formulas::scratch(self.rng(), hp_before),
                Roll::Miss => 0,
                _ => formulas::damage_common(self.rng(), pow, roll, armor, ammo, hp_before),
            };
            let real = self.take_damage(def, d, dmg);
            self.record(AttackKind::Night, event, side, a, d, covered, None, roll, real, hp_before, &acc.hc);
        }
    }
}
