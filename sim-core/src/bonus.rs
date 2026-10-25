//! Event historical bonuses and enemy armor debuffs. The caller folds the event data per ship and
//! node (`shared/sim/bonuses.ts`, after kancolle-replay `simulator-ui/bonus.js`); the engine applies
//! the result where kcsim applies `getBonusDmg` / `getBonusAcc` / `bonusSpecialEv` and the plane
//! groups of `getBonusSpecialPlane` (KC3Kai/kancolle-replay `js/kcsim.js`, MIT © fourinone41).

use std::borrow::Cow;

use crate::model::{ArmorDebuff, BaseBonusSet, DamageMods, FleetInput, PlaneBonusGroup, ShipBonusSet, ShipInput};
use crate::ship::MAX_SLOTS;

/// Damage / accuracy / evasion multipliers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mods {
    pub dmg: f64,
    pub acc: f64,
    pub eva: f64,
}

impl Mods {
    pub const ONE: Mods = Mods { dmg: 1.0, acc: 1.0, eva: 1.0 };

    fn build(name: &str, m: &DamageMods) -> Result<Mods, String> {
        let get = |v: Option<f64>, key: &str| match v {
            Some(x) if !x.is_finite() || x < 0.0 => Err(format!("{name}: {key} must be a non-negative number")),
            Some(x) => Ok(x),
            None => Ok(1.0),
        };
        Ok(Mods { dmg: get(m.dmg, "dmg")?, acc: get(m.acc, "acc")?, eva: get(m.eva, "eva")? })
    }
}

/// One plane group: its slots as a bit mask.
#[derive(Clone, Debug, PartialEq)]
struct PlaneGroup {
    mask: u8,
    mods: Mods,
    not_air_only: bool,
}

fn build_groups(name: &str, groups: Option<&Vec<PlaneBonusGroup>>, slots: usize) -> Result<Vec<PlaneGroup>, String> {
    let mut out = Vec::new();
    for (g, p) in groups.into_iter().flatten().enumerate() {
        let gname = format!("{name} plane group #{g}");
        let mut mask = 0u8;
        for &s in &p.slots {
            if s >= slots {
                return Err(format!("{gname}: slot {s} out of range (max {})", slots - 1));
            }
            mask |= 1 << s;
        }
        out.push(PlaneGroup { mask, mods: Mods::build(&gname, &p.mods)?, not_air_only: p.not_air_only });
    }
    Ok(out)
}

/// kcsim `getBonusSpecialPlane`: product over the groups with planes left in one of their slots;
/// attacks without planes (`air` false) and evasion use only the `notAirOnly` groups.
#[inline]
fn plane_mod(groups: &[PlaneGroup], planes: &[i32], air: bool, pick: fn(&Mods) -> f64) -> f64 {
    let mut m = 1.0;
    for g in groups {
        if (air || g.not_air_only) && planes.iter().enumerate().any(|(i, &n)| g.mask & (1 << i) != 0 && n > 0) {
            m *= pick(&g.mods);
        }
    }
    m
}

/// Event bonus of one friend ship in one battle.
#[derive(Clone, Debug, PartialEq)]
pub struct Bonus {
    ship: Mods,
    planes: Vec<PlaneGroup>,
}

impl Bonus {
    pub fn build(name: &str, set: &ShipBonusSet) -> Result<Bonus, String> {
        Ok(Bonus { ship: Mods::build(name, &set.mods)?, planes: build_groups(name, set.planes.as_ref(), MAX_SLOTS)? })
    }

    /// No multiplier differs from 1.
    pub fn is_none(&self) -> bool {
        self.ship == Mods::ONE && self.planes.iter().all(|g| g.mods == Mods::ONE)
    }

    /// Damage multiplier (kcsim `getBonusDmg` × plane `bonusSpecialP`); `air`: the attack uses planes.
    #[inline]
    pub fn dmg(&self, planes: &[i32], air: bool) -> f64 {
        self.ship.dmg * plane_mod(&self.planes, planes, air, |m| m.dmg)
    }

    /// Accuracy multiplier on the hit fraction (kcsim `getBonusAcc` × plane `bonusSpecialAccP`).
    /// Airstrikes (`air`) take the ship multiplier too, unlike kcsim (`getBonusAcc(…, isAir)` skips
    /// untyped entries): event-62 packets show the airstrike hit rate rising with the attacker's bonus
    /// (private notes VALIDATION §4).
    #[inline]
    pub fn acc(&self, planes: &[i32], air: bool) -> f64 {
        self.ship.acc * plane_mod(&self.planes, planes, air, |m| m.acc)
    }

    /// Evasion multiplier of the ship as a target (kcsim `bonusSpecialEv` × `notAirOnly` plane
    /// `bonusSpecialEvaP`, both after `evModPost`).
    #[inline]
    pub fn eva(&self, planes: &[i32]) -> f64 {
        self.ship.eva * plane_mod(&self.planes, planes, false, |m| m.eva)
    }
}

/// Event bonus of one land base in one battle: per squadron (kcsim `bonusSpecialPSelf` /
/// `bonusSpecialAccPSelf`) and base-wide plane groups (`bonusSpecialPUseAll`).
#[derive(Clone, Debug, PartialEq)]
pub struct BaseBonus {
    squadrons: Vec<Mods>,
    planes: Vec<PlaneGroup>,
}

impl BaseBonus {
    pub fn build(name: &str, set: &BaseBonusSet, slots: usize) -> Result<BaseBonus, String> {
        let squads = set.squadrons.as_deref().unwrap_or(&[]);
        if squads.len() > slots {
            return Err(format!("{name}: {} squadron bonuses (max {slots})", squads.len()));
        }
        let mut squadrons = Vec::with_capacity(squads.len());
        for (i, s) in squads.iter().enumerate() {
            squadrons.push(s.as_ref().map(|m| Mods::build(&format!("{name} squadron #{i}"), m)).transpose()?.unwrap_or(Mods::ONE));
        }
        Ok(BaseBonus { squadrons, planes: build_groups(name, set.planes.as_ref(), slots)? })
    }

    /// (damage, accuracy) multipliers of squadron `slot` given the base's squadron sizes.
    pub fn mods(&self, slot: usize, planes: &[i32]) -> (f64, f64) {
        let s = self.squadrons.get(slot).copied().unwrap_or(Mods::ONE);
        (s.dmg * plane_mod(&self.planes, planes, true, |m| m.dmg), s.acc * plane_mod(&self.planes, planes, true, |m| m.acc))
    }
}

/// Bonuses of a fleet's ships (`sets` in ship order, missing = none); `None` entries for ships
/// without any multiplier.
pub fn build_ships(name: &str, sets: Option<&[Option<ShipBonusSet>]>, ships: usize) -> Result<Vec<Option<Bonus>>, String> {
    let sets = sets.unwrap_or(&[]);
    if sets.len() > ships {
        return Err(format!("{name}: {} entries for {ships} ships", sets.len()));
    }
    (0..ships)
        .map(|i| match sets.get(i).and_then(|s| s.as_ref()) {
            Some(s) => Bonus::build(&format!("{name} #{i}"), s).map(|b| (!b.is_none()).then_some(b)),
            None => Ok(None),
        })
        .collect()
}

/// Friend-ship bonuses of a battle: main ships then escort ships; empty when no ship has one.
pub fn build_fleet(main: Option<&[Option<ShipBonusSet>]>, escort: Option<&[Option<ShipBonusSet>]>, main_len: usize, escort_len: usize, at: &str) -> Result<Vec<Option<Bonus>>, String> {
    if escort_len == 0 && escort.is_some_and(|e| !e.is_empty()) {
        return Err(format!("{at}escortBonuses without an escort fleet"));
    }
    let mut out = build_ships(&format!("{at}bonuses"), main, main_len)?;
    out.extend(build_ships(&format!("{at}escortBonuses"), escort, escort_len)?);
    if out.iter().all(Option::is_none) {
        out.clear();
    }
    Ok(out)
}

/// Land-base bonuses (`sets` in base order, missing = none); empty when none is set.
pub fn build_bases(name: &str, sets: Option<&[Option<BaseBonusSet>]>, bases: usize, slots: usize) -> Result<Vec<Option<BaseBonus>>, String> {
    let sets = sets.unwrap_or(&[]);
    if sets.len() > bases {
        return Err(format!("{name}: {} entries for {bases} land bases", sets.len()));
    }
    if sets.iter().all(Option::is_none) {
        return Ok(Vec::new());
    }
    sets.iter().enumerate().map(|(b, s)| s.as_ref().map(|s| BaseBonus::build(&format!("{name} #{b}"), s, slots)).transpose()).collect()
}

/// Validate debuffs (finite amounts).
pub fn validate_debuffs(name: &str, debuffs: &[ArmorDebuff]) -> Result<(), String> {
    match debuffs.iter().position(|d| !d.amount.is_finite()) {
        Some(i) => Err(format!("{name} debuff #{i}: amount must be a number")),
        None => Ok(()),
    }
}

/// Apply armor debuffs to enemy ships (kancolle-replay `applyAutoDebuff`: base armor
/// `max(1, armor − amount)`, the last matching entry wins; equipment armor still adds).
pub fn apply_debuffs(ships: &mut [ShipInput], debuffs: &[ArmorDebuff]) {
    for s in ships {
        let hit = debuffs.iter().rev().find(|d| d.ship_id.as_ref().is_none_or(|ids| s.id.is_some_and(|id| ids.contains(&id))));
        if let Some(d) = hit {
            s.stats.armor = (s.stats.armor - d.amount).max(1.0);
        }
    }
}

/// `fleet` with `debuffs` applied to its ships (main and escort); borrowed when there is none.
pub fn debuffed<'f>(fleet: &'f FleetInput, debuffs: &[ArmorDebuff]) -> Cow<'f, FleetInput> {
    if debuffs.is_empty() {
        return Cow::Borrowed(fleet);
    }
    let mut f = fleet.clone();
    apply_debuffs(&mut f.ships, debuffs);
    if let Some(e) = f.escort.as_mut() {
        apply_debuffs(e, debuffs);
    }
    Cow::Owned(f)
}
