//! Formation and engagement modifiers (kcsim LINEAHEAD..VANGUARD2, SIMCONSTS vanguard tables).

use crate::model::{Engagement, Formation};
use crate::ship::ShipClass;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FormMods {
    pub shell_pow: f64,
    pub torp_pow: f64,
    pub asw_pow: f64,
    pub aa: f64,
    pub shell_acc: f64,
    pub torp_acc: f64,
    pub night_acc: f64,
    /// `None` = use `shell_acc`.
    pub asw_acc: Option<f64>,
    pub shell_ev: f64,
    pub torp_ev: f64,
    pub night_ev: f64,
    pub asw_ev: f64,
}

#[allow(clippy::too_many_arguments)]
const fn fm(
    shell_pow: f64,
    torp_pow: f64,
    asw_pow: f64,
    aa: f64,
    shell_acc: f64,
    torp_acc: f64,
    night_acc: f64,
    asw_acc: Option<f64>,
    shell_ev: f64,
    torp_ev: f64,
    night_ev: f64,
    asw_ev: f64,
) -> FormMods {
    FormMods { shell_pow, torp_pow, asw_pow, aa, shell_acc, torp_acc, night_acc, asw_acc, shell_ev, torp_ev, night_ev, asw_ev }
}

pub const LINE_AHEAD: FormMods = fm(1.0, 1.0, 0.6, 1.0, 1.0, 1.0, 1.0, None, 1.0, 1.0, 1.0, 1.0);
pub const DOUBLE_LINE: FormMods = fm(0.8, 0.8, 0.8, 1.2, 1.2, 0.8, 0.9, None, 1.0, 1.0, 1.0, 1.0);
pub const DIAMOND: FormMods = fm(0.7, 0.7, 1.2, 1.6, 1.0, 0.4, 0.7, None, 1.1, 1.1, 1.0, 1.0);
pub const ECHELON: FormMods = fm(0.75, 0.6, 1.1, 1.0, 1.2, 0.75, 0.9, None, 1.4, 1.3, 1.3, 1.3);
pub const LINE_ABREAST: FormMods = fm(0.6, 0.6, 1.3, 1.0, 1.2, 0.3, 0.8, None, 1.3, 1.4, 1.2, 1.1);
/// Vanguard, first half of the fleet.
pub const VANGUARD_FRONT: FormMods = fm(0.5, 1.0, 1.0, 1.1, 0.8, 0.7, 0.8, Some(1.0), 1.0, 1.0, 1.0, 1.0);
/// Vanguard, second half of the fleet.
pub const VANGUARD_BACK: FormMods = fm(1.0, 1.0, 0.6, 1.1, 1.2, 0.9, 1.2, Some(1.1), 1.0, 1.0, 1.0, 1.0);

/// Accuracy multipliers applied to attacks AGAINST a vanguard fleet, by target position (1-based
/// index − 1). Shelling / night / ASW tables and torpedo tables; DD vs other ships (normal maps).
const VANGUARD_EV_SHELL_OTHER: [f64; 7] = [0.95, 0.95, 0.95, 0.95, 0.86, 0.79, 0.7];
const VANGUARD_EV_SHELL_DD: [f64; 7] = [0.95, 0.95, 0.8, 0.8, 0.69, 0.64, 0.64];
const VANGUARD_EV_TORP_OTHER: [f64; 7] = [0.9, 0.9, 0.77, 0.67, 0.63, 0.55, 0.51];
const VANGUARD_EV_TORP_DD: [f64; 7] = [0.9, 0.9, 0.65, 0.58, 0.5, 0.42, 0.42];

/// Modifiers of the ship at `idx` (0-based) in a fleet of `len` ships.
pub fn mods(form: Formation, idx: usize, len: usize) -> &'static FormMods {
    match form {
        Formation::LineAhead => &LINE_AHEAD,
        Formation::DoubleLine => &DOUBLE_LINE,
        Formation::Diamond => &DIAMOND,
        Formation::Echelon => &ECHELON,
        Formation::LineAbreast => &LINE_ABREAST,
        Formation::Vanguard => {
            if vanguard_front(idx, len) {
                &VANGUARD_FRONT
            } else {
                &VANGUARD_BACK
            }
        }
    }
}

/// kcsim `getFormation`: ships with `num <= floor(len/2)` use the first-half table.
pub fn vanguard_front(idx: usize, len: usize) -> bool {
    idx < len / 2
}

/// Accuracy multiplier against a vanguard target (kcsim `vanguardUseType` 2, normal maps).
pub fn vanguard_target_acc(target_class: ShipClass, idx: usize, torpedo: bool) -> f64 {
    let dd = target_class == ShipClass::DD;
    let table = match (torpedo, dd) {
        (false, false) => &VANGUARD_EV_SHELL_OTHER,
        (false, true) => &VANGUARD_EV_SHELL_DD,
        (true, false) => &VANGUARD_EV_TORP_OTHER,
        (true, true) => &VANGUARD_EV_TORP_DD,
    };
    table.get(idx).copied().unwrap_or(1.0)
}

/// kcsim `formationCountered`: the attacker's formation accuracy modifier is not applied.
pub fn countered(att: Formation, def: Formation) -> bool {
    matches!(
        (att, def),
        (Formation::DoubleLine, Formation::LineAbreast)
            | (Formation::Echelon, Formation::LineAhead)
            | (Formation::LineAbreast, Formation::Echelon)
    )
}

/// Flagship protection (かばう) activation rate of the defending fleet.
pub fn protection_rate(form: Formation) -> f64 {
    match form {
        Formation::LineAhead => 0.45,
        Formation::DoubleLine => 0.6,
        Formation::Diamond => 0.75,
        Formation::Echelon => 0.6,
        Formation::LineAbreast => 0.6,
        Formation::Vanguard => 0.75,
    }
}

pub fn engagement_mod(e: Engagement) -> f64 {
    match e {
        Engagement::SameCourse => 1.0,
        Engagement::HeadOn => 0.8,
        Engagement::TAdvantage => 1.2,
        Engagement::TDisadvantage => 0.6,
    }
}

/// Random engagement: 45% same course, 15% T+, 30% head-on, 10% T- (head-on with a Saiun).
pub fn roll_engagement(r: f64, no_red_t: bool) -> Engagement {
    if r < 0.45 {
        Engagement::SameCourse
    } else if r < 0.6 {
        Engagement::TAdvantage
    } else if r < 0.9 || no_red_t {
        Engagement::HeadOn
    } else {
        Engagement::TDisadvantage
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vanguard_halves() {
        // 6 ships: #1-3 front; 5 ships: #1-2 front; 4 ships: #1-2 front.
        assert!(vanguard_front(2, 6) && !vanguard_front(3, 6));
        assert!(vanguard_front(1, 5) && !vanguard_front(2, 5));
        assert!(vanguard_front(1, 4) && !vanguard_front(2, 4));
        assert_eq!(mods(Formation::Vanguard, 0, 6).shell_pow, 0.5);
        assert_eq!(mods(Formation::Vanguard, 5, 6).shell_acc, 1.2);
    }

    #[test]
    fn formation_table() {
        assert_eq!(mods(Formation::LineAbreast, 0, 6).torp_acc, 0.3);
        assert_eq!(mods(Formation::Diamond, 0, 6).aa, 1.6);
        assert_eq!(mods(Formation::Echelon, 0, 6).shell_ev, 1.4);
        assert!(countered(Formation::Echelon, Formation::LineAhead));
        assert!(!countered(Formation::LineAhead, Formation::Echelon));
    }
}
