//! Battles against an enemy combined fleet: the day phase order of kcsimcombined `sim6vs12`
//! (single friend fleet) and `sim12vs12` (friend carrier / surface / transport combined fleet),
//! kcsim `COMBINEDCONSTS[type].ecombined`, the enemy night fleet (`isNBFightEscort`) and the
//! night-to-day battle (kcsim `simNightFirstCombined`). KC3Kai/kancolle-replay `js/kcsimcombined.js`
//! / `js/kcsim.js`, MIT © fourinone41. Phase order checked against the en wiki Combined Fleet page
//! ("Oposing Fleets" tables) and wikiwiki 連合艦隊.

use super::Battle;
use crate::model::{CombinedType, Detection, Phase};

/// Ships of one side: all, its main fleet or its escort.
#[derive(Clone, Copy)]
enum Part {
    All,
    Main,
    Escort,
}

/// kcsim `COMBINEDCONSTS[type].ecombined` shelling (power bonus added to the +5, accuracy base) of
/// a ship of `side` in its main fleet or escort; `friend` is the friend combined type (`None`: a
/// single friend fleet, kcsim type 0).
pub(super) fn ecombined_shell(friend: Option<CombinedType>, side: usize, escort: bool) -> (f64, f64) {
    // [main F, main E, escort F, escort E] as (power, accuracy).
    let t: [(f64, f64); 4] = match friend {
        None => [(5.0, 80.0), (10.0, 88.0), (5.0, 80.0), (-5.0, 75.0)],
        Some(CombinedType::Carrier | CombinedType::Surface) => [(2.0, 78.0), (10.0, 88.0), (-5.0, 67.0), (-5.0, 75.0)],
        Some(CombinedType::Transport) => [(-5.0, 54.0), (10.0, 88.0), (-5.0, 67.0), (-5.0, 75.0)],
    };
    t[2 * escort as usize + side.min(1)]
}

impl<'a> Battle<'a> {
    fn part(&self, side: usize, p: Part) -> (usize, usize) {
        let (es, n) = (self.fleets[side].escort_start, self.len(side));
        match p {
            Part::All => (0, n),
            Part::Main => (0, es),
            Part::Escort => (es, n),
        }
    }

    fn set_scope(&mut self, att: [Part; 2], tgt: [Part; 2]) {
        self.att = Some([self.part(0, att[0]), self.part(1, att[1])]);
        self.engaged = [self.part(0, tgt[0]), self.part(1, tgt[1])];
    }

    fn reset_scope(&mut self) {
        self.att = None;
        self.engaged = [(0, self.len(0)), (0, self.len(1))];
    }

    /// One shelling round: `att` fleets attack (in range order, else in fleet order) the `tgt`
    /// fleets; `pools`: each shot picks the main fleet or escort of a combined target side first.
    fn ec_shell(&mut self, phase: Phase, att: [Part; 2], tgt: [Part; 2], by_range: bool, pools: bool) {
        self.set_scope(att, tgt);
        if self.both_alive() {
            self.phase = phase;
            self.pools = pools;
            self.shelling(!by_range);
            self.pools = false;
        }
        self.reset_scope();
    }

    /// Opening ASW by the `att` fleets against every submarine.
    fn ec_oasw(&mut self, att: [Part; 2]) {
        self.set_scope(att, [Part::All, Part::All]);
        if self.both_alive() {
            self.phase = Phase::OpeningAsw;
            self.opening_asw();
        }
        self.reset_scope();
    }

    /// Torpedo salvo of both sides against both fleets (kcsim `torpedoPhase(…, combinedAll)`).
    fn ec_torpedo(&mut self, opening: bool) {
        if self.both_alive() {
            self.phase = if opening { Phase::OpeningTorpedo } else { Phase::ClosingTorpedo };
            self.torpedo_phase(opening);
        }
    }

    /// Day phases after the air phase against an enemy combined fleet.
    /// `sim6vs12`: OASW (friend, enemy escort), opening torpedo, shelling 1 vs the enemy escort
    /// (range order), closing torpedo, shelling 2 vs the enemy main fleet (range order), shelling 3
    /// friend vs enemy main fleet in fleet order against both enemy fleets.
    /// `sim12vs12`: OASW (escorts), opening torpedo, main vs main (range order); carrier / transport:
    /// escort vs escort, closing torpedo, mains in fleet order against both fleets; surface: mains in
    /// fleet order against both fleets, escort vs escort, closing torpedo.
    pub(super) fn ecombined_day(&mut self) {
        use Part::*;
        use Phase::*;
        let second = self.second_shelling;
        match self.combined {
            None => {
                self.ec_oasw([All, Escort]);
                self.ec_torpedo(true);
                self.update_fleet_los();
                self.ec_shell(Shelling1, [All, Escort], [All, Escort], true, false);
                self.ec_torpedo(false);
                self.ec_shell(Shelling2, [All, Main], [All, Main], true, false);
                if second {
                    self.ec_shell(Shelling3, [All, Main], [All, All], false, true);
                }
            }
            Some(ct) => {
                self.ec_oasw([Escort, Escort]);
                self.ec_torpedo(true);
                self.update_fleet_los();
                self.ec_shell(Shelling1, [Main, Main], [Main, Main], true, false);
                if ct == CombinedType::Surface {
                    if second {
                        self.ec_shell(Shelling2, [Main, Main], [All, All], false, true);
                    }
                    self.ec_shell(Shelling3, [Escort, Escort], [Escort, Escort], true, false);
                    self.ec_torpedo(false);
                } else {
                    self.ec_shell(Shelling2, [Escort, Escort], [Escort, Escort], true, false);
                    self.ec_torpedo(false);
                    if second {
                        self.ec_shell(Shelling3, [Main, Main], [All, All], false, true);
                    }
                }
            }
        }
    }

    /// The night battle is fought against the enemy escort when the enemy main fleet is sunk or
    /// the escort scores ≥ 3: each escort ship above 50% HP 1, above 25% 0.7, the escort flagship
    /// afloat +1 (wikiwiki 連合艦隊 / fandom Abyssal Combined Fleet; kcsim `isNBFightEscort` uses
    /// 1 / 0.5 / 0.25 for >50% / >25% / afloat).
    pub(super) fn night_fights_escort(&self) -> bool {
        let (es, n) = (self.fleets[1].escort_start, self.len(1));
        if (0..es).all(|i| !self.alive(1, i)) {
            return true;
        }
        let mut score = if self.alive(1, es) { 1.0 } else { 0.0 };
        for i in es..n {
            let r = self.st[1][i].hp_ratio(self.core(1, i).max_hp);
            score += if r > 0.5 {
                1.0
            } else if r > 0.25 {
                0.7
            } else {
                0.0
            };
        }
        score >= 3.0
    }

    /// Night-to-day battle against an enemy combined fleet (kcsim `simNightFirstCombined`): the
    /// night rounds, then the day battle against the enemy main fleet alone while it is afloat and
    /// at most 3 escort ships are above 50% HP (the escort withdraws; wikiwiki 連合艦隊 払暁戦).
    /// Returns the day battle's detection.
    pub(super) fn night_to_day_combined(&mut self) -> Option<Detection> {
        if self.both_alive() {
            // kcsim: shelling / torpedo support before the night rounds; the friend fleet as at other
            // night battles [unverified for 払暁戦].
            self.support_phase(false, true);
            self.friend_fleet_phase();
            if self.both_alive() {
                self.night_first_combined();
            }
        }
        let (es, n) = (self.fleets[1].escort_start, self.len(1));
        let main_afloat = (0..es).any(|i| self.alive(1, i));
        let strong = (es..n).filter(|&i| self.st[1][i].hp_ratio(self.core(1, i).max_hp) > 0.5).count();
        if !main_afloat || strong > 3 || !self.any_alive(0) {
            return None;
        }
        // kcsim `sim(F1, F2)`: a single-fleet day battle against the main fleet (its ships keep
        // the combined-fleet AA / airstrike terms and fire no torpedoes).
        self.ecombined = false;
        self.engaged[1] = (0, es);
        let bb = |side: usize, hi: usize| (0..hi).any(|i| self.alive(side, i) && self.core(side, i).class.is_bb_class());
        self.second_shelling = bb(0, self.len(0)) || bb(1, es);
        let detection = self.day_battle();
        self.engaged[1] = (0, n);
        Some(detection)
    }
}
