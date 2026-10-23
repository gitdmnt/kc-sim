//! Friend fleet (友軍艦隊): a night battle between the friend fleet and the enemy right before the
//! player's night battle. Ported from KC3Kai/kancolle-replay `js/kcsim.js` (`friendFleetPhase`,
//! `nightPhaseTargetFF`, `takeDamage` `protectionFF`), MIT © fourinone41; rules checked against
//! wikiwiki.jp 友軍艦隊 (turn order, enemy turn skipping, last-enemy protection, flagship re-roll).
//!
//! The friend fleet takes the friend side's place for the phase ([`Battle::with_fleet`]) and
//! attacks with the engine's night attack code (`night_turn`), with its own event bonuses
//! (`friendFleetBonuses`; kancolle-replay `applyAutoBonusShip(ship, isFF)` folds the event data at
//! the battle's node for friend fleets too). Its ships have the player's sinking protection
//! (kcsim `Ship.reset`: `protection = isflagship || HP/maxHP > .25` for playable ships): KCNav
//! packets of event 62 show enemy hits on friend ships replaced by ⌊HP × 0.5 + 0.3 × rand(HP)⌋ and
//! no friend ship sunk. Fleet special attacks (Nelson Touch etc.) never fire for a friend fleet
//! (wikiwiki 友軍艦隊 「特殊砲撃(Nelson Touch等)は該当艦が旗艦になっていても発動しない」): they are
//! rolled in `night_phase`, which this phase does not use; code rolling specials inside
//! `night_turn` / `night_attack` must check `Battle::ff_phase`.

use super::calc::NightEnv;
use super::night::{can_night, SideNight};
use super::{validate_fleet, Battle, FleetCore};
use crate::bonus::{self, Bonus};
use crate::model::*;
use crate::rng::Rng;
use crate::ship::ShipState;

/// Event bonuses of the friend fleet's ships (`friendFleetBonuses`, in ship order); empty when no
/// ship has one.
pub fn bonuses(input: Option<&FriendFleetInput>, sets: Option<&[Option<ShipBonusSet>]>, at: &str) -> Result<Vec<Option<Bonus>>, String> {
    let mut out = bonus::build_ships(&format!("{at}friendFleetBonuses"), sets, input.map_or(0, |f| f.fleet.ships.len()))?;
    if out.iter().all(Option::is_none) {
        out.clear();
    }
    Ok(out)
}

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
        let (fleet, mut init) = FleetCore::build(&input.fleet, true);
        for (i, (s, c)) in init.iter_mut().zip(&fleet.ships).enumerate() {
            s.protected = i == 0 || s.hp_ratio(c.max_hp) > 0.25;
        }
        Ok(FriendCore { fleet, init, formation: input.fleet.formation.unwrap_or_default(), chance })
    }
}

pub(super) struct FriendRun<'a> {
    core: &'a FriendCore,
    /// Event bonuses at this battle's node (empty = none).
    bonus: &'a [Option<Bonus>],
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
    pub fn set_friend_fleet(&mut self, core: &'a FriendCore, bonus: &'a [Option<Bonus>]) {
        self.friend_fleet = Some(FriendRun { core, bonus, fought: false });
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
        let (fc, bonus) = (run.core, run.bonus);
        if !self.any_alive(1) || (fc.chance < 1.0 && !self.rng.chance(fc.chance)) {
            return;
        }
        self.friend_fleet.as_mut().expect("friend fleet").fought = true;
        let form = if self.fleets[0].combined.is_none() { self.setup.formations[0] } else { fc.formation };
        let mut st = fc.init.clone();
        let phase = std::mem::replace(&mut self.phase, Phase::FriendFleet);
        let air_combat = std::mem::replace(&mut self.air_combat, false);
        self.ff_phase = true;
        self.with_fleet(&fc.fleet, &mut st, form, bonus, |b| b.friend_night());
        self.ff_phase = false;
        self.air_combat = air_combat;
        self.phase = phase;
    }

    /// Friend ships attack in order; after each (but the last) the next enemy able to attack
    /// fires back (escort first, then main; enemies unable to attack are skipped). Before a friend
    /// ship attacks, a lone surviving enemy is protected from sinking. A friend ship may make a
    /// night Zuiun cut-in (kcsim `canSpecialAttack(attacker, true, nightEquips, true)`: no fleet
    /// special attack), which lights the enemy for the rest of the phase.
    fn friend_night(&mut self) {
        let mut sides = [self.night_setup(0, true), self.night_setup(1, true)];
        let (n0, n1, es1) = (self.len(0), self.len(1), self.escort_start(1));
        let mut k = 0;
        for a in 0..n0 {
            if can_night(self.core(0, a), &self.st[0][a]) {
                let mut alive = (0..n1).filter(|&i| self.alive(1, i));
                if let (Some(last), None) = (alive.next(), alive.next()) {
                    self.st[1][last].protected = true;
                }
                let zuiun = if self.surface(1).is_empty() { None } else { self.night_zuiun_roll(a, &sides) };
                match zuiun {
                    Some((kind, attackers)) => self.special_night_attack(kind, 0, attackers, &mut sides),
                    None => self.night_turn(0, a, &env(&sides, 0), sides[1].searchlight, true),
                }
            }
            if a + 1 >= n0 || !self.any_alive(1) {
                break;
            }
            let order = |k: usize| (k + es1) % n1;
            while k < n1 && !can_night(self.core(1, order(k)), &self.st[1][order(k)]) {
                k += 1;
            }
            if k < n1 {
                self.night_turn(1, order(k), &env(&sides, 1), sides[0].searchlight, true);
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
