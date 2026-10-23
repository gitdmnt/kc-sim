//! Fleet special attacks (特殊砲撃: Nelson Touch, Nagato / Mutsu / Colorado / Richelieu / Queen
//! Elizabeth cut-ins, Kongou-class night attack, Yamato-class 2/3-ship attacks, submarine fleet
//! attack) and night Zuiun cut-ins. Conditions, attackers and modifiers are ported from
//! KC3Kai/kancolle-replay `js/kcsim.js` (`canSpecialAttack`, `canSpecialAttackUnique`,
//! `getSpecialAttackShips`, `getSpecialAttackMod`, `NBATTACKDATA` 2001–2004) and kcSHIPDATA
//! `attackSpecial`, MIT © fourinone41. Trigger rates: see [`Rates`].
//!
//! Combined fleets (kcsim `ship.isescort`, formations 12 / 14): every special attack but the
//! Kongou-class one is led by the main-fleet flagship in the main fleet's shelling round; the
//! Kongou-class night attack is led by the escort flagship (the fleet fighting at night).

use super::calc::Special;
use super::{Battle, List};
use crate::equipment::f;
use crate::model::{Engagement, FleetInput, Formation, SpecialAttack, SpecialAttackRates};
use crate::ship::{ShipClass, ShipCore};

/// Fleet special attack kind (kcsim `attackSpecial`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fsa {
    /// 100
    Nelson,
    /// 101
    Nagato,
    /// 102
    Mutsu,
    /// 103
    Colorado,
    /// 104 (night only)
    Kongou,
    /// 105
    Richelieu,
    /// 106
    QueenElizabeth,
    /// 300 / 301 / 302
    Sub,
    /// 400
    Yamato3,
    /// 401
    Yamato2,
    /// Night Zuiun cut-in (kcsim 200 with type 2001..2004).
    NightZuiun(SpecialAttack),
}

impl Fsa {
    pub fn event(self) -> SpecialAttack {
        match self {
            Fsa::Nelson => SpecialAttack::NelsonTouch,
            Fsa::Nagato => SpecialAttack::NagatoCutin,
            Fsa::Mutsu => SpecialAttack::MutsuCutin,
            Fsa::Colorado => SpecialAttack::ColoradoCutin,
            Fsa::Kongou => SpecialAttack::KongouCutin,
            Fsa::Richelieu => SpecialAttack::RichelieuCutin,
            Fsa::QueenElizabeth => SpecialAttack::QueenElizabethCutin,
            Fsa::Sub => SpecialAttack::SubFleetAttack,
            Fsa::Yamato3 => SpecialAttack::YamatoCutin3,
            Fsa::Yamato2 => SpecialAttack::YamatoCutin2,
            Fsa::NightZuiun(s) => s,
        }
    }
}

/// Night Zuiun cut-in (power, accuracy) multipliers (kcsim NBATTACKDATA 2001..2004).
pub fn night_zuiun_mods(s: SpecialAttack) -> Option<(f64, f64)> {
    match s {
        SpecialAttack::NightZuiunZzr => Some((1.36, 1.07)),
        SpecialAttack::NightZuiunZz => Some((1.32, 1.07)),
        SpecialAttack::NightZuiunZr => Some((1.28, 1.07)),
        SpecialAttack::NightZuiunZ => Some((1.24, 1.07)),
        _ => None,
    }
}

/// Friend sortie state carried between nodes (kcsim `Fleet.didSpecial`, `numSpecialKongou`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FleetCarry {
    /// A fleet special attack (once per sortie) was used.
    pub special_used: bool,
    /// Kongou-class night attacks used (max 3 per sortie, counted apart from the others).
    pub kongou_count: u32,
}

impl FleetCarry {
    pub fn of(f: &FleetInput) -> FleetCarry {
        FleetCarry { special_used: f.special_attack_used.unwrap_or(false), kongou_count: f.kongou_special_count.unwrap_or(0) }
    }

    /// Write into an input-shaped fleet (fields stay absent while unused).
    pub fn write(self, f: &mut FleetInput) {
        f.special_attack_used = self.special_used.then_some(true);
        f.kongou_special_count = (self.kongou_count > 0).then_some(self.kongou_count);
    }
}

/// Trigger-rate overrides as fractions; `None` = default, see `Battle::special_rate` (wikiwiki
/// level / luck estimates; kcsim `SIMCONSTS` for Yamato 3-ship 80%, submarine fleet 80% with a 60%
/// second attack).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rates {
    pub nelson: Option<f64>,
    pub nagato: Option<f64>,
    pub mutsu: Option<f64>,
    pub colorado: Option<f64>,
    pub kongou: Option<f64>,
    pub richelieu: Option<f64>,
    pub qe: Option<f64>,
    pub yamato3: Option<f64>,
    pub yamato2: Option<f64>,
    pub sub: Option<f64>,
    pub sub2: Option<f64>,
}

impl Rates {
    pub fn new(r: Option<&SpecialAttackRates>) -> Rates {
        let Some(r) = r else { return Rates::default() };
        let p = |v: Option<f64>| v.map(|v| v.clamp(0.0, 100.0) / 100.0);
        Rates {
            nelson: p(r.nelson_touch),
            nagato: p(r.nagato),
            mutsu: p(r.mutsu),
            colorado: p(r.colorado),
            kongou: p(r.kongou),
            richelieu: p(r.richelieu),
            qe: p(r.queen_elizabeth),
            yamato3: p(r.yamato3),
            yamato2: p(r.yamato2),
            sub: p(r.sub_fleet),
            sub2: p(r.sub_fleet_second),
        }
    }
}

const BIG7: [u32; 9] = [275, 541, 276, 573, 576, 601, 1496, 913, 918];
const NELSON: [u32; 4] = [571, 572, 576, 577];
const COLORADO: [u32; 4] = [601, 913, 918, 1496];
const KONGOU: [u32; 5] = [591, 592, 593, 694, 954];
const RICHELIEU: [u32; 3] = [392, 724, 969];
const QE: [u32; 2] = [364, 733];
const YAMATO_K2: [u32; 3] = [546, 911, 916];
/// Duplex rangefinder radars (15m二重測距儀＋21号電探改二 and its Kai).
const DUPLEX: [u32; 2] = [142, 460];

fn count_ids(c: &ShipCore, ids: &[u32]) -> usize {
    c.slots.iter().flatten().filter(|e| ids.contains(&e.id)).count()
}

/// Formation allowed for a special attack: the single-fleet formations, or the combined
/// formation kcsim accepts (12 第二警戒航行序列 / 14 第四警戒航行序列).
fn formation_ok(form: Formation, single: &[Formation], combined: &[Formation]) -> bool {
    single.contains(&form) || combined.contains(&form)
}

impl<'a> Battle<'a> {
    fn hp(&self, i: usize) -> f64 {
        self.st[0][i].hp_ratio(self.core(0, i).max_hp)
    }

    /// Friend fleet led by flagship `flag` (main fleet or escort): its index range.
    fn fleet_range(&self, flag: usize) -> (usize, usize) {
        if flag == 0 {
            (0, self.fleets[0].escort_start)
        } else {
            (flag, self.len(0))
        }
    }

    /// Default trigger rate of a special attack (fraction) from the participants' level and luck.
    /// All are community estimates [unverified]; sources: wikiwiki.jp/kancolle Nelson, 長門改二,
    /// 大和改二, 金剛改二丙, Warspite改 / Richelieu改 (formula unknown, "possibly Nagato's"),
    /// Colorado (SG radar late +5); kcsim `SIMCONSTS` where no estimate exists.
    fn special_rate(&self, kind: Fsa, lo: usize) -> f64 {
        let r = self.special_rates;
        let c = |p: usize| self.core(0, lo + p);
        let lv = |p: usize| c(p).level.sqrt();
        let lk = |p: usize| c(p).luck.max(0.0).sqrt();
        let pct = |x: f64| (x.floor() / 100.0).clamp(0.0, 1.0);
        match kind {
            // ⌊1.1√Lv₁ + √Lv₃ + √Lv₅ + 1.4√Luck₁ + 25⌋
            Fsa::Nelson => r.nelson.unwrap_or_else(|| pct(1.1 * lv(0) + lv(2) + lv(4) + 1.4 * lk(0) + 25.0)),
            // ⌊√Lv₁ + √Lv₂ + 1.2(√Luck₁ + √Luck₂) + 30⌋ (wikiwiki 長門改二; Nagato Lv99 luck 40 + Mutsu
            // Lv99 luck 16 ≈ 62%). Warspite改 / Richelieu改 suggest the same formula for their touches.
            Fsa::Nagato | Fsa::Mutsu | Fsa::QueenElizabeth | Fsa::Richelieu => {
                let o = match kind {
                    Fsa::Nagato => r.nagato,
                    Fsa::Mutsu => r.mutsu,
                    Fsa::QueenElizabeth => r.qe,
                    _ => r.richelieu,
                };
                o.unwrap_or_else(|| pct(lv(0) + lv(1) + 1.2 * (lk(0) + lk(1)) + 30.0))
            }
            // wikiwiki 大和改二: ⌊√Lv₁ + √Lv₂ + √Luck₁ + √Luck₂ + 40 (Yamato-class pair) | 35 (others)
            // + 10 per participant with a radar of accuracy ≥ 8 + 2 with a Yamato flagship⌋.
            Fsa::Yamato2 => r.yamato2.unwrap_or_else(|| {
                let pair = if YAMATO_K2.contains(&c(1).master_id) { 40.0 } else { 35.0 };
                let yamato_flag = if matches!(c(0).master_id, 911 | 916) { 2.0 } else { 0.0 };
                let radar = |p: usize| c(p).slots.iter().flatten().any(|e| e.has(f::RADAR) && e.acc >= 8.0);
                let b = 10.0 * (radar(0) as u8 + radar(1) as u8) as f64;
                pct(lv(0) + lv(1) + lk(0) + lk(1) + pair + b + yamato_flag)
            }),
            // ⌊3.5(√Lv₁ + √Lv₂) + 1.1(√Luck₁ + √Luck₂) + A + B − 33⌋, A / B: flagship surface radar
            // (LoS ≥ 8) / large searchlight, per flagship (Kirishima [unverified]).
            Fsa::Kongou => r.kongou.unwrap_or_else(|| {
                let f0 = c(0);
                let (ra, sl) = match f0.master_id {
                    591 => (30.0, 10.0),
                    592 => (10.0, 30.0),
                    593 => (15.0, 0.0),
                    954 => (20.0, 0.0),
                    _ => (20.0, 20.0),
                };
                let radar = f0.slots.iter().flatten().any(|e| e.has(f::SURFACE_RADAR) && e.los >= 8.0);
                let light = f0.slots.iter().flatten().any(|e| e.has(f::SEARCHLIGHT_L));
                let bonus = if radar { ra } else { 0.0 } + if light { sl } else { 0.0 };
                pct(3.5 * (lv(0) + lv(1)) + 1.1 * (lk(0) + lk(1)) + bonus - 33.0)
            }),
            // kcsim 60%, + 5 per participant with an SG radar (late model, id 456) (wikiwiki Colorado).
            Fsa::Colorado => r.colorado.unwrap_or_else(|| (0.6 + 0.05 * (0..3).filter(|&p| count_ids(c(p), &[456]) > 0).count() as f64).min(1.0)),
            Fsa::Yamato3 => r.yamato3.unwrap_or(0.8),
            Fsa::Sub => r.sub.unwrap_or(0.8),
            Fsa::NightZuiun(_) => 0.0,
        }
    }

    fn roll_special(&mut self, kind: Fsa, lo: usize) -> bool {
        let p = self.special_rate(kind, lo);
        self.rng().chance(p)
    }

    /// kcsim `canSpecialAttackUnique` for the turn of the friend flagship `flag` (main fleet or,
    /// at night in a combined fleet, the escort); on success the attackers in order.
    pub(super) fn try_fleet_special(&mut self, night: bool, flag: usize) -> Option<(Fsa, List)> {
        let (lo, hi) = self.fleet_range(flag);
        let len = hi - lo;
        if len == 0 || !self.alive(0, lo) {
            return None;
        }
        // kcsim `isNoSpecialNode`: no fleet special attack against a fleet of PT imps only.
        if self.fleets[1].ships.iter().all(|c| c.target.pt) {
            return None;
        }
        let c0 = self.core(0, lo);
        let mid = c0.master_id;
        let leader = c0.class == ShipClass::AS || [&KONGOU[..], &YAMATO_K2, &NELSON, &COLORADO, &RICHELIEU, &QE, &[541, 573]].iter().any(|l| l.contains(&mid));
        if !leader {
            return None;
        }
        let escort = flag != 0;
        let form = self.setup.formations[0];
        let at = |p: usize| lo + p;
        let mid_at = |p: usize| if p < len { self.core(0, lo + p).master_id } else { 0 };
        let list = |idx: &[usize]| {
            let mut l = List::default();
            for &p in idx {
                l.push(lo + p);
            }
            l
        };
        let surface = (lo..hi).filter(|&i| self.alive(0, i) && !self.core(0, i).class.is_sub()).count();
        use Formation::*;

        if c0.class == ShipClass::AS {
            if escort || (!night && self.carry.special_used) || c0.level < 30.0 || !matches!(form, Echelon | LineAbreast) {
                return None;
            }
            if self.hp(lo) <= 0.25 || len < 3 || !self.core(0, at(1)).class.is_sub() || !self.core(0, at(2)).class.is_sub() {
                return None;
            }
            let s3 = len > 3 && self.core(0, at(3)).class.is_sub();
            let (a, b) = if s3 && self.hp(at(1)) > 0.5 && self.hp(at(3)) > 0.5 {
                (1, 3)
            } else if s3 && self.hp(at(2)) > 0.5 && self.hp(at(3)) > 0.5 {
                (2, 3)
            } else if self.hp(at(1)) > 0.5 && self.hp(at(2)) > 0.5 {
                (1, 2)
            } else {
                return None;
            };
            if !self.roll_special(Fsa::Sub, lo) {
                return None;
            }
            self.carry.special_used = true;
            let second = self.special_rates.sub2.unwrap_or(0.6);
            let mut l = List::default();
            for s in [at(a), at(b)] {
                l.push(s);
                let c = self.core(0, s);
                if c.level >= 75.0 && (c.has_sub_radar || self.rng().chance(second)) {
                    l.push(s);
                }
            }
            return Some((Fsa::Sub, l));
        }

        if KONGOU.contains(&mid) {
            if self.carry.kongou_count >= 3 || !night || surface < 5 || len < 2 {
                return None;
            }
            if !formation_ok(form, &[LineAhead, Echelon], &[CombinedForward, CombinedBattle]) || self.hp(lo) <= 0.25 || self.hp(at(1)) <= 0.25 {
                return None;
            }
            let m1 = mid_at(1);
            let ok = match mid {
                591 => [592, 151, 593, 954, 694, 439, 364, 927, 733].contains(&m1),
                592 => [591, 152, 694, 593, 954].contains(&m1),
                593 | 954 => [591, 592, 694].contains(&m1),
                _ => [591, 592, 593, 954, 697].contains(&m1),
            };
            if !ok || !self.roll_special(Fsa::Kongou, lo) {
                return None;
            }
            self.carry.kongou_count += 1;
            return Some((Fsa::Kongou, list(&[0, 1])));
        }

        // The others: main-fleet flagship, once per sortie, six afloat surface ships.
        if escort || self.carry.special_used || surface < 6 || len < 3 {
            return None;
        }
        let bb = |p: usize| self.core(0, at(p)).class.is_bb_class();
        let (kind, attackers): (Fsa, &[usize]) = if YAMATO_K2.contains(&mid) {
            if !formation_ok(form, &[Echelon], &[CombinedBattle]) || self.hp(lo) <= 0.5 || self.hp(at(1)) <= 0.5 {
                return None;
            }
            let (m2, m3) = (mid_at(1), mid_at(2));
            if (mid == 911 || mid == 916) && self.hp(at(2)) > 0.5 {
                const GROUPS: [[u32; 2]; 16] = [
                    [541, 573], [553, 554], [411, 412], [364, 576], [364, 733], [576, 577], [591, 592], [591, 593], [591, 954], [591, 694],
                    [592, 694], [697, 659], [1496, 918], [446, 447], [392, 724], [969, 724],
                ];
                let group = GROUPS.iter().any(|g| g.contains(&m2) && g.contains(&m3));
                if (group || (m2 == 546 && [541, 573].contains(&m3))) && self.roll_special(Fsa::Yamato3, lo) {
                    self.carry.special_used = true;
                    return Some((Fsa::Yamato3, list(&[0, 1, 2])));
                }
            }
            let pair = ((mid == 911 || mid == 916) && [546, 178, 360, 392, 969, 724].contains(&m2)) || (mid == 546 && [911, 916].contains(&m2));
            if !pair {
                return None;
            }
            (Fsa::Yamato2, &[0, 0, 1])
        } else if NELSON.contains(&mid) {
            if len < 5 || !formation_ok(form, &[DoubleLine], &[CombinedForward]) || self.hp(lo) <= 0.5 {
                return None;
            }
            let (c2, c4) = (self.core(0, at(2)), self.core(0, at(4)));
            if c2.cv_like() || c4.cv_like() || c2.class.is_sub() || c4.class.is_sub() {
                return None;
            }
            (Fsa::Nelson, &[0, 2, 4])
        } else if mid == 541 || mid == 573 {
            if !formation_ok(form, &[Echelon], &[CombinedForward]) || self.hp(lo) <= 0.5 || !bb(1) || self.hp(at(1)) <= 0.25 {
                return None;
            }
            (if mid == 541 { Fsa::Nagato } else { Fsa::Mutsu }, &[0, 0, 1])
        } else if COLORADO.contains(&mid) {
            if !formation_ok(form, &[Echelon], &[CombinedForward]) || self.hp(lo) <= 0.5 {
                return None;
            }
            if self.hp(at(1)) <= 0.25 || self.hp(at(2)) <= 0.25 || !bb(1) || !bb(2) {
                return None;
            }
            (Fsa::Colorado, &[0, 1, 2])
        } else if RICHELIEU.contains(&mid) {
            if !formation_ok(form, &[DoubleLine], &[CombinedForward]) || self.hp(lo) <= 0.5 {
                return None;
            }
            if !RICHELIEU.contains(&mid_at(1)) || self.hp(at(1)) <= 0.25 {
                return None;
            }
            (Fsa::Richelieu, &[0, 0, 1])
        } else if QE.contains(&mid) {
            if !formation_ok(form, &[Echelon], &[CombinedForward]) || self.hp(lo) <= 0.5 {
                return None;
            }
            if !QE.contains(&mid_at(1)) || self.hp(at(1)) <= 0.25 {
                return None;
            }
            (Fsa::QueenElizabeth, &[0, 0, 1])
        } else {
            return None;
        };
        if !self.roll_special(kind, lo) {
            return None;
        }
        self.carry.special_used = true;
        Some((kind, list(attackers)))
    }

    /// kcsim `canSpecialAttack` night part: night Zuiun cut-in of friend ship `a` (HP > 50%);
    /// `chance_pct` is its night cut-in chance before the HP term.
    pub(super) fn try_night_zuiun(&mut self, a: usize, chance_pct: f64, own_starshell: bool, own_searchlight: bool) -> Option<Fsa> {
        let c = self.core(0, a);
        if !c.night_zuiun || self.hp(a) <= 0.5 {
            return None;
        }
        let st = &self.st[0][a];
        let zuiun =
            c.slots.iter().enumerate().filter(|(i, e)| e.as_ref().is_some_and(|e| e.id == crate::equipment::ID_NIGHT_ZUIUN) && st.planes[*i] > 0).count();
        let radar = c.surface_radars > 0;
        let mut rate = chance_pct * 0.01;
        rate -= 0.14 * own_starshell as u8 as f64;
        rate -= 0.17 * own_searchlight as u8 as f64;
        if count_ids(c, &[crate::equipment::ID_SKILLED_LOOKOUTS]) > 0 {
            rate += 0.03;
        }
        if matches!(c.class, ShipClass::DD | ShipClass::CL | ShipClass::CLT) && count_ids(c, &[crate::equipment::ID_TSLO]) > 0 {
            rate -= 0.08;
        }
        let kinds = [
            (zuiun >= 2 && radar, SpecialAttack::NightZuiunZzr),
            (zuiun >= 2, SpecialAttack::NightZuiunZz),
            (zuiun >= 1 && radar, SpecialAttack::NightZuiunZr),
            (zuiun >= 1, SpecialAttack::NightZuiunZ),
        ];
        for (ok, k) in kinds {
            if ok && self.rng().chance(rate / 1.35) {
                return Some(Fsa::NightZuiun(k));
            }
        }
        None
    }

    /// kcsim `getSpecialAttackMod` for the attacker at friend index `i` of the special attack led
    /// by flagship `flag`.
    #[allow(unused_assignments)]
    pub(super) fn special_mods(&self, kind: Fsa, flag: usize, i: usize) -> Special {
        let c = self.core(0, i);
        let (lo, hi) = self.fleet_range(flag);
        let pos = i - lo;
        let is_flag = pos == 0;
        let ap = c.ap_shells > 0;
        let radar = c.surface_radars > 0;
        let mid_at = |p: usize| if lo + p < hi { self.core(0, lo + p).master_id } else { 0 };
        let eng = self.engagement;
        let ap_radar = |m: &mut f64, acc: &mut f64| {
            if ap {
                *m *= 1.35;
                *acc *= 1.15;
            }
            if radar {
                *m *= 1.15;
                *acc *= 1.15;
            }
        };
        let (mut m, mut acc) = (1.0, 1.0);
        match kind {
            Fsa::Nelson => {
                m = 2.0;
                acc = 1.05;
                if eng == Engagement::TDisadvantage {
                    m *= 1.25;
                }
                let sc = |p: usize| if lo + p < hi { self.core(0, lo + p).ship_class } else { 0 };
                if c.ship_class == 88 && (sc(2) == 88 || sc(4) == 88) {
                    m *= if is_flag { 1.15 } else { 1.2 };
                }
            }
            Fsa::Nagato | Fsa::Mutsu => {
                m = if is_flag { 1.4 } else { 1.2 };
                let partner: &[(u32, f64, f64)] = if kind == Fsa::Nagato {
                    &[(276, 1.15, 1.35), (573, 1.2, 1.4), (576, 1.1, 1.25)]
                } else {
                    &[(275, 1.15, 1.35), (541, 1.2, 1.4)]
                };
                if let Some(&(_, fl, other)) = partner.iter().find(|p| p.0 == mid_at(1)) {
                    m *= if is_flag { fl } else { other };
                }
                acc = 1.4;
                ap_radar(&mut m, &mut acc);
            }
            Fsa::Colorado => {
                // kcsim with MECHANICS.coloradoSpecialBuff2 / coloradoSpecialFix.
                let mut m2 = 1.0;
                if is_flag {
                    m = 1.5;
                } else {
                    m = 1.3;
                    let s2 = self.core(0, lo + 1);
                    if BIG7.contains(&s2.master_id) {
                        m2 *= 1.15;
                    }
                    if s2.ap_shells > 0 {
                        m2 *= 1.35;
                    }
                    if radar {
                        m2 *= 1.15;
                    }
                    if pos == 1 {
                        m *= m2;
                    }
                    if pos == 2 {
                        m2 = 1.0;
                        if BIG7.contains(&c.master_id) {
                            m *= 1.17;
                        }
                    }
                }
                if m2 == 1.0 {
                    if ap {
                        m *= 1.35;
                    }
                    if radar {
                        m *= 1.15;
                    }
                }
                // SG radar (late model)
                if count_ids(c, &[456]) > 0 {
                    m *= 1.15;
                }
                acc = 1.4;
                if ap {
                    acc *= 1.15;
                }
                if radar {
                    acc *= 1.15;
                }
            }
            Fsa::Kongou => {
                // [unverified] 2.76 / 2.86: kcsim estimate after the 2026-04 buff (was 2.6 / 2.7).
                m = if is_flag { 2.76 } else { 2.86 };
                match eng {
                    Engagement::TAdvantage => m *= 1.25,
                    Engagement::TDisadvantage => m *= 0.8,
                    _ => {}
                }
                m *= match count_ids(c, &[503, 530]) {
                    0 => 1.0,
                    1 => 1.11,
                    _ => 1.15,
                };
                m *= match count_ids(c, &[502, 529]) {
                    0 => 1.0,
                    1 => 1.05,
                    _ => 1.08,
                };
                acc = 1.4;
            }
            Fsa::Richelieu => {
                m = if is_flag && [392, 969].contains(&c.master_id) { 1.3 } else { 1.24 };
                acc = 1.4;
                ap_radar(&mut m, &mut acc);
            }
            Fsa::QueenElizabeth => {
                m = if is_flag && c.master_id == 733 { 1.2 } else { 1.24 };
                acc = 1.4;
                ap_radar(&mut m, &mut acc);
            }
            Fsa::Sub => {
                m = 1.2 + 0.04 * c.level.sqrt();
                return Special { pow: m, acc, sub: true };
            }
            Fsa::Yamato3 => {
                m = 1.5;
                let (m2, m3) = (mid_at(1), mid_at(2));
                let pair = |set: [u32; 2]| set.contains(&m2) && set.contains(&m3);
                let duplex = count_ids(c, &DUPLEX) > 0;
                let bonuses: [(bool, f64); 4] = match pos {
                    0 => [(m2 == 546, 1.1), (pair([541, 573]), 1.1), (pair([553, 554]), 1.1), (duplex, 1.1)],
                    1 => [(m2 == 546, 1.2), (pair([541, 573]), 1.1), (pair([553, 554]), 1.05), (duplex, 1.1)],
                    _ => [(true, 1.1), (false, 1.0), (false, 1.0), (false, 1.0)],
                };
                for (cond, x) in bonuses {
                    if cond {
                        m *= x;
                    }
                }
                if ap {
                    m *= 1.35;
                }
                if radar {
                    m *= 1.15;
                }
                acc = m;
            }
            Fsa::Yamato2 => {
                m = 1.4;
                if is_flag {
                    if mid_at(0) == 546 || mid_at(1) == 546 {
                        m *= 1.1;
                    }
                } else if pos == 1 {
                    m = 1.55;
                    if c.master_id == 916 {
                        m *= 1.25;
                    } else if [546, 911].contains(&c.master_id) {
                        m *= 1.2;
                    }
                }
                if count_ids(c, &DUPLEX) > 0 {
                    m *= 1.1;
                }
                if ap {
                    m *= 1.35;
                }
                if radar {
                    m *= 1.15;
                }
                acc = m;
            }
            Fsa::NightZuiun(s) => {
                (m, acc) = night_zuiun_mods(s).unwrap_or((1.0, 1.0));
            }
        }
        Special { pow: m, acc, sub: false }
    }
}
