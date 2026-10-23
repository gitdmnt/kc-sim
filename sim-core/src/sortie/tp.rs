//! Transport points (TP) of a fleet at a transport gauge's boss node.
//! Tables: KC3Kai `src/data/fud_quarterly.json#tpMultipliers` (MIT); formula: KC3Kai `Ship.js obtainTP`,
//! `Fleet.js calcTpObtain`, `Meta.js tpObtained` (rank A = floor(0.7 × TP)).

use super::model::TankType;
use crate::model::{Rank, ShipInput};

/// TP of a ship by `api_stype`; `None` = not in the source table (counted as 0, warned).
pub fn stype_tp(stype: u32) -> Option<f64> {
    Some(match stype {
        0 | 1 | 4 | 5 | 7 | 8 | 9 | 11 | 13 | 18 => 0.0,
        2 => 5.0,
        3 => 2.0,
        6 => 4.0,
        10 | 20 => 7.0,
        14 => 1.0,
        16 => 9.0,
        17 => 12.0,
        21 => 6.0,
        22 => 15.0,
        _ => return None,
    })
}

/// TP of an equipment by `api_type[2]`: landing craft 24, drum canister 30, ration 43, special motor boat 46.
pub fn gear_tp(type2: u32) -> f64 {
    match type2 {
        24 => 8.0,
        30 => 5.0,
        43 => 1.0,
        46 => 2.0,
        _ => 0.0,
    }
}

const KINU_K2: u32 = 487;
/// Kinu Kai Ni carries one embedded landing craft that counts once for the fleet.
const EMBEDDED_TP: f64 = 8.0;

const TANK1: [(u32, f64); 17] = [
    (166, 8.0), (167, 11.0), (230, 13.0), (355, 14.0), (436, 10.0), (449, 15.0), (482, 13.0), (494, 11.0), (495, 13.0),
    (496, 5.0), (497, 7.0), (498, 9.0), (499, 14.0), (514, 17.0), (525, 10.0), (526, 12.0), (576, 18.0),
];
const TANK2: [(u32, f64); 16] = [
    (166, 6.0), (167, 18.0), (230, 12.0), (355, 14.0), (436, 8.0), (449, 22.0), (482, 10.0), (494, 11.0), (495, 13.0),
    (496, 5.0), (497, 8.0), (498, 10.0), (499, 13.0), (514, 15.0), (525, 15.0), (526, 18.0),
];

/// Index into the per-mode arrays: 0 plain (also `typeUnk`), 1 `type1`, 2 `type2`.
pub fn mode(tank: Option<TankType>) -> usize {
    match tank {
        Some(TankType::Type1) => 1,
        Some(TankType::Type2) => 2,
        _ => 0,
    }
}

const MODIFIER: [f64; 3] = [1.0, 0.75, 0.8];

/// TP parts of one ship.
#[derive(Clone, Debug, Default)]
pub struct ShipTp {
    /// Ship type + equipment TP (scaled by the tank modifier in tank modes).
    pub base: f64,
    /// Tank-table TP per mode (unscaled).
    pub tanks: [f64; 3],
    pub embedded: bool,
}

pub fn ship_tp(s: &ShipInput) -> ShipTp {
    let mut t = ShipTp { base: stype_tp(s.ship_type).unwrap_or(0.0), embedded: s.id == Some(KINU_K2), ..Default::default() };
    for e in s.slots.iter().flatten().chain(s.ex_slot.iter()) {
        t.base += gear_tp(e.types.get(2).copied().unwrap_or(0));
        t.tanks[1] += TANK1.iter().find(|(id, _)| *id == e.id).map_or(0.0, |x| x.1);
        t.tanks[2] += TANK2.iter().find(|(id, _)| *id == e.id).map_or(0.0, |x| x.1);
    }
    t
}

/// Fleet TP per mode over the ships that count (afloat, not heavily damaged).
pub fn fleet_tp(ships: &[ShipTp], counts: impl Fn(usize) -> bool) -> [i32; 3] {
    let mut out = [0; 3];
    for (m, o) in out.iter_mut().enumerate() {
        let sum: f64 = ships.iter().enumerate().filter(|(i, _)| counts(*i)).map(|(_, s)| s.base * MODIFIER[m] + s.tanks[m]).sum();
        let embedded = if ships.iter().enumerate().any(|(i, s)| s.embedded && counts(i)) { EMBEDDED_TP } else { 0.0 };
        *o = (sum + 1e-9).floor() as i32 + embedded as i32;
    }
    out
}

/// TP gained by a boss result: S / SS full, A × 0.7 floored, otherwise 0.
pub fn gained(tp: f64, rank: Rank) -> f64 {
    match rank {
        Rank::SS | Rank::S => tp,
        Rank::A => (tp * 0.7 + 1e-9).floor(),
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_a_is_seventy_percent_floored() {
        assert_eq!(gained(100.0, Rank::S), 100.0);
        assert_eq!(gained(100.0, Rank::A), 70.0);
        assert_eq!(gained(19.0, Rank::A), 13.0);
        assert_eq!(gained(100.0, Rank::B), 0.0);
    }

    #[test]
    fn fleet_tp_by_type_and_equipment() {
        let ships = [ShipTp { base: 5.0 + 8.0 + 5.0, ..Default::default() }, ShipTp { base: 15.0, tanks: [0.0, 8.0, 6.0], embedded: true }];
        assert_eq!(fleet_tp(&ships, |_| true), [41, 40, 40]);
        // the second ship is heavily damaged: it and its embedded craft are dropped
        assert_eq!(fleet_tp(&ships, |i| i == 0), [18, 13, 14]);
    }

    #[test]
    fn unknown_stype_has_no_table_entry() {
        assert_eq!(stype_tp(22), Some(15.0));
        assert_eq!(stype_tp(19), None);
    }
}
