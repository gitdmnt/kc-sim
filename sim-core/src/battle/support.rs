//! Support expeditions (支援艦隊): type, arrival, shelling / long-range torpedo / air /
//! anti-submarine support. Ported from KC3Kai/kancolle-replay `js/kcsim.js` (`sim` support block,
//! `supportPhase`, `supportASW`, `airstrikeSupportASW`, `airstrike(…, issupport)`,
//! `AADefenceBombersAndAirstrike(…, issupport)`, `compareAP`, `AADefenceFighters`) and
//! `js/kcships.js` (`Fleet.getSupportType`, `Fleet.supportChance`), MIT © fourinone41. Checked
//! against wikiwiki.jp 支援艦隊; differences are listed in docs/SIM_INTERFACE.md.
//!
//! The support fleet takes the friend side's place for the phase ([`Battle::with_fleet`]): events
//! carry the support ship index and damage is credited to the support ship, not to a friend MVP.

use super::air::friend_fighter_loss;
use super::{calc, validate_fleet, Battle, FleetCore, List, MAX_SHIPS};
use crate::equipment::{cat, f, Equip};
use crate::formation::{self, countered};
use crate::formulas::{self, soft_cap, Roll};
use crate::model::*;
use crate::ship::{ShipClass, ShipCore, ShipState, MAX_SLOTS};

/// kcsim `SIMCONSTS.supportDmgCap` (shelling / torpedo) and `airDmgCap` (air / ASW support).
const CAP_SUPPORT: f64 = 170.0;
/// Ships of a support fleet.
const MAX_SUPPORT: usize = 6;

/// kcsim fleet `supportType`: anti-submarine support is the air type against submarines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    None,
    Air,
    Shelling,
    Torpedo,
}

/// Static data of one support fleet.
pub struct SupportCore {
    pub fleet: FleetCore,
    pub init: Vec<ShipState>,
    kind: Kind,
    /// An air-capable ship carries a bomber (kcsim `canAirSupport`).
    can_air: bool,
    /// kcsim `canASWSupport`: a light carrier and (a CVL/AV/CL/CT/AO/LHA with an ASW-capable plane,
    /// or two escorts).
    can_asw: bool,
    chance: f64,
}

/// kcEQDATA `canSupportASW` types with ASW > 0 (kcships `Equip`).
fn can_support_asw(e: &Equip) -> bool {
    e.asw > 0.0
        && matches!(
            e.cat,
            cat::TORP_BOMBER | cat::DIVE_BOMBER | cat::SEAPLANE | cat::SEAPLANE_BOMBER | cat::AUTOGYRO | cat::ASW_PLANE | cat::FLYING_BOAT | cat::SEAPLANE_FIGHTER
        )
}

/// Fighter-power planes of an air support fleet: kcships `getSupportType` clears `isfighter` of
/// autogyros and ASW patrol planes (`MECHANICS.aswPlaneAir`).
fn support_fighter(e: &Equip) -> bool {
    e.has(f::FIGHTER) && !e.has(f::AUTOGYRO_LIKE)
}

fn enemy_fighter(e: &Equip) -> bool {
    e.has(f::FIGHTER)
}

/// kcships `Fleet.getSupportType` (`MECHANICS.LBASBuff`): (type, canAirSupport, canASWSupport).
fn derive(ships: &[ShipCore]) -> (Kind, bool, bool) {
    use ShipClass::*;
    let (mut dd, mut cv, mut air1, mut air2, mut shell, mut bb, mut ca, mut cvl, mut de) = (0, 0, 0, 0, 0, 0, 0, 0, 0);
    let (mut bomber, mut asw) = (false, false);
    for c in ships {
        let k = c.class;
        dd += (k == DD) as u32;
        cv += matches!(k, CVL | CV | CVB) as u32;
        air1 += matches!(k, AV | LHA) as u32;
        air2 += matches!(k, BBV | CAV | AO) as u32;
        shell += matches!(k, BB | FBB | CA) as u32;
        bb += matches!(k, BB | FBB | BBV) as u32;
        ca += matches!(k, CA | CAV) as u32;
        cvl += (k == CVL) as u32;
        de += (k == DE) as u32;
        let mut eq = c.slots.iter().flatten();
        bomber |= matches!(k, CVL | CV | CVB | AV | LHA | BBV | CAV | AO) && eq.clone().any(|e| e.has(f::BOMBER));
        asw |= matches!(k, CVL | AV | CL | CT | AO | LHA) && eq.any(can_support_asw);
    }
    let kind = if dd < 2 {
        Kind::None
    } else if (shell == 0 && (cv > 0 || air1 >= 2 || air2 >= 2)) || (shell > 0 && cv + air1 >= 2) {
        Kind::Air
    } else if bb >= 2 || bb + ca >= 4 {
        Kind::Shelling
    } else {
        Kind::Torpedo
    };
    (kind, bomber, cvl > 0 && (asw || de >= 2))
}

impl SupportCore {
    /// `boss`: boss support (決戦支援), higher base arrival chance.
    pub fn new(input: &SupportInput, boss: bool) -> Result<SupportCore, String> {
        validate_fleet("support", &input.fleet, false)?;
        if !input.fleet.escort_ships().is_empty() {
            return Err("support fleet: must be a single fleet (no escort)".into());
        }
        if input.fleet.ships.len() > MAX_SUPPORT {
            return Err(format!("support fleet has {} ships (max {MAX_SUPPORT})", input.fleet.ships.len()));
        }
        if input.chance.is_some_and(|c| !(0.0..=1.0).contains(&c)) {
            return Err("support.chance must be in [0, 1]".into());
        }
        let (fleet, init) = FleetCore::build(&input.fleet, true);
        let (derived, can_air, can_asw) = derive(&fleet.ships);
        let (kind, can_asw) = match input.kind {
            None => (derived, can_asw),
            Some(SupportType::Air) => (Kind::Air, can_asw),
            Some(SupportType::Asw) => (Kind::Air, true),
            Some(SupportType::Shelling) => (Kind::Shelling, can_asw),
            Some(SupportType::Torpedo) => (Kind::Torpedo, can_asw),
        };
        // kcships `Fleet.supportChance`: 50% (boss 85%), +15% sparkled flagship, +5% per other
        // sparkled ship.
        let chance = input.chance.unwrap_or_else(|| {
            let mut c = if boss { 0.85 } else { 0.5 };
            for (i, s) in init.iter().enumerate() {
                if s.morale > 49 {
                    c += if i == 0 { 0.15 } else { 0.05 };
                }
            }
            c
        });
        Ok(SupportCore { fleet, init, kind, can_air, can_asw, chance })
    }
}

/// Support fleet of one battle: its state (plane counts carry over in sorties) and the result.
pub(super) struct SupportRun<'a> {
    core: &'a SupportCore,
    st: Vec<ShipState>,
    out: Option<SupportResult>,
}

/// Air state (2 AS+ .. −2 AI) of fighter powers `ap1` vs `ap2` (kcsim `compareAP`).
fn air_state(ap1: f64, ap2: f64, has_air: bool) -> i8 {
    if !has_air {
        0
    } else if ap1 >= ap2 * 3.0 {
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

impl<'a> Battle<'a> {
    /// Support fleet for this battle; `st` is its current state (sorties carry plane counts).
    pub fn set_support(&mut self, core: &'a SupportCore, st: Vec<ShipState>) {
        self.support = Some(SupportRun { core, st, out: None });
    }

    /// Support outcome; `None` when no support was set or the battle never reached the phase.
    pub fn support_result(&self) -> Option<SupportResult> {
        self.support.as_ref().and_then(|r| r.out)
    }

    /// The support fleet's state after the battle.
    pub fn take_support_st(&mut self) -> Option<Vec<ShipState>> {
        self.support.as_mut().map(|r| std::mem::take(&mut r.st))
    }

    /// Run `f` with `fleet` / `st` / `form` on the friend side (every ship engaged, no combined
    /// terms, no event bonuses): support and friend fleet phases reuse the engine's targeting,
    /// damage and logging.
    pub(super) fn with_fleet<R>(&mut self, fleet: &'a FleetCore, st: &mut Vec<ShipState>, form: Formation, f: impl FnOnce(&mut Self) -> R) -> R {
        let engaged = [(0, fleet.ships.len()), (0, self.len(1))];
        let fleet0 = std::mem::replace(&mut self.fleets[0], fleet);
        std::mem::swap(&mut self.st[0], st);
        let form0 = std::mem::replace(&mut self.setup.formations[0], form);
        let combined = self.combined.take();
        let engaged0 = std::mem::replace(&mut self.engaged, engaged);
        let bonus = std::mem::take(&mut self.bonus);
        let r = f(self);
        self.fleets[0] = fleet0;
        std::mem::swap(&mut self.st[0], st);
        self.setup.formations[0] = form0;
        self.combined = combined;
        self.engaged = engaged0;
        self.bonus = bonus;
        r
    }

    /// kcsim `sim` support block + `supportPhase`: arrival roll, then the attack, if the fleet's
    /// type may come here: `air` air / anti-submarine support, `surface` shelling / torpedo support.
    /// Night battles take shelling / torpedo support only; aerial battle nodes air support only
    /// (wikiwiki 支援艦隊 「航空戦マス … 航空支援のみ発生する」); a night-to-day battle takes shelling /
    /// torpedo support at night and air support in the day part (「払暁戦マス … 夜戦時に支援射撃または支援長距離
    /// 雷撃が発生する。昼戦に移行した後、本隊の航空戦の前に航空支援が発生する」).
    pub(super) fn support_phase(&mut self, air: bool, surface: bool) {
        let Some(run) = self.support.as_mut() else { return };
        let sc = run.core;
        let allowed = match sc.kind {
            Kind::Air => air,
            Kind::Shelling | Kind::Torpedo => surface,
            Kind::None => true,
        };
        if !allowed || !self.both_alive() {
            return;
        }
        let arrived = sc.kind != Kind::None && self.rng.chance(sc.chance);
        let mut kind = None;
        if arrived {
            let subs = !self.subs(1).is_empty();
            kind = match sc.kind {
                Kind::Air if subs && sc.can_asw => Some(SupportType::Asw),
                Kind::Air if sc.can_air => Some(SupportType::Air),
                Kind::Shelling => Some(SupportType::Shelling),
                Kind::Torpedo => Some(SupportType::Torpedo),
                _ => None,
            };
        }
        if let Some(k) = kind.filter(|&k| k == SupportType::Asw || !self.surface(1).is_empty()) {
            // The main fleet's formation counts only for a single friend fleet (kcsim
            // `FLEETS1[0].formation.id < 10`); a vanguard counts as its front half (`VANGUARD1`).
            let main_form = self.fleets[0].combined.is_none().then_some(self.setup.formations[0]);
            let mut st = std::mem::take(&mut self.support.as_mut().expect("support").st);
            let phase = std::mem::replace(&mut self.phase, Phase::Support);
            self.with_fleet(&sc.fleet, &mut st, Formation::LineAhead, |b| match k {
                SupportType::Shelling => b.support_fire(main_form, false),
                SupportType::Torpedo => b.support_fire(main_form, true),
                SupportType::Air => b.support_air(),
                SupportType::Asw => b.support_asw(),
            });
            self.phase = phase;
            self.support.as_mut().expect("support").st = st;
        }
        self.support.as_mut().expect("support").out = Some(SupportResult { arrived, kind });
    }

    /// First escort index of the enemy and whether it is a combined fleet.
    fn enemy_escort(&self) -> (usize, bool) {
        let es = self.escort_start(1);
        (es, es < self.len(1))
    }

    /// Shelling (支援射撃) / long-range torpedo (支援長距離雷撃) support: every ship picks a
    /// target first (no vanguard re-roll), then all fire. Against a combined enemy each shot goes
    /// to the main fleet 40% / escort 60% (a fleet with only submarines left still draws the shot,
    /// which is then lost).
    fn support_fire(&mut self, main_form: Option<Formation>, torpedo: bool) {
        let (es, enemy_cf) = self.enemy_escort();
        let surface = self.surface(1);
        let (mut tm, mut te) = (List::default(), List::default());
        for &t in surface.as_slice() {
            if t >= es {
                te.push(t);
            } else {
                tm.push(t);
            }
        }
        let subs = self.subs(1);
        let sub_m = subs.as_slice().iter().any(|&t| t < es);
        let sub_e = subs.as_slice().iter().any(|&t| t >= es);
        let mut attacks = [(0usize, 0usize, false); MAX_SHIPS];
        let mut na = 0;
        for i in 0..self.len(0) {
            if !self.alive(0, i) {
                continue;
            }
            let pool = if !enemy_cf {
                surface
            } else if te.is_empty() && !sub_e {
                tm
            } else if tm.is_empty() && !sub_m {
                te
            } else if self.rng.chance(0.4) {
                tm
            } else {
                te
            };
            if pool.is_empty() {
                continue;
            }
            let (t, covered) = self.choose_target_ex(1, pool.as_slice(), 0, false, None);
            attacks[na] = (i, t, covered);
            na += 1;
        }
        // No formation terms against a combined enemy either.
        let form = main_form.filter(|_| !enemy_cf);
        let main = form.map(|mf| formation::mods(mf, 0, MAX_SUPPORT));
        for &(i, d, covered) in &attacks[..na] {
            let c = self.core(0, i);
            let (morale, hp_ok, ammo) = {
                let st = &self.st[0][i];
                (st.morale, st.hp_ratio(c.max_hp) > 0.5, formulas::ammo_mod(st.ammo, st.ammo_max))
            };
            // kcships `canTorp`.
            if torpedo && !(c.has_torp_stat && hp_ok) {
                continue;
            }
            let def = self.unit(1, d);
            let mut acc_mod = formulas::morale_acc(morale, torpedo);
            if def.form == Formation::Vanguard {
                acc_mod *= formation::vanguard_target_acc(def.core.class, def.idx, false);
            }
            if let (Some(mf), Some(m)) = (form, main) {
                let dd = mf == Formation::Vanguard && def.core.class == ShipClass::DD;
                if torpedo {
                    acc_mod *= m.torp_acc * if dd { 1.2 } else { 1.0 };
                } else if !countered(mf, def.form) {
                    acc_mod *= m.shell_acc * if dd { 1.1 } else { 1.0 };
                }
            }
            // kcsim `SIMCONSTS.supportTorpAccBase` 54 / `supportShellN|B` 64. Equipment accuracy only:
            // no equipment-bonus accuracy (wikiwiki 支援艦隊 「装備ボーナスによる…命中値上昇は無効」) and no
            // improvement accuracy (「改修強化値…命中補正も加算されていない」).
            let base = if torpedo { 54.0 } else { 64.0 };
            let hit = formulas::hit_rate(base, c.level, c.luck, c.acc + c.hidden_acc, acc_mod);
            let fm = def.fm();
            let ev = def.evasion(if torpedo { fm.torp_ev } else { fm.shell_ev }, 0.0);
            let hc = formulas::accuracy_and_crit(hit, &ev, if torpedo { 1.2 } else { 1.0 }, None, 0.0);
            let roll = formulas::roll_hit(self.rng, &hc, 1.0);
            let hp_before = self.st[1][d].hp;
            let mut real = 0;
            if roll != Roll::Miss {
                let dc = self.core(1, d);
                // Torpedo: (TP + 8) × 0 — kcsim `FIXTORPEDOSUPPORT = false`, scratch damage only.
                let pow = if torpedo {
                    0.0
                } else {
                    let pre = self.eng * main.map_or(1.0, |m| m.shell_pow);
                    // FP + 4 without improvement firepower (wikiwiki 支援艦隊 「改修強化値(砲撃)は威力に
                    // 加算されず」); equipment-bonus firepower counts.
                    let basic = calc::shell_basic_power(c, dc, -1.0 - c.imp.p_shell);
                    soft_cap(basic * pre, CAP_SUPPORT).floor()
                };
                let dmg = formulas::damage_common(self.rng, pow, roll, dc.ar, ammo, hp_before);
                real = self.take_damage(1, d, dmg);
            }
            let kind = if torpedo { AttackKind::Torpedo } else { AttackKind::Shelling };
            self.record(kind, SpecialAttack::Normal, 0, i, d, covered, None, roll, real, hp_before, &hc);
        }
    }

    /// Fighter power of ships `lo..hi` of `side` for `pick` planes, `⌊AA × √n⌋` per slot without
    /// improvement or proficiency bonuses (wikiwiki 支援艦隊 「熟練度補正がなく、艦戦の改修効果が制空値に反映
    /// されない」), and whether any slot has such planes. `sunk`: ships already sunk count too
    /// (wikiwiki: 「撃沈した敵空母の艦載機も制空値判定に使われる」).
    fn fighter_power(&self, side: usize, lo: usize, hi: usize, pick: fn(&Equip) -> bool, sunk: bool) -> (f64, bool) {
        let (mut ap, mut has) = (0.0, false);
        for i in lo..hi {
            let c = self.core(side, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                let n = self.st[side][i].planes[s];
                if n <= 0 || !pick(e) {
                    continue;
                }
                has = true;
                if sunk || self.alive(side, i) {
                    ap += (e.aa * (n as f64).sqrt()).floor();
                }
            }
        }
        (ap, has)
    }

    /// Stage 1 of air / ASW support (kcsim `compareAP(support, enemy, pick, false, 'isfighter')`
    /// and `AADefenceFighters(support)`): support planes take friend stage 1 losses. With
    /// `enemy_losses` the enemy fighter-power planes (afloat ships) also take enemy stage 1 losses
    /// (wikiwiki 支援艦隊 「敵機の減少は割合撃墜のみ」; loss formula of the normal air phase, [unverified]).
    /// The enemy side is the fleet (main / escort) of `first`.
    fn support_stage1(&mut self, pick: fn(&Equip) -> bool, first: usize, enemy_losses: bool) {
        let (es, _) = self.enemy_escort();
        let (lo, hi) = if first >= es { (es, self.len(1)) } else { (0, es) };
        let (ap1, has1) = self.fighter_power(0, 0, self.len(0), pick, false);
        let (ap2, has2) = self.fighter_power(1, lo, hi, enemy_fighter, true);
        let air = air_state(ap1, ap2, has1 || has2);
        for i in 0..self.len(0) {
            let c = self.core(0, i);
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                let n = self.st[0][i].planes[s];
                if n > 0 && pick(e) {
                    let lost = friend_fighter_loss(self.rng, n, air, if e.has(f::JET) { 0.6 } else { 1.0 });
                    self.st[0][i].planes[s] = (n - lost).max(0);
                }
            }
        }
        if enemy_losses {
            let mut carriers = List::default();
            for i in lo..hi {
                if self.alive(1, i) {
                    carriers.push(i);
                }
            }
            self.fighter_losses(1, carriers, f::FIGHTER, -air);
        }
    }

    /// Afloat enemy ships (AA defenders).
    fn enemy_afloat(&self) -> List {
        let mut l = List::default();
        for i in 0..self.len(1) {
            if self.alive(1, i) {
                l.push(i);
            }
        }
        l
    }

    /// Stage 2 against support planes (kcsim `getAAShotProp` / `getAAShotFlat` × 0.8, enemy
    /// combined fleets × 0.8 main / 0.48 escort, no enemy AACI): returns the planes left.
    fn support_aa(&mut self, i: usize, s: usize, defenders: &List) -> i32 {
        let d = defenders.as_slice()[self.rng.below(defenders.len())];
        let (es, enemy_cf) = self.enemy_escort();
        let cfm = match (enemy_cf, d >= es) {
            (false, _) => 1.0,
            (true, false) => 0.8,
            (true, true) => 0.48,
        };
        let waa = self.core(1, d).weighted_aa * cfm;
        let n = self.st[0][i].planes[s];
        let prop = if self.rng.chance(0.5) { ((n as f64 * waa / 200.0).floor() * 0.8).floor() as i32 } else { 0 };
        let flat = if self.rng.chance(0.5) { ((waa + self.fleet_aa[1] * cfm) * 0.1875 * 0.8).floor() as i32 } else { 0 };
        let left = (n - prop - flat).max(0);
        self.st[0][i].planes[s] = left;
        left
    }

    /// Air support (航空支援): stage 1 (support and enemy planes take losses), stage 2 against enemy
    /// AA, airstrikes with accuracy 85%, no proficiency / contact, power (3 + √n × base) × type
    /// mult, cap 170, × 1.35 after the cap (kcsim `airstrike(…, issupport)`, wikiwiki 支援艦隊).
    fn support_air(&mut self) {
        let surface = self.surface(1);
        self.support_stage1(support_fighter, surface.as_slice()[0], true);
        let mut bombers = Vec::new();
        for i in 0..self.len(0) {
            let c = self.core(0, i);
            for s in 0..MAX_SLOTS {
                if c.slots[s].as_ref().is_some_and(|e| e.has(f::BOMBER)) && self.st[0][i].planes[s] > 0 {
                    bombers.push((i, s));
                }
            }
        }
        let defenders = self.enemy_afloat();
        let mut attacks = Vec::with_capacity(bombers.len());
        for (i, s) in bombers {
            if !defenders.is_empty() && self.support_aa(i, s, &defenders) <= 0 {
                continue;
            }
            // kcsim `choiceWProtect(targets, null, true)`: escort ships may cover the flagship.
            let (t, covered) = self.choose_target_ex(1, surface.as_slice(), 0, true, Some(true));
            attacks.push((i, s, t, covered));
        }
        for (i, s, d, covered) in attacks {
            let def = self.unit(1, d);
            let hc = formulas::accuracy_and_crit(0.85 + def.cf.air_acc, &def.evasion(1.0, 0.0), 0.0, None, 0.0);
            let roll = formulas::roll_hit(self.rng, &hc, 1.0);
            let hp_before = self.st[1][d].hp;
            let mut real = 0;
            if roll != Roll::Miss {
                let (att, dc) = (self.core(0, i), self.core(1, d));
                let (_, dive) = calc::air_plane_base(att, s, dc);
                let mult = if dive {
                    1.0
                } else if self.rng.chance(0.5) {
                    0.8
                } else {
                    1.5
                };
                let st = &self.st[0][i];
                let pow = calc::air_power(att, s, st.planes[s], dc, mult, 1.0, 3.0) * 1.35;
                let ammo = formulas::ammo_mod(st.ammo, st.ammo_max);
                let dmg = formulas::damage_common(self.rng, pow, roll, dc.ar, ammo, hp_before);
                real = self.take_damage(1, d, dmg);
            }
            self.record(AttackKind::Air, SpecialAttack::Normal, 0, i, d, covered, Some(s), roll, real, hp_before, &hc);
        }
    }

    /// Anti-submarine support (対潜支援哨戒, kcsim `supportASW` / `airstrikeSupportASW`):
    /// `canSupportASW` planes only; stage 1 and enemy AA as for air support; accuracy 50%; power
    /// ⌊0.6 × plane ASW⌋ × √n + 3, cap 170, × 1.75 × (1.2 40% / 1.5 10% / 2 50%). Against a
    /// combined enemy each attack picks the main / escort submarines 50/50.
    fn support_asw(&mut self) {
        let subs = self.subs(1);
        self.support_stage1(can_support_asw, subs.as_slice()[0], false);
        let (es, enemy_cf) = self.enemy_escort();
        let (mut sm, mut se) = (List::default(), List::default());
        for &t in subs.as_slice() {
            if t >= es {
                se.push(t);
            } else {
                sm.push(t);
            }
        }
        let defenders = self.enemy_afloat();
        let mut attacks = Vec::new();
        for i in 0..self.len(0) {
            let c = self.core(0, i);
            for s in 0..MAX_SLOTS {
                if !c.slots[s].as_ref().is_some_and(can_support_asw) || self.st[0][i].planes[s] <= 0 {
                    continue;
                }
                if !defenders.is_empty() && self.support_aa(i, s, &defenders) <= 0 {
                    continue;
                }
                let pool = if !enemy_cf {
                    subs
                } else if se.is_empty() {
                    sm
                } else if sm.is_empty() {
                    se
                } else if self.rng.chance(0.5) {
                    sm
                } else {
                    se
                };
                let (t, covered) = self.choose_target(1, pool.as_slice(), 0);
                attacks.push((i, s, t, covered));
            }
        }
        for (i, s, d, covered) in attacks {
            let def = self.unit(1, d);
            let hc = formulas::accuracy_and_crit(0.5, &def.evasion(1.0, 0.0), 0.0, None, 0.0);
            let roll = formulas::roll_hit(self.rng, &hc, 1.0);
            let hp_before = self.st[1][d].hp;
            let mut real = 0;
            if roll != Roll::Miss {
                let (att, dc) = (self.core(0, i), self.core(1, d));
                let e = att.slots[s].as_ref().expect("ASW plane");
                let st = &self.st[0][i];
                let base = (e.asw * 0.6).floor() * (st.planes[s] as f64).sqrt() + 3.0;
                let ammo = formulas::ammo_mod(st.ammo, st.ammo_max);
                let r = self.rng.f64();
                let post = 1.75
                    * if r < 0.4 {
                        1.2
                    } else if r < 0.5 {
                        1.5
                    } else {
                        2.0
                    };
                let pow = soft_cap(base, CAP_SUPPORT).floor() * post;
                let dmg = formulas::damage_common(self.rng, pow, roll, calc::effective_armor(att, dc), ammo, hp_before);
                real = self.take_damage(1, d, dmg);
            }
            self.record(AttackKind::Asw, SpecialAttack::Normal, 0, i, d, covered, Some(s), roll, real, hp_before, &hc);
        }
    }
}
