//! Enemy air raid on the land bases (基地空襲) and air defence (防空). Ported from
//! KC3Kai/kancolle-replay `js/kcsim.js` (`simLBRaid`) and `js/kcships.js`
//! (`LandBase.airPowerDefend`), MIT © fourinone41; constants per wikiwiki.jp/kancolle 基地航空隊
//! (防空時の制空値計算, 高高度迎撃の仕様まとめ, 基地への空襲による地上撃破).
//!
//! Defence fighter power: per defence base ⌊Σ ⌊(AA + ★ + intercept + 2 × anti-bomber) × √n +
//! proficiency⌋ × recon⌋ (intercept / anti-bomber = evasion / accuracy of interceptors and land
//! fighters), summed over the bases; against a high-altitude raid (heavy bombers 1594, 1595, 1597,
//! 1598 in the raid, or `highAltitude`) × 0.5 / 0.8 / 1.1 / 1.2 for 0 / 1 / 2 / 3+ rocket
//! interceptors (350, 351, 352) on the defence bases. Enemy fighter power counts every plane. Air
//! state by the usual ratios (no planes on either side: parity); defence squadrons lose planes by
//! the friend stage-1 formula. Each enemy plane slot meets the best interceptor (anti-bomber, then
//! intercept) of the next base squadron position (kcsim `lbSlot` walk) and loses
//! ⌈n × (6.5A + 3.5(B + A·min(1, I) + U[0, A + B)))/100⌉ (A = 10/8/6/4/1 by air state). No stage-2
//! AA. Enemy contact as usual; every bomber slot strikes a random base (HP 200 max, armor and
//! evasion 0) with the airstrike formula; a base never drops below 1 HP. A base losing 50+ HP in
//! one raid loses 1–4 planes from its first squadron down, each squadron keeping ≥ 1 (地上撃破;
//! uniform 1–4 is an assumption).

use super::air::{contact_roll, friend_fighter_loss};
use super::calc::{self, Unit};
use super::lbas::{compare_ap, initial_planes, LandBaseCore, LbPlanes, MAX_SQUADRONS, MAX_WAVES};
use super::{validate_fleet, FleetCore};
use crate::equipment::{cat, f};
use crate::formulas::{self, soft_cap, Roll, CAP_AIR};
use crate::model::{AirState, AirStateRates, BaseRaidInput, BaseRaidResult, BaseRaidSummary, Formation, ShipInput};
use crate::rng::Rng;
use crate::ship::{ShipCore, ShipState, MAX_SLOTS};

/// kcEQDATA `highAltitude` (深海空要塞 recon / heavy bomber models).
const HIGH_ALTITUDE_IDS: [u32; 4] = [1594, 1595, 1597, 1598];
/// kcEQDATA `isRocket` (Me163B, 試製 秋水, 秋水; wikiwiki: the three as of 2023/03).
const ROCKET_IDS: [u32; 3] = [350, 351, 352];
/// kcships `LandBase`: HP 200.
pub const BASE_HP: i32 = 200;

/// Friend-view air state (2 AS+ .. −2 AI) as an [`AirState`].
pub fn air_state_of(air: i8) -> AirState {
    match air {
        2 => AirState::Supremacy,
        1 => AirState::Superiority,
        0 => AirState::Parity,
        -1 => AirState::Denial,
        _ => AirState::Incapability,
    }
}

/// The raid has heavy (high-altitude) bombers.
pub fn has_heavy_bombers(fleet: &FleetCore) -> bool {
    fleet.ships.iter().any(|c| c.slots.iter().flatten().any(|e| HIGH_ALTITUDE_IDS.contains(&e.id)))
}

/// A land base as an airstrike target (kcships `LandBase`: HP 200, armor 0).
pub struct BaseTarget {
    core: ShipCore,
    st: ShipState,
}

impl Default for BaseTarget {
    fn default() -> Self {
        let input = ShipInput { ship_type: 2, max_hp: BASE_HP, ..Default::default() };
        let core = ShipCore::new(&input, true);
        let st = core.initial_state(&input);
        BaseTarget { core, st }
    }
}

/// The raiding fleet of one raid.
pub struct Raider<'r> {
    pub fleet: &'r FleetCore,
    pub init: &'r [ShipState],
    pub formation: Formation,
    pub high_altitude: bool,
}

/// Land bases under the raid: squadrons, whether each defends, current squadron sizes and HP.
pub struct RaidBases<'r> {
    pub bases: &'r [LandBaseCore],
    pub defense: &'r [bool],
    pub planes: &'r mut LbPlanes,
    pub hp: &'r mut [i32; MAX_WAVES],
}

/// `BattleInput.baseRaid`, prepared once.
pub struct BattleRaid {
    fleet: FleetCore,
    init: Vec<ShipState>,
    formation: Formation,
    high_altitude: bool,
    bases: Vec<LandBaseCore>,
    defense: Vec<bool>,
    hp: [i32; MAX_WAVES],
    target: BaseTarget,
}

impl BattleRaid {
    pub fn new(input: &BaseRaidInput) -> Result<BattleRaid, String> {
        validate_fleet("baseRaid enemy", &input.enemy, false)?;
        if input.bases.len() > MAX_WAVES {
            return Err(format!("baseRaid: {} bases (max {MAX_WAVES})", input.bases.len()));
        }
        let mut bases = Vec::with_capacity(input.bases.len());
        let mut hp = [BASE_HP; MAX_WAVES];
        for (i, b) in input.bases.iter().enumerate() {
            bases.push(LandBaseCore::new(&format!("baseRaid base #{i}"), &b.squadrons)?);
            hp[i] = b.hp.unwrap_or(BASE_HP).clamp(1, BASE_HP);
        }
        let (fleet, init) = FleetCore::build(&input.enemy, false);
        let high_altitude = input.high_altitude.unwrap_or(false) || has_heavy_bombers(&fleet);
        Ok(BattleRaid {
            fleet,
            init,
            formation: input.enemy.formation.unwrap_or_default(),
            high_altitude,
            defense: input.bases.iter().map(|b| b.defense).collect(),
            bases,
            hp,
            target: BaseTarget::default(),
        })
    }

    pub fn run(&self, rng: &mut Rng) -> BaseRaidResult {
        let mut planes = initial_planes(&self.bases);
        let mut hp = self.hp;
        let raider = Raider { fleet: &self.fleet, init: &self.init, formation: self.formation, high_altitude: self.high_altitude };
        let bases = RaidBases { bases: &self.bases, defense: &self.defense, planes: &mut planes, hp: &mut hp };
        let (air, lost) = base_raid(rng, &raider, bases, &self.target);
        BaseRaidResult { air_state: air_state_of(air), hp_lost: lost[..self.bases.len()].to_vec() }
    }

    pub fn bases(&self) -> usize {
        self.bases.len()
    }
}

/// kcsim `simLBRaid`. Returns the friend-view air state and the HP lost per base.
pub fn base_raid(rng: &mut Rng, raid: &Raider, bases: RaidBases, target: &BaseTarget) -> (i8, [i32; MAX_WAVES]) {
    let RaidBases { bases, defense, planes, hp } = bases;
    let n_bases = bases.len().min(MAX_WAVES);
    let defending = |b: &usize| defense.get(*b).copied().unwrap_or(false);
    let mut rst = raid.init.to_vec();
    let ships = &raid.fleet.ships;

    // kcships `LandBase.airPowerDefend`, high-altitude multiplier.
    let mut ap1 = 0.0;
    let mut rockets = 0;
    for b in (0..n_bases).filter(defending) {
        let base = &bases[b];
        let mut ap = 0.0;
        for (k, e) in base.squadrons.iter().enumerate() {
            if ROCKET_IDS.contains(&e.id) {
                rockets += 1;
            }
            if !e.has(f::PLANE) {
                continue;
            }
            let mut v = e.aa + e.aa_improve;
            if e.cat == cat::INTERCEPTOR {
                v += e.ev + e.acc * 2.0;
            }
            ap += (v * (planes[b][k].max(0) as f64).sqrt() + base.ap_bonus[k]).floor();
        }
        ap1 += (ap * base.recon_defense).floor();
    }
    if raid.high_altitude {
        ap1 = (ap1 * [0.5, 0.8, 1.1, 1.2][rockets.min(3)]).floor();
    }
    let mut ap2 = 0.0;
    for (i, c) in ships.iter().enumerate() {
        if rst[i].hp > 0 {
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                let n = rst[i].planes[s];
                if n > 0 && e.has(f::PLANE) {
                    ap2 += ((e.aa + e.aa_improve) * (n as f64).sqrt() + e.ap_bonus).floor();
                }
            }
        }
    }
    let air = if ap1 == 0.0 && ap2 == 0.0 { 0 } else { compare_ap(ap1, ap2.floor()) };

    // Stage 1: defence squadrons.
    for b in (0..n_bases).filter(defending) {
        for (k, e) in bases[b].squadrons.iter().enumerate() {
            let n = planes[b][k];
            if e.has(f::PLANE) && n > 0 {
                let lost = friend_fighter_loss(rng, n, air, if e.has(f::JET) { 0.6 } else { 1.0 });
                planes[b][k] = (n - lost).max(0);
            }
        }
    }
    // Interception (kcsim `lbSlot` walk).
    let a_mod = [1.0, 4.0, 6.0, 8.0, 10.0][(air + 2) as usize];
    for (i, c) in ships.iter().enumerate() {
        let mut lb_slot = 0;
        for s in 0..MAX_SLOTS {
            if !c.slots[s].as_ref().is_some_and(|e| e.has(f::PLANE)) {
                continue;
            }
            let mut best: Option<(f64, f64)> = None;
            while lb_slot < MAX_SQUADRONS {
                for b in (0..n_bases).filter(defending) {
                    let Some(e) = bases[b].squadrons.get(lb_slot) else { continue };
                    let (ca, ce) = best.unwrap_or((0.0, 0.0));
                    if planes[b][lb_slot] > 0 && e.cat == cat::INTERCEPTOR && (e.acc > ca || (e.acc == ca && e.ev > ce)) {
                        best = Some((e.acc, e.ev));
                    }
                }
                if best.is_some() {
                    break;
                }
                lb_slot += 1;
            }
            lb_slot += 1;
            let (anti, inter) = best.unwrap_or((0.0, 0.0));
            let ratio = 6.5 * a_mod + 3.5 * (anti + a_mod * inter.min(1.0) + rng.f64() * (a_mod + anti));
            let n = rst[i].planes[s];
            rst[i].planes[s] = (n - (n as f64 * ratio / 100.0).ceil() as i32).max(0);
        }
    }
    // Enemy contact.
    let eair = -air;
    let mut contact = 1.0;
    if eair != -2 && eair != 0 {
        let items = ships.iter().zip(&rst).filter(|(_, st)| st.hp > 0).flat_map(|(c, st)| {
            (0..MAX_SLOTS).filter_map(move |s| c.slots[s].as_ref().map(|e| (e, st.planes[s])))
        });
        if let Some(m) = contact_roll(rng, eair, items) {
            contact = m;
        }
    }
    // Strikes.
    let mut lost = [0; MAX_WAVES];
    if n_bases > 0 {
        for (i, c) in ships.iter().enumerate() {
            if rst[i].hp <= 0 {
                continue;
            }
            for s in 0..MAX_SLOTS {
                let Some(e) = c.slots[s].as_ref() else { continue };
                let n = rst[i].planes[s];
                if n <= 0 || !(e.has(f::DIVE) || e.has(f::TORP_BOMBER)) {
                    continue;
                }
                let b = rng.below(n_bases);
                let mut tst = target.st.clone();
                tst.hp = hp[b];
                let att = Unit::plain(c, &rst[i], raid.formation, i, ships.len());
                let def = Unit::plain(&target.core, &tst, Formation::LineAhead, 0, 1);
                let acc = calc::air_acc(&att, &def);
                let roll = formulas::roll_hit(rng, &acc.hc, acc.crit_dmg);
                if roll == Roll::Miss {
                    continue;
                }
                // kcsim `airstrike`: land bombers use torpedo against a non-installation.
                let land_bomber = e.cat == cat::LAND_BOMBER || e.cat == cat::LAND_BOMBER_L;
                let (base, dive) = calc::air_plane_base(c, s, &target.core);
                let base = if land_bomber { e.tp + e.air_power_improve } else { base };
                let mult = if dive {
                    1.0
                } else if rng.chance(0.5) {
                    0.8
                } else {
                    1.5
                };
                let pow = soft_cap((calc::AIR_BASE + (n as f64).sqrt() * base) * mult, CAP_AIR).floor() * contact;
                let dmg = formulas::damage_common(rng, pow, roll, 0.0, 1.0, hp[b]);
                let after = (hp[b] - dmg).max(1);
                lost[b] += hp[b] - after;
                hp[b] = after;
            }
        }
    }
    // 地上撃破.
    for b in 0..n_bases {
        if lost[b] < 50 {
            continue;
        }
        let mut k = 1 + rng.below(4) as i32;
        for s in 0..bases[b].squadrons.len() {
            let take = k.min(planes[b][s] - 1).max(0);
            planes[b][s] -= take;
            k -= take;
        }
    }
    (air, lost)
}

/// Raid aggregation for summaries.
#[derive(Default)]
pub struct RaidAcc {
    pub raids: u32,
    airs: [u32; 6],
    hp_lost: Vec<f64>,
}

impl RaidAcc {
    pub fn add(&mut self, air: AirState, hp_lost: &[i32]) {
        self.raids += 1;
        self.airs[air as usize] += 1;
        if self.hp_lost.len() < hp_lost.len() {
            self.hp_lost.resize(hp_lost.len(), 0.0);
        }
        for (a, &l) in self.hp_lost.iter_mut().zip(hp_lost) {
            *a += l as f64;
        }
    }

    pub fn summary(&self, rate: Option<f64>, n_bases: usize) -> BaseRaidSummary {
        let r = |x: f64| if self.raids > 0 { x / self.raids as f64 } else { 0.0 };
        let a = |k: usize| r(self.airs[k] as f64);
        BaseRaidSummary {
            rate,
            air_state_rates: AirStateRates { none: a(0), supremacy: a(1), superiority: a(2), parity: a(3), denial: a(4), incapability: a(5) },
            hp_lost_mean: (0..n_bases).map(|b| r(self.hp_lost.get(b).copied().unwrap_or(0.0))).collect(),
        }
    }
}
