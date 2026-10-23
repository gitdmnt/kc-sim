//! Jet assault (噴式強襲): land-base jets, then the fleets' carrier jets, before the land-base waves
//! (wikiwiki 戦闘について 「戦闘の流れ」: 基地噴式強襲 → 空母噴式強襲 → 基地航空戦 → 航空戦; also
//! when detection fails). Ported from KC3Kai/kancolle-replay `js/kcsim.js` (`sim` "jet lbas" /
//! "jet airstrike" blocks, `compareAP(…, 'isjet')`, `airPhase(…, isjetphase)`,
//! `AADefenceBombersAndAirstrike(…, isjetphase)`, `airstrike(…, isjetphase)`) and `js/kcships.js`
//! (`LandBase.createJetLandBase`), MIT © fourinone41.
//!
//! Both phases: fighter power and stage 1 of jets only (losses ×0.6), stage 2 without AACI, no
//! contact, jet bombers strike with the fleet airstrike formula without the ×0.7 + 0.5 jet
//! penalty. Land-base jets: every jet squadron of the bases sent to this node fights once as a
//! level-1 luck-3 one-plane carrier (concentrated bases count once, wikiwiki 戦闘について); the
//! enemy only defends (no enemy jet losses / strikes); the losses stay with the base for its waves
//! (wikiwiki 基地航空隊 よくある質問: 「基地噴式強襲と1回目の攻撃の間でも機体は補充されない」; kcsim
//! does not carry them). Fleet jets: both sides' jet carriers (friend: main fleet), the enemy's
//! jets strike back. Not modelled: steel cost, the 6-4 jet distance rule, AA resistance.

use super::calc::{self, Unit};
use super::lbas::{compare_ap, MAX_WAVES};
use super::{Battle, List};
use crate::equipment::f;
use crate::formulas::{self, soft_cap, Roll, CAP_AIR};
use crate::model::{AttackEvent, AttackKind, Formation, HitResult, Phase, Side, SpecialAttack};
use crate::ship::{ShipCore, ShipState, MAX_SLOTS};

/// Fighter power of `planes` slots of `core` matching `filter` (kcsim `Ship.airPower`).
fn slot_ap(core: &ShipCore, planes: &[i32; MAX_SLOTS], filter: u64) -> (f64, bool) {
    let (mut ap, mut has) = (0.0, false);
    for (s, e) in core.slots.iter().enumerate() {
        let Some(e) = e else { continue };
        if s < MAX_SLOTS && planes[s] > 0 && e.has(filter) {
            has = true;
            ap += ((e.aa + e.aa_improve) * (planes[s] as f64).sqrt() + e.ap_bonus).floor();
        }
    }
    (ap, has)
}

/// kcsim `airstrike(…, isjetphase)` power after the cap and the target bonus
/// ([`calc::air_target_mod`]); no jet penalty, no contact, no event bonus.
fn jet_power(rng: &mut crate::rng::Rng, att: &ShipCore, slot: usize, planes: i32, def: &ShipCore, air_pow: f64) -> f64 {
    let (base, dive) = calc::air_plane_base(att, slot, def);
    let mult = if dive {
        1.0
    } else if rng.chance(0.5) {
        0.8
    } else {
        1.5
    };
    let mut pow = soft_cap((calc::AIR_BASE + air_pow + (planes.max(0) as f64).sqrt() * base) * mult, CAP_AIR).floor();
    let (p, hi, lo) = calc::air_target_mod(att, slot, def);
    if hi != 1.0 || lo != 1.0 {
        pow *= if p >= 1.0 || rng.chance(p) { hi } else { lo };
    }
    pow
}

impl<'a> Battle<'a> {
    /// Phases before the fleet air phase, in game order: land-base jet assault, fleet jet assault
    /// (`fleet_jets`: not at air-raid nodes, kcsim `!bombing`), land-base waves.
    pub(super) fn land_base_phases(&mut self, fleet_jets: bool) {
        self.jet_lbas_phase();
        if fleet_jets && self.both_alive() {
            self.jet_air_phase();
        }
        self.lbas_phase();
    }

    /// Air-raid node whose enemy was sunk before the air phase (land bases): air supremacy when the
    /// friend fleet has planes to fly (wikiwiki 基地航空隊 「空襲戦マスで基地航空隊で敵艦を全滅させて
    /// も…自動的に制空権確保」; whether planes are lost is unknown: none are).
    pub(super) fn raid_cleared(&mut self) {
        if self.any_alive(0) && self.has_fighter_slots(0) {
            self.air_combat = true;
            self.air = 2;
        }
    }

    /// Enemy jet fighter power (afloat ships of the air fleet) and whether any jet slot has planes.
    fn enemy_jet_ap(&self) -> (f64, bool) {
        let (mut ap, mut has) = (0.0, false);
        for i in 0..self.air_fleet_end(1) {
            if self.alive(1, i) {
                let (a, h) = slot_ap(self.core(1, i), &self.st[1][i].planes, f::JET);
                ap += a;
                has |= h;
            }
        }
        (ap.floor(), has)
    }

    /// kcsim `getAAShotProp` / `getAAShotFlat` by a random defender of `def_side` on `n` planes,
    /// without AACI (jet phases). Returns the planes left.
    fn jet_shootdown(&mut self, def_side: usize, defenders: &List, n: i32) -> i32 {
        if defenders.is_empty() {
            return n;
        }
        let d = defenders.as_slice()[self.rng().below(defenders.len())];
        let player = self.fleets[def_side].is_player;
        let cfm = self.combined_aa_mod(def_side, d);
        let waa = self.core(def_side, d).weighted_aa * cfm;
        let fleet_aa = if player { (self.fleet_aa[def_side] / 1.3).floor() } else { self.fleet_aa[def_side] };
        let flat_mod = if player { 0.2 } else { 0.1875 };
        let prop = if self.rng().chance(0.5) { (n as f64 * waa / 200.0).floor() as i32 } else { 0 };
        let flat = if self.rng().chance(0.5) { ((waa + fleet_aa * cfm) * flat_mod).floor() as i32 } else { 0 };
        let fix = if player { 1 } else { 0 };
        (n - prop - flat - fix).max(0)
    }

    fn afloat(&self, side: usize) -> List {
        let mut l = List::default();
        for i in 0..self.len(side) {
            if self.alive(side, i) {
                l.push(i);
            }
        }
        l
    }

    /// kcsim "jet lbas": `createJetLandBase` + `compareAP(jetLBAS, F2, 'isjet')` + `airPhase(…, 2)`.
    /// Event `attacker`: the first wave of the base.
    pub(super) fn jet_lbas_phase(&mut self) {
        let Some(run) = self.lbas.as_ref() else { return };
        let (bases, mut planes) = (run.bases, run.planes);
        let mut first = [None; MAX_WAVES];
        for (w, &b) in run.waves.iter().enumerate() {
            first[b] = first[b].or(Some(w));
        }
        if !(0..bases.len()).any(|b| first[b].is_some() && bases[b].has_jets()) || !self.any_alive(0) || self.surface(1).is_empty() {
            return;
        }
        // (base, squadron, carrier, state)
        let mut units: Vec<(usize, usize, &'a ShipCore, ShipState)> = Vec::new();
        for (b, base) in bases.iter().enumerate().filter(|(b, _)| first[*b].is_some()) {
            for (s, core, st) in &base.jets {
                let mut st = st.clone();
                st.planes[0] = planes[b][*s];
                units.push((b, *s, core, st));
            }
        }
        let phase = self.phase;
        self.phase = Phase::JetLandBase;
        let (mut ap1, mut has1) = (0.0, false);
        for (_, _, c, st) in &units {
            let (a, h) = slot_ap(c, &st.planes, f::JET);
            ap1 += a;
            has1 |= h;
        }
        let (ap2, has2) = self.enemy_jet_ap();
        let air = if has1 || has2 { compare_ap(ap1.floor(), ap2) } else { 0 };
        for (_, _, _, st) in units.iter_mut() {
            if st.planes[0] > 0 {
                let lost = super::air::friend_fighter_loss(self.rng(), st.planes[0], air, 0.6);
                st.planes[0] = (st.planes[0] - lost).max(0);
            }
        }
        let defenders = self.afloat(1);
        let targets = self.surface(1);
        let mut attacks: Vec<(usize, usize, bool)> = Vec::new();
        for k in 0..units.len() {
            let (_, _, c, st) = &units[k];
            if !c.slots[0].as_ref().is_some_and(|e| e.has(f::BOMBER)) || st.planes[0] <= 0 {
                continue;
            }
            let left = self.jet_shootdown(1, &defenders, units[k].3.planes[0]);
            units[k].3.planes[0] = left;
            if left > 0 && !targets.is_empty() {
                let (t, covered) = self.choose_target(1, targets.as_slice(), 0);
                attacks.push((k, t, covered));
            }
        }
        for (k, d, covered) in attacks {
            let (b, s, c, st) = &units[k];
            let att = Unit::plain(c, st, Formation::LineAhead, 0, 1);
            let acc = calc::air_acc(&att, &self.unit(1, d));
            let roll = formulas::roll_hit(self.rng(), &acc.hc, acc.crit_dmg);
            let hp_before = self.st[1][d].hp;
            let mut real = 0;
            if roll != Roll::Miss {
                let air_pow = self.unit(1, d).cf.air_pow;
                let pow = jet_power(self.rng, c, 0, st.planes[0], self.core(1, d), air_pow);
                let dmg = formulas::damage_common(self.rng, pow, roll, self.core(1, d).ar, 1.0, hp_before);
                real = self.take_damage(1, d, dmg);
            }
            if let Some(ev) = self.events.as_mut() {
                ev.push(AttackEvent {
                    phase: Phase::JetLandBase,
                    kind: AttackKind::Air,
                    special: SpecialAttack::Normal,
                    attacker_side: Side::Friend,
                    attacker: first[*b].unwrap_or(*b),
                    defender: d,
                    covered,
                    slot: Some(*s),
                    hit: match roll {
                        Roll::Miss => HitResult::Miss,
                        Roll::Hit => HitResult::Hit,
                        Roll::Crit(_) => HitResult::Critical,
                    },
                    damage: real,
                    defender_hp_before: hp_before,
                    defender_hp_after: self.st[1][d].hp,
                    p_hit: acc.hc.p_hit(),
                    p_crit: acc.hc.p_crit(),
                });
            }
        }
        for (b, s, _, st) in &units {
            planes[*b][*s] = st.planes[0];
        }
        if let Some(run) = self.lbas.as_mut() {
            run.planes = planes;
        }
        self.phase = phase;
    }

    /// Ships of the air fleet of `side` afloat with a jet equipped (kcsim `hasjet`).
    fn jet_carriers(&self, side: usize) -> List {
        let mut l = List::default();
        for i in 0..self.air_fleet_end(side) {
            if self.alive(side, i) && self.core(side, i).slots.iter().flatten().any(|e| e.has(f::JET)) {
                l.push(i);
            }
        }
        l
    }

    /// kcsim "jet airstrike": `compareAP(F1, F2, 'isjet')` + `airPhase(…, 1)`.
    pub(super) fn jet_air_phase(&mut self) {
        let carriers = [self.jet_carriers(0), self.jet_carriers(1)];
        let fights = |side: usize| !carriers[side].is_empty() && !self.surface(1 - side).is_empty();
        if !(fights(0) || fights(1)) {
            return;
        }
        let phase = self.phase;
        self.phase = Phase::JetAirStrike;
        let (mut ap, mut has) = ([0.0; 2], false);
        for side in 0..2 {
            for &i in carriers[side].as_slice() {
                let (a, h) = slot_ap(self.core(side, i), &self.st[side][i].planes, f::JET);
                ap[side] += a;
                has |= h;
            }
        }
        let air = if has { compare_ap(ap[0].floor(), ap[1].floor()) } else { 0 };
        self.fighter_losses(0, carriers[0], f::JET, air);
        self.fighter_losses(1, carriers[1], f::JET, -air);
        self.jet_strikes(0, carriers[0]);
        self.jet_strikes(1, carriers[1]);
        self.phase = phase;
    }

    /// kcsim `AADefenceBombersAndAirstrike(…, isjetphase)` for `att_side`'s jet bombers.
    fn jet_strikes(&mut self, att_side: usize, carriers: List) {
        let def_side = 1 - att_side;
        let defenders = self.afloat(def_side);
        let targets = self.surface(def_side);
        let mut attacks: Vec<(usize, usize, usize, bool)> = Vec::new();
        for &i in carriers.as_slice() {
            for s in 0..MAX_SLOTS {
                let jet_bomber = self.core(att_side, i).slots[s].as_ref().is_some_and(|e| e.has(f::BOMBER) && e.has(f::JET));
                let n = self.st[att_side][i].planes[s];
                if !jet_bomber || n <= 0 {
                    continue;
                }
                let left = self.jet_shootdown(def_side, &defenders, n);
                let st = &mut self.st[att_side][i];
                st.planes[s] = left;
                if left <= 0 {
                    st.exp[s] = 0.0;
                    continue;
                }
                if !targets.is_empty() {
                    let (t, covered) = self.choose_target(def_side, targets.as_slice(), 0);
                    attacks.push((i, s, t, covered));
                }
            }
        }
        for (a, s, d, covered) in attacks {
            let acc = calc::air_acc(&self.unit(att_side, a), &self.unit(def_side, d));
            let roll = formulas::roll_hit(self.rng(), &acc.hc, acc.crit_dmg);
            let hp_before = self.st[def_side][d].hp;
            let mut real = 0;
            if roll != Roll::Miss {
                let att = self.core(att_side, a);
                let air_pow = self.unit(def_side, d).cf.air_pow;
                let pow = jet_power(self.rng, att, s, self.st[att_side][a].planes[s], self.core(def_side, d), air_pow);
                // kcsim `airstrike` postMod: the carrier's event bonus applies in the jet phase too.
                let pow = self.unit(att_side, a).bonus_dmg(pow, || true);
                let ammo = self.unit(att_side, a).ammo_mod();
                let dmg = formulas::damage_common(self.rng, pow, roll, self.core(def_side, d).ar, ammo, hp_before);
                real = self.take_damage(def_side, d, dmg);
            }
            self.record(AttackKind::Air, SpecialAttack::Normal, att_side, a, d, covered, Some(s), roll, real, hp_before, &acc.hc);
        }
    }
}
