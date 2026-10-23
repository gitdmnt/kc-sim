//! Deterministic part of each attack type: accuracy/critical terms and post-cap power.
//! Shared by the engine (which adds the random rolls) and the forward-model queries.
//! Ported from KC3Kai/kancolle-replay `js/kcsim.js` (`shell`, `ASW`, `torpedoPhase`, `NBattack`,
//! `airstrike`) and `js/kcships.js` (`shellPower`, `NBPower`, `ASWPower`), MIT © fourinone41.

use crate::bonus::Bonus;
use crate::equipment::{cat, f};
use crate::formation::{self, countered, FormMods};
use crate::formulas::*;
use crate::install::{airstrike_target_mod, pt_acc, pt_pow};
use crate::model::{Formation, InstallationKind};
use crate::ship::{DayCi, NightCi, ShipClass, ShipCore, ShipState};

/// Combined-fleet terms of one ship's attacks (kcsim `basepowshell` / `baseaccshell`,
/// `torpedoPhase` escort rule, `airstrike` combined-target terms). [`CF_NONE`] outside combined battles.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cf {
    /// Added to the +5 of basic shelling power (kcsim `COMBINEDCONSTS.shellDmg*`).
    pub shell_pow: f64,
    /// Shelling accuracy base (kcsim `COMBINEDCONSTS.shellAcc*`, 90 otherwise).
    pub shell_acc: f64,
    /// Torpedo basic power bonus: 5; friend combined vs single 0 (every shot involves an escort
    /// ship); against or by an enemy combined fleet 15 (kcsim `torpedoPhase` `combinedAll`).
    pub torp_pow: f64,
    /// Flat torpedo accuracy (kcsim `combinedAll`: −35 against a combined fleet, −5 more for a
    /// friend combined attacker, +5 back for an enemy combined one).
    pub torp_acc: f64,
    /// As an airstrike target in a combined fleet: accuracy (fraction) and power-base bonus
    /// (kcsim `SIMCONSTS.airstrikeAcc*` / `airstrikeDmg*`).
    pub air_acc: f64,
    pub air_pow: f64,
}

pub const CF_NONE: Cf = Cf { shell_pow: 0.0, shell_acc: 90.0, torp_pow: 5.0, torp_acc: 0.0, air_acc: 0.0, air_pow: 0.0 };

/// Airstrike power base (kcsim `airstrike`: 25).
pub const AIR_BASE: f64 = 25.0;

/// A ship in its battle context. `idx` / `len` are its position and the size of its own fleet
/// (main or escort).
#[derive(Clone, Copy)]
pub struct Unit<'a> {
    pub core: &'a ShipCore,
    pub st: &'a ShipState,
    pub form: Formation,
    pub idx: usize,
    pub len: usize,
    pub cf: Cf,
    /// Smoke screen layers in effect for this attack (0 none, 1..3; day battle only).
    pub smoke: u8,
    /// Barrage balloons of this ship's side (0..3; balloon nodes, day battle only).
    pub balloons: u8,
    /// Event historical bonus of this ship (friend ships of a battle with bonuses).
    pub bonus: Option<&'a Bonus>,
}

impl<'a> Unit<'a> {
    /// A unit outside a fleet battle context (land-base jets, base raids): no combined-fleet
    /// terms, smoke, balloons or bonus.
    pub fn plain(core: &'a ShipCore, st: &'a ShipState, form: Formation, idx: usize, len: usize) -> Unit<'a> {
        Unit { core, st, form, idx, len, cf: CF_NONE, smoke: 0, balloons: 0, bonus: None }
    }

    #[inline]
    pub fn fm(&self) -> &'static FormMods {
        formation::mods(self.form, self.idx, self.len)
    }

    #[inline]
    pub fn hp_ratio(&self) -> f64 {
        self.st.hp_ratio(self.core.max_hp)
    }

    pub(crate) fn evasion(&self, ev_mod: f64, ev_flat: f64) -> Evasion {
        Evasion {
            ev: self.core.ev,
            luck: self.core.luck,
            ev_mod,
            ev_flat,
            fuel_pct: if self.core.is_player { fuel_pct(self.st.fuel, self.st.fuel_max) } else { 100 },
            morale: self.st.morale,
            // kcsim `bonusSpecialEv` (after `evModPost`).
            ev_bonus: self.bonus.map_or(1.0, |b| b.eva(&self.st.planes)),
        }
    }

    /// `pow` × the attacker's event damage bonus (kcsim `getBonusDmg` × `getBonusSpecialPlane`);
    /// `air()`: the attack uses planes (all plane groups count, else only `notAirOnly` ones).
    #[inline]
    pub fn bonus_dmg(&self, pow: f64, air: impl FnOnce() -> bool) -> f64 {
        match self.bonus {
            Some(b) => pow * b.dmg(&self.st.planes, air()),
            None => pow,
        }
    }

    /// Event accuracy bonus of the attacker as a hit-fraction multiplier (1 = none).
    #[inline]
    fn bonus_acc(&self, air: impl FnOnce() -> bool) -> f64 {
        self.bonus.map_or(1.0, |b| b.acc(&self.st.planes, air()))
    }

    #[inline]
    pub fn ammo_mod(&self) -> f64 {
        if self.core.is_player {
            ammo_mod(self.st.ammo, self.st.ammo_max)
        } else {
            1.0
        }
    }

    fn vanguard_target_mod(&self, torpedo: bool) -> f64 {
        if self.form == Formation::Vanguard {
            formation::vanguard_target_acc(self.core.class, self.idx, torpedo)
        } else {
            1.0
        }
    }

    /// kcsim `1 + getNumBalloons()/50`: own balloons raise shelling / ASW / airstrike power.
    #[inline]
    pub fn balloon_mod(&self) -> f64 {
        1.0 + self.balloons as f64 / 50.0
    }
}

/// Modifiers of a fleet special attack / night Zuiun cut-in for one attacker (kcsim
/// `getSpecialAttackMod`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Special {
    /// Power multiplier: post-cap in the day, pre-cap at night (kcsim `shell` / `NBattack`).
    pub pow: f64,
    /// Accuracy multiplier on the hit-rate modifier.
    pub acc: f64,
    /// Submarine fleet attack: day power is the attacker's torpedo stat (kcsim attackSpecial 300–302).
    pub sub: bool,
}

/// Day damage-state power modifier.
#[inline]
pub fn damage_state_mod(ratio: f64) -> f64 {
    if ratio <= 0.25 {
        0.4
    } else if ratio <= 0.5 {
        0.7
    } else {
        1.0
    }
}

/// Torpedo damage-state power modifier (taiha ships fire with zero power).
#[inline]
pub fn torpedo_state_mod(ratio: f64) -> f64 {
    if ratio <= 0.25 {
        0.0
    } else if ratio <= 0.5 {
        0.8
    } else {
        1.0
    }
}

/// AP-shell weak targets (heavy cruisers, battleships, standard carriers).
pub fn ap_weak(c: ShipClass) -> bool {
    matches!(c, ShipClass::CA | ShipClass::CAV | ShipClass::FBB | ShipClass::BB | ShipClass::BBV | ShipClass::CV | ShipClass::CVB)
}

fn ap_acc(att: &ShipCore, def: &ShipCore) -> f64 {
    if !ap_weak(def.class) {
        return 1.0;
    }
    match att.ap_type {
        1 => 1.1,
        2 => 1.25,
        3 => 1.2,
        4 => 1.3,
        _ => 1.0,
    }
}

fn ap_pow(att: &ShipCore, def: &ShipCore) -> f64 {
    if !ap_weak(def.class) {
        return 1.0;
    }
    match att.ap_type {
        1 => 1.08,
        2 => 1.1,
        3 | 4 => 1.15,
        _ => 1.0,
    }
}

// ---------------------------------------------------------------- smoke ----

/// Attack kinds affected by a smoke screen.
#[derive(Clone, Copy)]
enum SmokeKind {
    Shell,
    Asw,
    Torpedo,
}

/// Accuracy multiplier under a smoke screen of 1..3 layers, friend (F) / enemy (E) attacker, with
/// or without a radar for shelling. kcsim `SIMCONSTS.smokeEst` (kcsim's own estimates of the
/// wiki observations: shelling without radar nearly never hits, ASW ≈ 25 %) [unverified].
fn smoke_mod(att: &Unit, kind: SmokeKind) -> f64 {
    if att.smoke == 0 {
        return 1.0;
    }
    let i = (att.smoke.min(3) - 1) as usize;
    let t: [f64; 3] = match (kind, att.core.is_player, att.core.radars > 0) {
        (SmokeKind::Shell, true, false) => [0.01, 0.01, 0.01],
        (SmokeKind::Shell, true, true) => [0.35, 0.25, 0.25],
        (SmokeKind::Shell, false, false) => [0.5, 0.5, 0.5],
        (SmokeKind::Shell, false, true) => [0.9, 0.83, 0.75],
        (SmokeKind::Asw, true, _) => [0.25, 0.25, 0.25],
        (SmokeKind::Asw, false, _) => [1.0, 1.0, 1.0],
        (SmokeKind::Torpedo, true, _) => [0.45, 0.42, 0.42],
        (SmokeKind::Torpedo, false, _) => [0.7, 0.6, 0.5],
    };
    t[i]
}

/// Accuracy part of an attack: integer hit/crit percents plus the critical damage multiplier.
#[derive(Clone, Copy, Debug)]
pub struct AttackAcc {
    pub hc: HitCrit,
    pub crit_dmg: f64,
}

/// What follows `hit_rate` in an attack's accuracy fraction (then smoke, PT imp transform, DE).
#[derive(Clone, Copy, Debug)]
enum HitTail {
    /// torpedo, ASW
    Plain,
    /// shelling: `(h + fit) × ap/CI mod`, then − 0.13 for DE (after smoke / PT)
    Shell { fit: f64, mod2: f64, de: bool },
    /// night: `h + fit`, + 0.07 with an own searchlight, + heavy cruiser 20.3cm bonus
    Night { fit: f64, searchlight: bool, ca: f64 },
    /// airstrike: fixed
    Fixed(f64),
}

/// The attacker's accuracy fraction as a function of its luck and hidden accuracy, everything else
/// fixed. The flat accuracy is summed left to right as in kcsim: `pre + hidden + post[0] + post[1] + …`.
/// The estimator grid (`query::hit_probability_grid`) evaluates [`HitFn::luck_part`] and [`HitFn::flat`]
/// once per axis value; [`HitFn::eval`] is the same computation in one call.
#[derive(Clone, Copy, Debug)]
pub struct HitFn {
    base: f64,
    level: f64,
    pre: f64,
    post: [f64; 3],
    n_post: usize,
    modifier: f64,
    tail: HitTail,
    /// Smoke screen multiplier.
    smoke: f64,
    /// PT imp target: multiplier after kcsim's PT accuracy transform (0 = not a PT target).
    pt: f64,
}

impl HitFn {
    fn new(base: f64, level: f64, pre: f64, post: &[f64], modifier: f64, tail: HitTail) -> HitFn {
        let mut p = [0.0; 3];
        p[..post.len()].copy_from_slice(post);
        HitFn { base, level, pre, post: p, n_post: post.len(), modifier, tail, smoke: 1.0, pt: 0.0 }
    }

    fn with(mut self, smoke: f64, pt: f64) -> HitFn {
        self.smoke = smoke;
        self.pt = pt;
        self
    }

    /// Multiply the event accuracy bonus into the post multiplier (kcsim `getBonusAcc`: after the
    /// tail's own modifiers, before smoke and the PT transform). Call after [`HitFn::with`].
    fn with_bonus(mut self, bonus: f64) -> HitFn {
        self.smoke *= bonus;
        self
    }

    #[inline]
    pub fn luck_part(&self, luck: f64) -> f64 {
        hit_base(self.base, self.level, luck)
    }

    #[inline]
    pub fn flat(&self, hidden_acc: f64) -> f64 {
        let mut flat = self.pre + hidden_acc;
        for p in &self.post[..self.n_post] {
            flat += *p;
        }
        flat
    }

    #[inline]
    pub fn finish(&self, luck_part: f64, flat: f64) -> f64 {
        let h = hit_rate_from(luck_part, flat, self.modifier);
        let mut h = match self.tail {
            HitTail::Plain => h,
            HitTail::Shell { fit, mod2, .. } => (h + fit) * mod2,
            HitTail::Night { fit, searchlight, ca } => {
                let h = h + fit;
                let h = if searchlight { h + 0.07 } else { h };
                h + ca
            }
            HitTail::Fixed(h) => return h,
        };
        if self.smoke != 1.0 {
            h *= self.smoke;
        }
        if self.pt != 0.0 {
            h = pt_acc(h) * self.pt;
        }
        if let HitTail::Shell { de: true, .. } = self.tail {
            h -= 0.13;
        }
        h
    }

    #[inline]
    pub fn eval(&self, luck: f64, hidden_acc: f64) -> f64 {
        self.finish(self.luck_part(luck), self.flat(hidden_acc))
    }
}

/// Inputs of `accuracy_and_crit` for one attack before the attacker's luck and hidden accuracy are
/// plugged into `hit`, plus the critical damage multiplier.
#[derive(Clone, Copy, Debug)]
pub struct AccTerms {
    pub hit: HitFn,
    /// attacker luck and hidden accuracy
    pub luck: f64,
    pub hidden_acc: f64,
    /// defender side
    pub ev: Evasion,
    pub crit_mod: f64,
    pub plane: Option<PlaneBonus>,
    pub crit_flat: f64,
    pub crit_dmg: f64,
}

impl AccTerms {
    #[inline]
    pub fn resolve(&self) -> AttackAcc {
        let hit = self.hit.eval(self.luck, self.hidden_acc);
        AttackAcc { hc: accuracy_and_crit(hit, &self.ev, self.crit_mod, self.plane, self.crit_flat), crit_dmg: self.crit_dmg }
    }

    /// [`AccTerms::resolve`] for a given hit term and evade value (`formulas::hit_crit`).
    pub fn hit_crit(&self, hit_term: f64, evade: f64) -> HitCrit {
        hit_crit(hit_term, evade, &self.ev, self.crit_mod, self.plane, self.crit_flat)
    }
}

/// Flat accuracy terms after the improvement term: kcsim `ptAccFlat` against PT imps.
#[inline]
fn post_flat(imp: f64, att: &ShipCore, def: &ShipCore) -> ([f64; 2], usize) {
    if def.target.pt && att.vs.pt_acc_flat != 0.0 {
        ([imp, att.vs.pt_acc_flat], 2)
    } else {
        ([imp, 0.0], 1)
    }
}

/// PT imp accuracy multiplier after the transform (kcsim `ptAccMod`, ×1.2 in vanguard), 0 for
/// other targets. `base`: 1 for shelling, 0.7 for torpedoes and night attacks.
#[inline]
fn pt_acc_mod(att: &Unit, def: &Unit, base: f64, with_ship_mod: bool) -> f64 {
    if !def.core.target.pt {
        return 0.0;
    }
    let mut m = base;
    if with_ship_mod {
        m *= att.core.vs.pt_acc;
        if att.form == Formation::Vanguard {
            m *= 1.2;
        }
    }
    m
}

// ------------------------------------------------------------- shelling ----

/// Ships that shell with the carrier formula (carriers and air-capable AOs with bombers).
pub fn carrier_shelling(c: &ShipCore) -> bool {
    c.cv_like()
}

#[inline]
pub fn shelling_acc(att: &Unit, def: &Unit, ci: Option<DayCi>, sp: Option<Special>) -> AttackAcc {
    shelling_terms(att, def, ci, sp).resolve()
}

pub fn shelling_terms(att: &Unit, def: &Unit, ci: Option<DayCi>, sp: Option<Special>) -> AccTerms {
    let a = att.core;
    let mut acc_mod = morale_acc(att.st.morale, false);
    if !countered(att.form, def.form) {
        acc_mod *= att.fm().shell_acc;
    }
    if att.form == Formation::Vanguard && def.core.class == ShipClass::DD {
        acc_mod *= 1.1;
    }
    acc_mod *= def.vanguard_target_mod(false);
    if let Some(s) = sp {
        acc_mod *= s.acc;
    }
    let mut acc_mod2 = ap_acc(a, def.core);
    if let Some(ci) = ci {
        acc_mod2 *= ci.data().acc;
    }
    let tail = HitTail::Shell { fit: a.fit_acc * 0.01, mod2: acc_mod2, de: a.class == ShipClass::DE };
    let (post, np) = post_flat(a.imp.acc_shell, a, def.core);
    let hit = HitFn::new(att.cf.shell_acc, a.level, a.acc + a.bonus.acc, &post[..np], acc_mod, tail)
        .with(smoke_mod(att, SmokeKind::Shell), pt_acc_mod(att, def, 1.0, true))
        .with_bonus(att.bonus_acc(|| carrier_shelling(a)));
    let ev = def.evasion(def.fm().shell_ev, def.core.imp.ev_shell);
    let planes = carrier_shelling(a);
    let (crit_rate, mut crit_dmg, acc_plane) = a.proficiency(att.st);
    let mut crit_flat = 0.0;
    if let Some(ci) = ci.filter(|c| c.is_cvci()) {
        let (bonus_rate, dmg) = cvci_crit(a, att.st, ci, crit_rate);
        crit_flat = bonus_rate;
        if let Some(d) = dmg {
            crit_dmg = d;
        }
    }
    let plane = planes.then_some(PlaneBonus { acc: acc_plane, crit_rate });
    AccTerms {
        hit, luck: a.luck, hidden_acc: a.hidden_acc, ev, crit_mod: 1.3, plane, crit_flat,
        crit_dmg: if planes { crit_dmg } else { 1.0 },
    }
}

/// kcsim CVCI critical special case: (flat crit-rate bonus, override crit damage multiplier).
fn cvci_crit(a: &ShipCore, st: &ShipState, ci: DayCi, prof_crit_rate: f64) -> (f64, Option<f64>) {
    let mut sum = 0.0;
    let mut n = 0.0;
    for (i, e) in a.slots.iter().enumerate() {
        if let Some(e) = e {
            if e.has(f::ATTACK_PROF) {
                sum += st.exp[i];
                n += 1.0;
            }
        }
    }
    let avg = if n > 0.0 { sum / n } else { 0.0 };
    let mut rate = 0.13 * avg / 120.0 - prof_crit_rate * 0.01;
    let mut dmg = None;
    if let Some(e0) = a.slots[0].as_ref() {
        let first_ok = match ci {
            DayCi::CvciFba => [cat::FIGHTER, cat::DIVE_BOMBER, cat::TORP_BOMBER].contains(&e0.cat),
            DayCi::CvciJfJbJb | DayCi::CvciJfJb => [cat::JET_FIGHTER, cat::JET_BOMBER].contains(&e0.cat),
            DayCi::CvciJfBa => [cat::JET_FIGHTER, cat::DIVE_BOMBER, cat::TORP_BOMBER].contains(&e0.cat),
            _ => [cat::DIVE_BOMBER, cat::TORP_BOMBER].contains(&e0.cat),
        };
        if first_ok {
            let exp0 = st.exp[0];
            if exp0 >= 100.0 {
                dmg = Some(1.0 + exp0 * 0.003 + avg * 0.001 - 0.23);
                rate += 0.08;
            } else {
                dmg = Some(1.0 + exp0 * 0.0006 + 0.024);
                if exp0 >= 85.0 {
                    rate += 0.056;
                }
            }
        } else if avg >= 119.0 {
            dmg = Some(1.106);
        } else if avg >= 107.0 {
            dmg = Some(1.096);
        } else if avg >= 50.0 {
            dmg = Some(1.0 + (avg - 50.0) * 0.001);
        }
    }
    (rate, dmg)
}

/// Basic shelling power (kcsim `shellPower` / `CV.shellPower`): `base` is added to the usual +5
/// (0 for single fleets). Against an installation: FP × installation multiplier (× day multiplier
/// for gun shelling) + flat bonus; carriers count only the bombers that can attack installations.
pub fn shell_basic_power(att: &ShipCore, def: &ShipCore, base: f64) -> f64 {
    let kind = def.target.kind;
    if carrier_shelling(att) || att.vs.cv_shell {
        let mut dp = 0.0;
        let mut tp = att.bonus.tp;
        for e in att.slots.iter().flatten() {
            if kind.is_none() || crate::install::can_shell_install(e.id) {
                dp += e.bomb;
            }
            tp += e.tp;
        }
        let mut fp = att.fp + (5.0 + base) + att.imp.p_shell;
        if let Some(k) = kind {
            tp = 0.0;
            fp = fp * att.vs.inst.mult(k).0 + att.vs.inst.flat;
        }
        25.0 + (1.5 * (15.0 + fp + tp + (1.3 * dp).floor())).floor()
    } else if let Some(k) = kind {
        let sub_bonus = if att.class.is_sub() { 30.0 } else { 0.0 };
        let fp = att.fp + sub_bonus + (5.0 + base) + att.imp.p_shell;
        let (m, day) = att.vs.inst.mult(k);
        fp * m * day + att.vs.inst.flat
    } else {
        att.fp + (5.0 + base) + att.imp.p_shell
    }
}

/// Post-cap multiplier of the target kind (kcsim `postModExtra`): supply depots, special target
/// groups.
#[inline]
fn target_post(att: &ShipCore, def: &ShipCore) -> f64 {
    let mut m = 1.0;
    if def.target.supply_depot {
        m *= att.vs.inst.supply_post;
    }
    if let Some(g) = def.target.group {
        m *= att.vs.inst.group(g);
    }
    m
}

/// PT imp damage transform (kcsim `pow·0.3 + √pow + 10`, × `ptDmgMod`).
#[inline]
fn pt_damage(att: &ShipCore, def: &ShipCore, pow: f64) -> f64 {
    if def.target.pt {
        pt_pow(pow) * att.vs.pt_dmg
    } else {
        pow
    }
}

/// Post-cap shelling power before the critical multiplier.
pub fn shelling_power(att: &Unit, def: &Unit, engagement: f64, ci: Option<DayCi>, sp: Option<Special>) -> f64 {
    let a = att.core;
    let (pre, basic) = match sp {
        // kcsim: preMod = 1 and FPfit += TP − shellPower ⇒ power = TP + FPfit.
        Some(s) if s.sub => (1.0, a.tp + a.fit_fp),
        _ => (att.fm().shell_pow * engagement * damage_state_mod(att.hp_ratio()), shell_basic_power(a, def.core, att.cf.shell_pow) + a.fit_fp),
    };
    let mut pow = soft_cap(basic * pre, CAP_DAY).floor();
    if let Some(ci) = ci {
        pow *= ci.data().dmg;
    }
    if let Some(s) = sp {
        pow *= s.pow;
    }
    // kcsim: balloons join the cut-in multiplier (before the AP floor) or the extra multiplier.
    let cutin = ci.is_some() || sp.is_some();
    if cutin && att.balloons > 0 {
        pow *= att.balloon_mod();
    }
    if ap_weak(def.core.class) && a.ap_type > 0 {
        pow = (pow * ap_pow(a, def.core)).floor();
    }
    if !cutin && att.balloons > 0 {
        pow *= att.balloon_mod();
    }
    pow *= target_post(att.core, def.core);
    // kcsim `postModExtra`: event bonus (plane groups count for carrier shelling).
    pow = att.bonus_dmg(pow, || carrier_shelling(att.core));
    pt_damage(att.core, def.core, pow)
}

// ------------------------------------------------------------------ ASW ----

/// kcsim: plane-ASW ships use plane proficiency outside OASW, except CV and AO.
pub fn asw_uses_plane_prof(att: &ShipCore, opening: bool) -> bool {
    att.plane_asw > 0 && !opening && att.class != ShipClass::AO
}

#[inline]
pub fn asw_acc(att: &Unit, def: &Unit, opening: bool) -> AttackAcc {
    asw_terms(att, def, opening).resolve()
}

pub fn asw_terms(att: &Unit, def: &Unit, opening: bool) -> AccTerms {
    let a = att.core;
    let mut acc_mod = morale_acc(att.st.morale, false);
    if !countered(att.form, def.form) {
        let fm = att.fm();
        acc_mod *= fm.asw_acc.unwrap_or(fm.shell_acc);
    }
    acc_mod *= def.vanguard_target_mod(false);
    let hit = HitFn::new(80.0, a.level, a.sonar_acc, &[], acc_mod, HitTail::Plain)
        .with(smoke_mod(att, SmokeKind::Asw), 0.0)
        .with_bonus(att.bonus_acc(|| asw_uses_plane_prof(a, opening)));
    let ev = def.evasion(def.fm().asw_ev, 0.0);
    let use_prof = asw_uses_plane_prof(a, opening);
    let (crit_rate, crit_dmg, acc_plane) = a.proficiency(att.st);
    let plane = use_prof.then_some(PlaneBonus { acc: acc_plane, crit_rate });
    AccTerms {
        hit, luck: a.luck, hidden_acc: a.hidden_acc, ev, crit_mod: 1.3, plane, crit_flat: 0.0,
        crit_dmg: if use_prof { crit_dmg } else { 1.0 },
    }
}

/// Post-cap ASW power. `night_scratch`: day-battle night ASW (power 0 ⇒ scratch damage only).
/// Balloons (day only: `Unit::balloons` is 0 at night) multiply after the cap. `opening`: opening
/// ASW (the event bonus counts every plane group only for plane ASW outside it).
pub fn asw_power(att: &Unit, engagement: f64, night_scratch: bool, opening: bool) -> f64 {
    let pre = if night_scratch { 0.0 } else { att.fm().asw_pow * engagement * damage_state_mod(att.hp_ratio()) };
    let pow = soft_cap(att.core.asw_power * pre, CAP_ASW).floor() * att.balloon_mod();
    att.bonus_dmg(pow, || asw_uses_plane_prof(att.core, opening))
}

/// Defender armor against this attacker (ASW armor penetration against submarines).
pub fn effective_armor(att: &ShipCore, def: &ShipCore) -> f64 {
    if def.class.is_sub() && att.asw_penetrate > 0.0 {
        (def.ar - att.asw_penetrate).max(1.0)
    } else {
        def.ar
    }
}

// -------------------------------------------------------------- torpedo ----

/// Post-cap torpedo power (`damage_ratio` = attacker HP ratio at the start of the phase).
pub fn torpedo_power(att: &Unit, engagement: f64, damage_ratio: f64) -> f64 {
    let a = att.core;
    let base = a.tp + att.cf.torp_pow + a.imp.p_torp;
    soft_cap(base * att.fm().torp_pow * engagement * torpedo_state_mod(damage_ratio), CAP_TORPEDO).floor()
}

/// Torpedo power against this target (kcsim `torpedoPhase`): special-target post-cap multipliers
/// (not supply depots; 泊地水鬼 バカンスmode not since `anchorageTorpNerf`), PT imp transform.
pub fn torpedo_target_power(att: &ShipCore, def: &ShipCore, power: f64) -> f64 {
    let mut pow = power;
    if let Some(g) = def.target.group.filter(|&g| g != crate::model::TargetGroup::Anchorage) {
        pow *= att.vs.inst.group(g);
    }
    if def.target.pt {
        pow = pt_pow(pow);
    }
    pow
}

#[inline]
pub fn torpedo_acc(att: &Unit, def: &Unit, power: f64) -> AttackAcc {
    torpedo_terms(att, def, power).resolve()
}

pub fn torpedo_terms(att: &Unit, def: &Unit, power: f64) -> AccTerms {
    let a = att.core;
    let post = [a.torp_acc_hidden, a.imp.acc_torp.floor(), (power / 5.0).floor()];
    let mut acc_mod = att.fm().torp_acc * morale_acc(att.st.morale, true);
    if att.form == Formation::Vanguard && def.core.class == ShipClass::DD {
        acc_mod *= 1.2;
    }
    acc_mod *= def.vanguard_target_mod(true);
    let hit = HitFn::new(85.0, a.level, a.acc + att.cf.torp_acc, &post, acc_mod, HitTail::Plain)
        .with(smoke_mod(att, SmokeKind::Torpedo), pt_acc_mod(att, def, 0.7, false))
        .with_bonus(att.bonus_acc(|| false));
    let ev = def.evasion(def.fm().torp_ev, def.core.imp.ev_torp);
    AccTerms { hit, luck: a.luck, hidden_acc: a.hidden_acc, ev, crit_mod: 1.5, plane: None, crit_flat: 0.0, crit_dmg: 1.0 }
}

// ---------------------------------------------------------------- night ----

/// Night environment from the attacker's point of view.
#[derive(Clone, Copy, Debug, Default)]
pub struct NightEnv {
    pub own_starshell: bool,
    pub enemy_starshell: bool,
    pub own_searchlight: bool,
    pub enemy_searchlight: bool,
    /// Accuracy stat of the attacker side's night contact plane.
    pub contact_acc: Option<f64>,
}

/// Night cut-in actually performed (after the DD x2 replacement roll).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NightAttack {
    pub ci: Option<NightCi>,
    pub double_variant: bool,
}

pub struct NightMods {
    pub dmg: f64,
    pub acc: f64,
    pub hits: u32,
}

/// Damage / accuracy multipliers and number of hits of a night attack (incl. D-gun and late-model
/// sub torpedo special cases).
pub fn night_mods(att: &ShipCore, na: NightAttack) -> NightMods {
    let Some(ci) = na.ci else {
        return NightMods { dmg: 1.0, acc: 1.0, hits: 1 };
    };
    let d = ci.data();
    let (mut dmg, acc, double) = match (na.double_variant, d.replace) {
        (true, Some((dm, ac, _, _))) => (dm, ac, true),
        _ => (d.dmg, d.acc, d.double),
    };
    match ci {
        NightCi::Torpedo => {
            if att.special_sub_torps >= 2 {
                dmg = 1.6;
            }
            if att.special_sub_torps > 0 && att.has_sub_radar {
                dmg = 1.75;
            }
        }
        NightCi::DdGtr | NightCi::DdLtr => {
            let count = att.d_gun_k2 + att.d_gun_k3;
            let count2 = att.d_gun_k3;
            dmg *= match count {
                0 => 1.0,
                1 => 1.25,
                _ => 1.4,
            };
            dmg *= match count2 {
                0 => 1.0,
                1 => 1.05,
                _ => 1.1,
            };
        }
        _ => {}
    }
    NightMods { dmg, acc, hits: if double { 2 } else { 1 } }
}

/// Night contact-plane effects: (power bonus, accuracy base multiplier, crit modifier).
fn contact_effects(contact_acc: Option<f64>) -> (f64, f64, f64) {
    match contact_acc {
        None => (0.0, 1.0, 1.5),
        Some(a) if a <= 1.0 => (5.0, 1.1, 1.57),
        Some(a) if a < 3.0 => (7.0, 1.15, 1.64),
        Some(_) => (9.0, 1.2, 1.7),
    }
}

#[inline]
pub fn night_acc(att: &Unit, def: &Unit, env: &NightEnv, na: NightAttack, sp: Option<Special>) -> AttackAcc {
    night_terms(att, def, env, na, sp).resolve()
}

pub fn night_terms(att: &Unit, def: &Unit, env: &NightEnv, na: NightAttack, sp: Option<Special>) -> AccTerms {
    let a = att.core;
    let (_, base_mul, crit_mod) = contact_effects(env.contact_acc);
    let acc_base = (69.0 + if env.own_starshell { 5.0 } else { 0.0 }) * base_mul;
    let mut acc_mod = att.fm().night_acc * morale_acc(att.st.morale, false);
    if att.form == Formation::Vanguard && def.core.class == ShipClass::DD {
        acc_mod *= 1.1;
    }
    acc_mod *= def.vanguard_target_mod(false);
    acc_mod *= night_mods(a, na).acc;
    if let Some(s) = sp {
        acc_mod *= s.acc;
    }
    let tail = HitTail::Night { fit: a.fit_acc * 0.01, searchlight: env.own_searchlight, ca: a.ca_night_acc * 0.01 };
    let (post, np) = post_flat(a.imp.acc_nb, a, def.core);
    let hit = HitFn::new(acc_base, a.level, a.acc, &post[..np], acc_mod, tail)
        .with(1.0, pt_acc_mod(att, def, 0.7, true))
        .with_bonus(att.bonus_acc(|| a.can_night_air(att.st)));
    let d = def.core;
    let mut ev_mod = def.fm().night_ev;
    let mut ev_flat = if matches!(d.class, ShipClass::CA | ShipClass::CAV) { 5.0 } else { 0.0 };
    if d.class == ShipClass::DD && d.radars > 0 && d.has_lookout {
        ev_flat += 10.0;
    }
    if d.searchlight > 0 {
        ev_mod *= 0.2;
        ev_flat *= 0.2;
    }
    let ev = def.evasion(ev_mod, ev_flat);
    let terms = AccTerms { hit, luck: a.luck, hidden_acc: a.hidden_acc, ev, crit_mod, plane: None, crit_flat: 0.0, crit_dmg: 1.0 };
    if a.can_night_air(att.st) {
        let (crit_rate, crit_dmg, acc_plane) = a.proficiency(att.st);
        return AccTerms { plane: Some(PlaneBonus { acc: acc_plane, crit_rate }), crit_dmg, ..terms };
    }
    terms
}

/// Basic night power (kcsim `NBPower`): FP + TP (+★); vs installations FP × installation
/// multiplier + flat bonus (northernmost landing princess: + TP).
pub fn night_basic_power(att: &ShipCore, def: &ShipCore) -> f64 {
    if let Some(k) = def.target.kind {
        let sub = if att.class.is_sub() { 30.0 } else { 0.0 };
        let fp = att.fp + sub + att.imp.p_nb;
        let tp = if k == InstallationKind::Northernmost { att.tp } else { 0.0 };
        fp * att.vs.inst.mult(k).0 + tp + att.vs.inst.flat
    } else {
        att.fp + att.tp + att.imp.p_nb
    }
}

pub fn night_power(att: &Unit, def: &Unit, env: &NightEnv, na: NightAttack, sp: Option<Special>) -> f64 {
    let (bonus, _, _) = contact_effects(env.contact_acc);
    let mut pre = damage_state_mod(att.hp_ratio()) * night_mods(att.core, na).dmg;
    if att.form == Formation::Vanguard && formation::vanguard_front(att.idx, att.len) {
        pre *= 0.5;
    }
    if let Some(s) = sp {
        pre *= s.pow;
    }
    let basic = if att.core.can_night_air(att.st) { night_air_power(att, def.core) } else { night_basic_power(att.core, def.core) };
    let pow = soft_cap((basic + bonus + att.core.fit_fp) * pre, CAP_NIGHT).floor() * target_post(att.core, def.core);
    let pow = att.bonus_dmg(pow, || att.core.can_night_air(att.st));
    if def.core.target.pt {
        // kcsim `NBattack`: the PT transform × 0.6 at night.
        pt_damage(att.core, def.core, pow) * 0.6
    } else {
        pow
    }
}

/// Carrier night air attack power (kcsim `CV.NBPower`): naked FP + naked TP (+ visible TP bonus)
/// + per night plane: FP + √★ + TP (torpedo planes, not vs installations) or bombing,
/// + 3 × planes and 0.45 × (FP + TP + ASW + bombing) × √planes (0.3 × … for Swordfish-type planes).
///
/// Ark Royal class without night aviation personnel: plus FP + TP + √★ of each Swordfish.
pub fn night_air_power(att: &Unit, def: &ShipCore) -> f64 {
    let a = att.core;
    let mut power = a.naked.fp + a.naked.tp;
    if !def.is_installation {
        power += a.bonus.tp;
    }
    if !a.night_air_gear {
        for e in a.slots.iter().flatten().filter(|e| e.has(f::SWORDFISH)) {
            power += e.fp + e.tp + (e.level as f64).sqrt();
        }
        return power.max(0.0);
    }
    for (i, e) in a.slots.iter().enumerate() {
        let Some(e) = e else { continue };
        if !e.has(f::NIGHT_PLANE) {
            continue;
        }
        let n = att.st.planes[i].max(0) as f64;
        let mut m = 0.3 * (e.fp + e.tp + e.asw + e.bomb);
        power += e.fp + (e.level as f64).sqrt();
        if e.cat == cat::TORP_BOMBER {
            if !def.is_installation {
                power += e.tp;
            }
        } else {
            power += e.bomb;
        }
        if !e.has(f::NIGHT_BOMBER2) {
            power += 3.0 * n;
            m *= 1.5;
        }
        power += m * n.sqrt();
    }
    power.max(0.0)
}

// ------------------------------------------------------------------ air ----

#[inline]
pub fn air_acc(att: &Unit, def: &Unit) -> AttackAcc {
    air_terms(att, def).resolve()
}

pub fn air_terms(att: &Unit, def: &Unit) -> AccTerms {
    let a = att.core;
    let (crit_rate, crit_dmg, acc_plane) = a.proficiency(att.st);
    let ev = def.evasion(1.0, 0.0);
    // Event bonus: ship × plane-group accuracy (kcsim takes the plane groups only; see `Bonus::acc`).
    let acc = (0.95 + def.cf.air_acc) * att.bonus_acc(|| true);
    let hit = HitFn::new(0.0, 0.0, 0.0, &[], 0.0, HitTail::Fixed(acc));
    AccTerms {
        hit, luck: a.luck, hidden_acc: a.hidden_acc, ev, crit_mod: 0.0, plane: Some(PlaneBonus { acc: acc_plane, crit_rate }), crit_flat: 0.0,
        crit_dmg,
    }
}

/// Airstrike power of one slot before the torpedo-bomber random multiplier is known:
/// returns (planebase, is_dive). Power = (25 + √n·planebase) × mult.
pub fn air_plane_base(att: &ShipCore, slot: usize, def: &ShipCore) -> (f64, bool) {
    let Some(e) = att.slots[slot].as_ref() else { return (0.0, true) };
    let dive = e.has(f::DIVE);
    let mut base = if dive { e.bomb } else if def.is_installation { 0.0 } else { e.tp };
    if e.has(f::AUTOGYRO_LIKE) {
        base = 0.0;
    }
    if base > 0.0 {
        base += e.air_power_improve;
    }
    (base, dive)
}

/// Post-cap airstrike power (before crit and the target bonus [`air_target_mod`]), given the
/// torpedo-bomber multiplier (1 for dive bombers) and the power base ([`AIR_BASE`], lower
/// against combined fleets). Skip bombers take their pre-cap target multiplier here.
pub fn air_power(att: &ShipCore, slot: usize, planes: i32, def: &ShipCore, mult: f64, contact: f64, base_pow: f64) -> f64 {
    let (base, _) = air_plane_base(att, slot, def);
    let mut pow = (base_pow + (planes.max(0) as f64).sqrt() * base) * mult;
    if let Some(e) = att.slots[slot].as_ref() {
        pow *= crate::install::skip_bomber_mod(e.id, def.class, def.is_installation);
        if e.has(f::JET) {
            pow = pow * 0.7 + 0.5;
        }
    }
    soft_cap(pow, CAP_AIR).floor() * contact
}

/// Post-cap target bonus of an airstrike from `slot` (kcsim `airstrike`): `(p, high, low)`, × `high`
/// with probability `p` else × `low` (special abyssal targets, PT imps, supply depots, dive-bomber
/// weakness), times the special-target group multiplier.
pub fn air_target_mod(att: &ShipCore, slot: usize, def: &ShipCore) -> (f64, f64, f64) {
    let dive = att.slots[slot].as_ref().is_some_and(|e| e.has(f::DIVE));
    let t = &def.target;
    let (p, hi, lo) = airstrike_target_mod(def.master_id, t.pt, t.supply_depot, dive, t.divebomb_weak);
    let g = t.group.map_or(1.0, |g| if g == crate::model::TargetGroup::Anchorage { 1.0 } else { att.vs.inst.group(g) });
    (p, hi * g, lo * g)
}
