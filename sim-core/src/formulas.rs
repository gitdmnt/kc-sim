//! Pure combat formulas: accuracy/evasion/critical, soft cap, armor roll, scratch damage,
//! sinking protection. Ported from KC3Kai/kancolle-replay `js/kcsim.js` (`hitRate`,
//! `accuracyAndCrit`, `rollHit`, `damageCommon`, `getScratchDamage`, `softCap`, `takeDamage`),
//! MIT © fourinone41, cross-checked with en.kancollewiki.net.

use crate::rng::Rng;

pub const CAP_DAY: f64 = 220.0;
pub const CAP_NIGHT: f64 = 360.0;
pub const CAP_ASW: f64 = 170.0;
pub const CAP_TORPEDO: f64 = 180.0;
pub const CAP_AIR: f64 = 170.0;
pub const CRIT_MOD: f64 = 1.5;

/// Attacker accuracy term as a fraction: `(base + 2√lv + 1.5√luck + flat) × mod / 100`.
#[inline]
pub fn hit_rate(base: f64, level: f64, luck: f64, flat: f64, modifier: f64) -> f64 {
    (base + 2.0 * level.max(0.0).sqrt() + 1.5 * luck.max(0.0).sqrt() + flat) * modifier * 0.01
}

/// Accuracy multiplier from the attacker's morale (`torpedo` uses the torpedo table).
pub fn morale_acc(morale: i32, torpedo: bool) -> f64 {
    match (morale, torpedo) {
        (m, false) if m >= 50 => 1.2,
        (m, false) if m >= 30 => 1.0,
        (m, false) if m >= 20 => 0.8,
        (_, false) => 0.5,
        (m, true) if m >= 50 => 1.3,
        (m, true) if m >= 30 => 1.0,
        (m, true) if m >= 20 => 0.7,
        (_, true) => 0.35,
    }
}

/// Multiplier on the attacker's final accuracy from the defender's morale.
pub fn morale_ev(morale: i32) -> f64 {
    if morale >= 50 {
        0.7
    } else if morale >= 30 {
        1.0
    } else if morale >= 20 {
        1.2
    } else {
        1.4
    }
}

/// Defender side of an accuracy roll.
#[derive(Clone, Copy, Debug)]
pub struct Evasion {
    /// Total evasion stat.
    pub ev: f64,
    pub luck: f64,
    /// Formation evasion multiplier.
    pub ev_mod: f64,
    /// Flat evasion bonus in percent (improvements, night CA bonus, ...).
    pub ev_flat: f64,
    /// Fuel percent (0..100, floored).
    pub fuel_pct: i32,
    pub morale: i32,
}

/// Plane-related accuracy/critical bonuses (proficiency), applied only when the attack uses planes.
#[derive(Clone, Copy, Debug, Default)]
pub struct PlaneBonus {
    pub acc: f64,
    pub crit_rate: f64,
}

/// Integer percents as rolled by the game (`r = floor(rand·100)`; crit if `r ≤ crit`, hit if `r ≤ acc`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HitCrit {
    pub acc: i32,
    pub crit: i32,
    /// Hit term before subtracting evasion (percent, floored).
    pub hit_term: f64,
    /// Evasion term (percent, floored).
    pub dodge_term: f64,
}

impl HitCrit {
    /// Probability of hitting (normal or critical).
    pub fn p_hit(&self) -> f64 {
        ((self.acc.max(self.crit).min(99) + 1).max(0)) as f64 / 100.0
    }

    pub fn p_crit(&self) -> f64 {
        ((self.crit.min(99) + 1).max(0)) as f64 / 100.0
    }
}

#[inline]
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// kcsim `accuracyAndCrit`. `hit` is the attacker's accuracy fraction (from [`hit_rate`] and post
/// multipliers), `crit_mod` 1.3 shelling/ASW, 1.5 torpedo/night, 0 airstrike.
pub fn accuracy_and_crit(hit: f64, ev: &Evasion, crit_mod: f64, plane: Option<PlaneBonus>, crit_bonus_flat: f64) -> HitCrit {
    let evade = ((ev.ev + (ev.luck.max(0.0) * 2.0).sqrt()) * ev.ev_mod).floor();
    let mut dodge = if evade > 65.0 {
        (55.0 + 2.0 * (evade - 65.0).sqrt()).floor()
    } else if evade > 40.0 {
        (40.0 + 3.0 * (evade - 40.0).sqrt()).floor()
    } else {
        evade
    };
    dodge *= 0.01;
    if ev.fuel_pct < 75 {
        dodge -= (75 - ev.fuel_pct) as f64 / 100.0;
    }
    dodge += ev.ev_flat * 0.01;

    let hit_term = (js_round(hit * 1_000_000.0) / 10_000.0).floor();
    let dodge_term = (js_round(dodge * 1_000_000.0) / 10_000.0).floor();
    let mut acc = (hit_term - dodge_term).max(10.0);
    acc *= morale_ev(ev.morale);
    acc = acc.floor().min(96.0);
    if let Some(p) = plane {
        acc += p.acc;
    }
    let mut crit = acc.max(0.0).sqrt() * crit_mod;
    if let Some(p) = plane {
        crit += p.crit_rate;
    }
    crit += crit_bonus_flat * 100.0;
    HitCrit { acc: acc.floor() as i32, crit: crit.floor() as i32, hit_term, dodge_term }
}

/// Result of a hit roll: 0 miss, 1 hit, >1 critical multiplier.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Roll {
    Miss,
    Hit,
    Crit(f64),
}

/// kcsim `rollHit`.
#[inline]
pub fn roll_hit(rng: &mut Rng, hc: &HitCrit, crit_dmg_bonus: f64) -> Roll {
    let r = (rng.f64() * 100.0).floor() as i32;
    if r <= hc.crit {
        Roll::Crit(CRIT_MOD * crit_dmg_bonus)
    } else if r <= hc.acc {
        Roll::Hit
    } else {
        Roll::Miss
    }
}

/// `cap + √(x − cap)` above the cap.
#[inline]
pub fn soft_cap(x: f64, cap: f64) -> f64 {
    if x > cap {
        cap + (x - cap).sqrt()
    } else {
        x
    }
}

/// Ammo damage multiplier: `floor(ammo% ) / 50`, capped at 1.
#[inline]
pub fn ammo_mod(ammo: i32, ammo_max: i32) -> f64 {
    if ammo_max <= 0 {
        return 1.0;
    }
    let pct = (ammo as f64 * 100.0 / ammo_max as f64).floor();
    (pct / 50.0).min(1.0)
}

/// Fuel percent used for the evasion penalty.
#[inline]
pub fn fuel_pct(fuel: i32, fuel_max: i32) -> i32 {
    if fuel_max <= 0 {
        100
    } else {
        (fuel as f64 * 100.0 / fuel_max as f64).floor() as i32
    }
}

/// Scratch damage `floor(0.06·HP + 0.08·floor(rand·HP))` against the current HP.
#[inline]
pub fn scratch(rng: &mut Rng, hp: i32) -> i32 {
    if hp <= 0 {
        return 0;
    }
    let h = hp as f64;
    (h * 0.06 + 0.08 * rng.floor_mul(h)).floor() as i32
}

/// Final damage of a landed attack (kcsim `damageCommon`): crit multiplier, armor roll,
/// ammo penalty, scratch damage.
pub fn damage_common(rng: &mut Rng, pow: f64, roll: Roll, armor: f64, ammo_mod: f64, target_hp: i32) -> i32 {
    let pow = match roll {
        Roll::Crit(m) => (pow * m).floor(),
        _ => pow,
    };
    let def = 0.7 * armor + 0.6 * rng.floor_mul(armor.floor());
    let dmg = ((pow - def) * ammo_mod).floor();
    if dmg <= 0.0 {
        scratch(rng, target_hp)
    } else {
        dmg as i32
    }
}

/// Sinking protection for a friend ship (kcsim `takeDamage` + wiki red-morale rule).
/// Returns the damage actually removed.
pub fn protect(rng: &mut Rng, dmg: i32, hp: i32, red_morale_non_flagship: bool) -> i32 {
    if hp <= 1 {
        return 0;
    }
    if dmg < hp {
        return dmg;
    }
    if red_morale_non_flagship {
        return hp - 1;
    }
    let h = hp as f64;
    (h * 0.5 + 0.3 * rng.floor_mul(h)).floor() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(evasion: f64, luck: f64) -> Evasion {
        Evasion { ev: evasion, luck, ev_mod: 1.0, ev_flat: 0.0, fuel_pct: 100, morale: 49 }
    }

    #[test]
    fn soft_cap_values() {
        assert_eq!(soft_cap(200.0, CAP_DAY), 200.0);
        assert_eq!(soft_cap(220.0, CAP_DAY), 220.0);
        // 320 precap -> 220 + sqrt(100) = 230
        assert_eq!(soft_cap(320.0, CAP_DAY), 230.0);
        assert_eq!(soft_cap(396.0, CAP_NIGHT), 366.0);
        assert_eq!(soft_cap(186.25, CAP_TORPEDO), 182.5);
    }

    #[test]
    fn evasion_cap_piecewise() {
        // evasion 40 -> 40, 49 -> floor(40 + 3*3) = 49, 65 -> floor(40+3*sqrt(25)) = 55, 81 -> floor(55+2*4) = 63
        let hit = 2.0; // 200% so that acc is not floored at 10
        let a = accuracy_and_crit(hit, &ev(40.0, 0.0), 1.3, None, 0.0);
        assert_eq!(a.dodge_term, 40.0);
        let a = accuracy_and_crit(hit, &ev(49.0, 0.0), 1.3, None, 0.0);
        assert_eq!(a.dodge_term, 49.0);
        let a = accuracy_and_crit(hit, &ev(65.0, 0.0), 1.3, None, 0.0);
        assert_eq!(a.dodge_term, 55.0);
        let a = accuracy_and_crit(hit, &ev(81.0, 0.0), 1.3, None, 0.0);
        assert_eq!(a.dodge_term, 63.0);
    }

    #[test]
    fn accuracy_example() {
        // Lv 99, luck 12, +10 equip acc, line ahead, morale 49: 90 + 2*sqrt(99) + 1.5*sqrt(12) + 10
        let h = hit_rate(90.0, 99.0, 12.0, 10.0, 1.0);
        assert!((h - (90.0 + 2.0 * 99f64.sqrt() + 1.5 * 12f64.sqrt() + 10.0) / 100.0).abs() < 1e-12);
        assert_eq!((h * 100.0).floor(), 125.0);
        // vs evasion 30 luck 8: dodge = floor(30 + 4) = 34 -> acc = 125 - 34 = 91, crit floor(sqrt(91)*1.3) = 12
        let a = accuracy_and_crit(h, &ev(30.0, 8.0), 1.3, None, 0.0);
        assert_eq!((a.acc, a.crit), (91, 12));
        assert!((a.p_hit() - 0.92).abs() < 1e-12);
        assert!((a.p_crit() - 0.13).abs() < 1e-12);
        // cap 96 -> p_hit 0.97; floor 10 when hopeless
        let a = accuracy_and_crit(3.0, &ev(0.0, 0.0), 1.3, None, 0.0);
        assert_eq!(a.acc, 96);
        assert!((a.p_hit() - 0.97).abs() < 1e-12);
        let a = accuracy_and_crit(0.2, &ev(100.0, 100.0), 1.3, None, 0.0);
        assert_eq!(a.acc, 10);
        // sparkled target x0.7, red target x1.4 (before the 96 cap)
        let mut e = ev(30.0, 8.0);
        e.morale = 50;
        assert_eq!(accuracy_and_crit(h, &e, 1.3, None, 0.0).acc, (91.0f64 * 0.7).floor() as i32);
        // fuel 50% -> -25 evasion points
        let mut e = ev(30.0, 8.0);
        e.fuel_pct = 50;
        assert_eq!(accuracy_and_crit(h, &e, 1.3, None, 0.0).dodge_term, 9.0);
    }

    #[test]
    fn armor_roll_bounds() {
        // armor 100: def in [70, 70 + 0.6*99] = [70, 129.4]; power 200 -> damage in [70, 130]
        let mut rng = Rng::new(1);
        let (mut lo, mut hi) = (i32::MAX, i32::MIN);
        for _ in 0..20000 {
            let d = damage_common(&mut rng, 200.0, Roll::Hit, 100.0, 1.0, 500);
            lo = lo.min(d);
            hi = hi.max(d);
        }
        assert_eq!((lo, hi), (70, 130));
        // power below armor -> scratch vs 40 HP: floor(2.4 + 0.08*[0..39]) in [2, 5]
        let (mut lo, mut hi) = (i32::MAX, i32::MIN);
        for _ in 0..20000 {
            let d = damage_common(&mut rng, 10.0, Roll::Hit, 100.0, 1.0, 40);
            lo = lo.min(d);
            hi = hi.max(d);
        }
        assert_eq!((lo, hi), (2, 5));
        // critical: floor(150 * 1.5) = 225
        let d = damage_common(&mut rng, 150.0, Roll::Crit(1.5), 1.0, 1.0, 500);
        assert!((224..=225).contains(&d));
    }

    #[test]
    fn ammo_and_protection() {
        assert_eq!(ammo_mod(100, 100), 1.0);
        assert_eq!(ammo_mod(40, 100), 0.8);
        assert_eq!(ammo_mod(0, 100), 0.0);
        let mut rng = Rng::new(7);
        for _ in 0..1000 {
            let d = protect(&mut rng, 999, 40, false);
            assert!((20..=31).contains(&d), "{d}");
        }
        assert_eq!(protect(&mut rng, 999, 1, false), 0);
        assert_eq!(protect(&mut rng, 999, 30, true), 29);
        assert_eq!(protect(&mut rng, 10, 30, false), 10);
    }
}
