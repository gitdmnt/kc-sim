//! Night battle (kcsim `nightPhase`, `nightPhaseTarget`, `NBattack`, `getNightEquipsScout`,
//! KC3Kai/kancolle-replay, MIT © fourinone41).

use super::calc::{self, NightAttack, NightEnv};
use super::day::can_asw_night;
use super::{side_air, Battle};
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

impl<'a> Battle<'a> {
    fn night_setup(&mut self, side: usize, night_only: bool) -> SideNight {
        let mut s = SideNight::default();
        for i in self.engaged(side) {
            let (c, st) = (self.core(side, i), &self.st[side][i]);
            if st.hp > 0 && c.has_starshell && st.hp > 4 && self.rng().chance(0.7) {
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
        let sides = [self.night_setup(0, night_only), self.night_setup(1, night_only)];
        let ranges = [self.engaged(0), self.engaged(1)];
        let n = ranges[0].len().max(ranges[1].len());
        'rounds: for k in 0..n {
            for side in 0..2 {
                let a = ranges[side].start + k;
                if a < ranges[side].end && can_night(self.core(side, a), &self.st[side][a]) {
                    let env = NightEnv {
                        own_starshell: sides[side].starshell,
                        enemy_starshell: sides[1 - side].starshell,
                        own_searchlight: sides[side].searchlight > 0,
                        enemy_searchlight: sides[1 - side].searchlight > 0,
                        contact_acc: sides[side].contact,
                    };
                    self.night_turn(side, a, &env, sides[1 - side].searchlight, night_only);
                }
                if !self.any_alive(1 - side) {
                    break 'rounds;
                }
            }
        }
        self.engaged[0] = (0, self.len(0));
    }

    fn night_turn(&mut self, side: usize, a: usize, env: &NightEnv, sl_rerolls: u8, night_only: bool) {
        let def = 1 - side;
        let subs = self.subs(def);
        let surface = self.surface(def);
        let c = self.core(side, a);
        let air = c.can_night_air(&self.st[side][a]);
        if !subs.is_empty() && can_asw_night(c, &self.st[side][a]) && (!air || surface.is_empty()) {
            let (t, covered) = self.choose_target(def, subs.as_slice(), 0);
            self.asw_attack(side, a, t, covered, false, !night_only);
            return;
        }
        if surface.is_empty() {
            return;
        }
        let (t, covered) = self.choose_target(def, surface.as_slice(), sl_rerolls);
        self.night_attack(side, a, t, covered, env);
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
        let kinds = if c.can_night_air(st) { c.night_cv_ci(st) } else { c.night_ci.clone() };
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

    fn night_attack(&mut self, side: usize, a: usize, d: usize, covered: bool, env: &NightEnv) {
        let def = 1 - side;
        let na = self.roll_night_ci(side, a, d, env);
        let mods = calc::night_mods(self.core(side, a), na);
        let (acc, pow) = {
            let au = self.unit(side, a);
            let du = self.unit(def, d);
            (calc::night_acc(&au, &du, env, na), calc::night_power(&au, &du, env, na))
        };
        let ammo = self.unit(side, a).ammo_mod();
        let armor = self.core(def, d).ar;
        let special = night_special(na);
        for _ in 0..mods.hits {
            let roll = formulas::roll_hit(self.rng(), &acc.hc, 1.0);
            let hp_before = self.st[def][d].hp;
            let dmg = match roll {
                Roll::Miss if na.ci.is_some() => formulas::scratch(self.rng(), hp_before),
                Roll::Miss => 0,
                _ => formulas::damage_common(self.rng(), pow, roll, armor, ammo, hp_before),
            };
            let real = self.take_damage(def, d, dmg);
            self.record(AttackKind::Night, special, side, a, d, covered, None, roll, real, hp_before, &acc.hc);
        }
    }
}
