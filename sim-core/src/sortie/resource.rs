//! Sortie resource accounting: resupply, docking, maelstrom and quantile helpers.

pub const MARRIED_LEVEL: f64 = 100.0;

/// 15% off the resupply amount, floored, only above 1 (KC3Kai `KC3Ship.calcResupplyCost`; kcwiki 结婚).
pub fn resupply_cost(used: i32, married: bool) -> i32 {
    if married && used > 1 {
        (used as i64 * 85 / 100) as i32
    } else {
        used
    }
}

/// Docking (fuel, steel): floor(0.032 / 0.06 × master fuel max × HP lost) (kancolle-replay `getRepairCost`, KC3Kai `calcRepairCost`).
pub fn repair_cost(fuel_max: i32, hp_lost: i32) -> (i32, i32) {
    let base = fuel_max.max(0) as i64 * hp_lost.max(0) as i64;
    ((base * 32 / 1000) as i32, (base * 6 / 100) as i32)
}

/// Docking time multiplier ×2 by `api_stype` (wikiwiki 入渠, kcwiki 入渠, kancolle-replay `getRepairTime`).
fn dock_mult2(stype: u32) -> i64 {
    match stype {
        1 | 13 => 1,
        5..=8 | 20 => 3,
        9..=11 | 18 | 19 => 4,
        _ => 2,
    }
}

/// Docking seconds: `(base(Lv) × type × HP lost) + 30`, 0 when nothing is missing.
pub fn repair_time_sec(stype: u32, level: f64, hp_lost: i32) -> u32 {
    if hp_lost <= 0 {
        return 0;
    }
    let lv = level.floor().max(1.0) as i64;
    let base = if lv <= 11 { lv * 10 } else { lv * 5 + ((lv - 11) as f64).sqrt().floor() as i64 * 10 + 50 };
    (base * dock_mult2(stype) * hp_lost as i64 / 2 + 30) as u32
}

/// Loss reduction by number of radar ships (KC3Kai `reduceFleetRscOnMaelstrom`; kcwiki 燃油和弹药的地图损失).
pub const RADAR_REDUCTION: [f64; 7] = [0.0, 0.25, 0.4, 0.5, 0.55, 0.58, 0.6];

/// Maelstrom loss of one ship: `min(max, floor(have × rate × (1 − radar)))`.
pub fn maelstrom_loss(have: i32, rate: f64, max: Option<i32>, radar_ships: usize, reducible: bool) -> i32 {
    let red = if reducible { RADAR_REDUCTION[radar_ships.min(6)] } else { 0.0 };
    let loss = (have as f64 * (rate * (1.0 - red)) + 1e-9).floor() as i32;
    loss.min(max.unwrap_or(i32::MAX)).min(have).max(0)
}

/// Sorted-sample percentile (nearest rank), as in the gauge summary.
pub fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((q * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[i]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn married_resupply_rounds_down_and_keeps_one() {
        assert_eq!(resupply_cost(1, true), 1);
        assert_eq!(resupply_cost(2, true), 1);
        assert_eq!(resupply_cost(20, true), 17);
        assert_eq!(resupply_cost(20, false), 20);
        assert_eq!(resupply_cost(0, true), 0);
    }

    #[test]
    fn docking_cost_and_time_boundaries() {
        assert_eq!(repair_cost(15, 1), (0, 0));
        assert_eq!(repair_cost(250, 10), (80, 150));
        // Lv11 DD, 10 HP: 110 × 1.0 × 10 + 30
        assert_eq!(repair_time_sec(2, 11.0, 10), 1130);
        // Lv12: 60+10+50 = 120; BB ×2, 1 HP
        assert_eq!(repair_time_sec(9, 12.0, 1), 270);
        // Lv100 SS ×0.5, 3 HP: (500+90+50) × 0.5 × 3 + 30
        assert_eq!(repair_time_sec(13, 100.0, 3), 990);
        assert_eq!(repair_time_sec(2, 50.0, 0), 0);
    }

    #[test]
    fn maelstrom_radar_table_matches_wiki() {
        // kcwiki: 30% base → 22.5 / 18 / 15 / 12 % with 1 / 2 / 3 / 6 radar ships.
        assert_eq!(maelstrom_loss(1000, 0.3, None, 0, true), 300);
        assert_eq!(maelstrom_loss(1000, 0.3, None, 1, true), 225);
        assert_eq!(maelstrom_loss(1000, 0.3, None, 2, true), 180);
        assert_eq!(maelstrom_loss(1000, 0.3, None, 3, true), 150);
        assert_eq!(maelstrom_loss(1000, 0.3, None, 9, true), 120);
        assert_eq!(maelstrom_loss(1000, 0.3, None, 3, false), 300);
        assert_eq!(maelstrom_loss(1000, 0.3, Some(50), 0, true), 50);
        assert_eq!(maelstrom_loss(10, 1.5, None, 0, true), 10);
    }
}
