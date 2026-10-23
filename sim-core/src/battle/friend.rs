//! Friend fleet (友軍艦隊): a night battle between the friend fleet and the enemy right before the
//! player's night battle. Ported from KC3Kai/kancolle-replay `js/kcsim.js` (`friendFleetPhase`,
//! `nightPhaseTargetFF`, `takeDamage` `protectionFF`), MIT © fourinone41; rules checked against
//! wikiwiki.jp 友軍艦隊 (turn order, enemy turn skipping, last-enemy protection, flagship re-roll).
//!
//! The friend fleet takes the friend side's place for the phase ([`Battle::with_fleet`]) and
//! attacks with the engine's night attack code (`night_turn`). Fleet special attacks (Nelson Touch
//! etc.) never fire for a friend fleet (wikiwiki 友軍艦隊 「特殊砲撃(Nelson Touch等)は該当艦が旗艦に
//! なっていても発動しない」): they are rolled in `night_phase`, which this phase does not use; code
//! rolling specials inside `night_turn` / `night_attack` must check `Battle::ff_phase`.

use super::calc::NightEnv;
use super::night::{can_night, SideNight};
use super::{validate_fleet, Battle, FleetCore};
use crate::model::*;
use crate::rng::Rng;
use crate::ship::ShipState;

/// Static data of the friend fleet; its ships start every battle fresh (`init`).
pub struct FriendCore {
    pub fleet: FleetCore,
    pub init: Vec<ShipState>,
    /// Own formation, used when the player's fleet is combined.
    formation: Formation,
    chance: f64,
}

impl FriendCore {
    pub fn new(input: &FriendFleetInput) -> Result<FriendCore, String> {
        validate_fleet("friendFleet", &input.fleet, false)?;
        if !input.fleet.escort_ships().is_empty() {
            return Err("friendFleet: must be a single fleet (no escort)".into());
        }
        let chance = input.chance.unwrap_or(1.0);
        if !(0.0..=1.0).contains(&chance) {
            return Err("friendFleet.chance must be in [0, 1]".into());
        }
        let (fleet, init) = FleetCore::build(&input.fleet, true);
        Ok(FriendCore { fleet, init, formation: input.fleet.formation.unwrap_or_default(), chance })
    }
}

pub(super) struct FriendRun<'a> {
    core: &'a FriendCore,
    fought: bool,
}

/// kcsim `takeDamage` with `protectionFF` (the enemy's last ship during the friend fleet phase):
/// 1 HP takes no damage, a lethal hit leaves ⌈HP/2⌉ (⌊HP × 0.5⌋ removed; the random term is
/// rolled and multiplied by 0).
pub(super) fn last_enemy_protect(rng: &mut Rng, dmg: i32, hp: i32) -> i32 {
    if hp <= 1 {
        return 0;
    }
    if dmg < hp {
        return dmg;
    }
    rng.f64();
    hp / 2
}

fn env(sides: &[SideNight; 2], side: usize) -> NightEnv {
    let (own, foe) = (&sides[side], &sides[1 - side]);
    NightEnv {
        own_starshell: own.starshell,
        enemy_starshell: foe.starshell,
        own_searchlight: own.searchlight > 0,
        enemy_searchlight: foe.searchlight > 0,
        contact_acc: own.contact,
    }
}

impl<'a> Battle<'a> {
    pub fn set_friend_fleet(&mut self, core: &'a FriendCore) {
        self.friend_fleet = Some(FriendRun { core, fought: false });
    }

    /// `Some(fought)` when a friend fleet was set.
    pub fn friend_fleet_fought(&self) -> Option<bool> {
        self.friend_fleet.as_ref().map(|r| r.fought)
    }

    /// kcsim `friendFleetPhase`: arrival roll, then the friend fleet's night battle. The player's
    /// single-fleet formation is inherited; night equipment (flares, searchlights, night scouts)
    /// is rolled for this phase only, without air-state gating.
    pub(super) fn friend_fleet_phase(&mut self) {
        let Some(run) = self.friend_fleet.as_ref() else { return };
        let fc = run.core;
        if !self.any_alive(1) || (fc.chance < 1.0 && !self.rng.chance(fc.chance)) {
            return;
        }
        self.friend_fleet.as_mut().expect("friend fleet").fought = true;
        let form = if self.fleets[0].combined.is_none() { self.setup.formations[0] } else { fc.formation };
        let mut st = fc.init.clone();
        let phase = std::mem::replace(&mut self.phase, Phase::FriendFleet);
        let air_combat = std::mem::replace(&mut self.air_combat, false);
        self.ff_phase = true;
        self.with_fleet(&fc.fleet, &mut st, form, |b| b.friend_night());
        self.ff_phase = false;
        self.air_combat = air_combat;
        self.phase = phase;
    }

    /// Friend ships attack in order; after each (but the last) the next enemy able to attack
    /// fires back (escort first, then main; enemies unable to attack are skipped). Before a friend
    /// ship attacks, a lone surviving enemy is protected from sinking.
    fn friend_night(&mut self) {
        let sides = [self.night_setup(0, true), self.night_setup(1, true)];
        let (envs, sl) = ([env(&sides, 0), env(&sides, 1)], [sides[0].searchlight, sides[1].searchlight]);
        let (n0, n1, es1) = (self.len(0), self.len(1), self.escort_start(1));
        let mut k = 0;
        for a in 0..n0 {
            if can_night(self.core(0, a), &self.st[0][a]) {
                let mut alive = (0..n1).filter(|&i| self.alive(1, i));
                if let (Some(last), None) = (alive.next(), alive.next()) {
                    self.st[1][last].protected = true;
                }
                self.night_turn(0, a, &envs[0], sl[1], true);
            }
            if a + 1 >= n0 || !self.any_alive(1) {
                break;
            }
            let order = |k: usize| (k + es1) % n1;
            while k < n1 && !can_night(self.core(1, order(k)), &self.st[1][order(k)]) {
                k += 1;
            }
            if k < n1 {
                self.night_turn(1, order(k), &envs[1], sl[0], true);
                k += 1;
            }
            if !self.any_alive(0) {
                break;
            }
        }
        for s in self.st[1].iter_mut() {
            s.protected = false;
        }
    }
}
