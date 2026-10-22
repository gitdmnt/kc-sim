//! Main-gun fit (kcsim `Ship.getFit` + light cruiser `FPfit`, MECHANICS.fitGunUpdate1): a flat
//! accuracy term (in %, added after the hit-rate formula) for battleships, light cruisers, seaplane
//! tenders/oilers and a few ship classes, and a firepower term for light cruisers with 14 cm / 15.2 cm
//! guns. Friend ships only; keyed by equipment master id and `shipClass` (api_ctype).

use crate::ship::ShipClass;

const G46: &[u32] = &[9];
const GP46: &[u32] = &[117];
const G41: &[u32] = &[8, 105, 236, 290, 298, 299, 300, 318, 330, 331, 332, 381, 385, 390];
const G356: &[u32] = &[7, 76, 103, 104, 114, 190, 192, 289, 328, 329, 502, 503, 530];
const G381: &[u32] = &[133, 137];
const G16MK7: &[u32] = &[161, 183];
const G46K: &[u32] = &[276];
const G51: &[u32] = &[128, 281, 465];
const G305: &[u32] = &[231, 232];
const G320: &[u32] = &[426, 427, 428, 429];
const SEC155: &[u32] = &[12, 234, 463];
const G14_152: &[u32] = &[4, 119, 310, 65, 139, 407, 303, 359, 360, 361];
const G152: &[u32] = &[65, 139, 407, 303, 359, 360, 361];
/// CL firepower fit: single 14 cm / 15.2 cm mounts (+√n) and twin mounts (+2√n).
const CL_FP_SINGLE: &[u32] = &[4, 11];
const CL_FP_TWIN: &[u32] = &[65, 119, 139, 303, 310, 359, 360, 361, 407, 518, 534, 535];
/// Battleships with master HP > 92 (Yamato / Musashi forms, 576): no generic BB gun fit.
const HEAVY_BB: &[u32] = &[131, 136, 143, 148, 546, 576];
/// Medium-calibre main gun (api_type[2] = 2).
const CAT_MEDIUM_GUN: u32 = 2;

const YAMATO: u32 = 37;

/// `(accuracy %, firepower)` fit for a friend ship.
pub fn gun_fit(class: ShipClass, ctype: u32, master_id: u32, level: f64, equips: &[(u32, u32)]) -> (f64, f64) {
    let n = |ids: &[u32]| equips.iter().filter(|(id, _)| ids.contains(id)).count() as f64;
    let s = |ids: &[u32]| n(ids).sqrt();
    let married = if level >= 100.0 { 0.6 } else { 1.0 };
    match class {
        ShipClass::FBB => {
            let mut fit = -10.0 * s(G46) * married - 7.0 * s(GP46) * married - 5.0 * s(G41) * married + 4.0 * s(G356)
                - 2.0 * s(G381) * married
                - 5.0 * s(G16MK7) * married
                - 10.0 * s(G46K) * married
                - 10.0 * s(G51) * married
                + 12.0 * s(G305)
                + 14.0 * s(G320);
            match ctype {
                47 | 58 => fit += 3.0 * s(G381) * married,
                6 => fit += 3.0 * s(G356),
                65 => fit += 7.0 * s(&[161]) * married + 14.0 * s(&[183]) * married,
                73 => fit += -4.0 * s(G41) * married + 3.0 * s(G356),
                79 => fit += 2.0 * s(&[245, 246, 468]) - 2.0 * (n(G41) + n(G16MK7)).sqrt() * married,
                113 => fit -= 4.0 * s(G41) * married,
                YAMATO => fit += 3.0 * s(G46) + 3.0 * s(GP46) + 7.0 * s(G46K),
                _ => {}
            }
            (fit, 0.0)
        }
        ShipClass::BB => {
            let mut fit = 0.0;
            if !HEAVY_BB.contains(&master_id) {
                fit += -7.0 * s(G46) * married - 3.0 * s(GP46) * married + 2.0 * s(G41) + 2.0 * s(G356) + 2.0 * s(G381) * married;
            }
            if ctype != YAMATO {
                fit += -3.0 * s(G46K) * married - 5.0 * s(G51) * married;
            }
            match ctype {
                19 if master_id == 541 => fit += 4.0 * s(&[8]) + 3.0 * s(&G41[1..]),
                19 => fit += 2.0 * s(G41),
                67 => fit += 2.0 * s(&[190, 192]),
                YAMATO => {
                    fit += 3.0 * s(G46) + 3.0 * s(GP46) + 7.0 * s(G46K);
                    if n(SEC155) > 0.0 {
                        fit += 2.0;
                    }
                }
                _ => {}
            }
            (fit, 0.0)
        }
        ShipClass::BBV => {
            let fit = if ctype == YAMATO {
                -8.0 * (n(G46) + n(G46K) + n(G51)).sqrt() * married - 5.0 * s(GP46) * married
                    + 2.0 * s(G41)
                    + 4.0 * s(G356)
                    + 2.0 * s(G381) * married
                    + 3.0 * s(G46)
                    + 3.0 * s(GP46)
                    + 7.0 * s(G46K)
                    + if n(SEC155) > 0.0 { 2.0 } else { 0.0 }
            } else {
                -7.0 * s(G46) * married - 3.0 * s(GP46) * married + 2.0 * s(G41) + 4.0 * s(G356) + 2.0 * s(G381) * married
                    - 7.0 * s(G46K) * married
            };
            (fit, 0.0)
        }
        ShipClass::CL | ShipClass::CLT | ShipClass::CT => {
            let medium = equips.iter().filter(|(_, cat)| *cat == CAT_MEDIUM_GUN).count() as f64;
            let n8inch = n(&[356, 357]);
            let mut fit = 4.0 * s(G14_152) - 6.0 * n8inch;
            match ctype {
                41 => {
                    fit += -medium + 3.0 * s(G152);
                    if n(G152) > 0.0 {
                        fit += 3.0;
                    }
                }
                52 => fit += -2.0 * medium + 4.0 * n(&[5, 235]),
                99 => fit += 3.0 * n(&[362, 363]),
                _ => {}
            }
            if master_id == 488 {
                fit += 10.0 * s(&[229]);
            }
            fit -= (3.0 * medium + 2.0 * n8inch) * married;
            (fit, s(CL_FP_SINGLE) + 2.0 * s(CL_FP_TWIN))
        }
        ShipClass::AV | ShipClass::AO => {
            let medium = equips.iter().filter(|(_, cat)| *cat == CAT_MEDIUM_GUN).count() as f64;
            if medium == 0.0 {
                return (0.0, 0.0);
            }
            let light = n(G14_152);
            let fit = if light > 0.0 { -6.0 * light } else { -8.0 } - 10.0 * (medium - light);
            (fit, 0.0)
        }
        _ => {
            let fit = match ctype {
                9 => 4.0 * s(&[5, 235]),
                81 => 5.0 * s(&[282]),
                _ if master_id == 147 => 5.0 * s(&[282]),
                82 => 3.0 * s(&[280]) + 3.0 * s(&[260, 261, 262]),
                87 => 4.0 * s(&[308, 313]),
                91 => 4.0 * s(&[284, 308, 313]) + if n(&[284]) >= 2.0 { 4.0 } else { 0.0 },
                28 => 5.0 * s(&[229, 293]),
                _ => 0.0,
            };
            (fit, 0.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn examples() {
        // Kongou-class (ctype 6) with two 41 cm guns, unmarried: -5√2.
        let (acc, _) = gun_fit(ShipClass::FBB, 6, 149, 99.0, &[(8, 3), (8, 3)]);
        assert!((acc + 5.0 * 2f64.sqrt()).abs() < 1e-9);
        // married: ×0.6
        let (acc, _) = gun_fit(ShipClass::FBB, 6, 149, 120.0, &[(8, 3), (8, 3)]);
        assert!((acc + 3.0 * 2f64.sqrt()).abs() < 1e-9);
        // Nagato-class with 41 cm: +2√2; Yamato with 46 cm: +3 (no BB penalty for heavy BBs).
        assert!((gun_fit(ShipClass::BB, 19, 275, 99.0, &[(8, 3), (8, 3)]).0 - 4.0 * 2f64.sqrt()).abs() < 1e-9);
        assert_eq!(gun_fit(ShipClass::BB, YAMATO, 136, 99.0, &[(9, 3)]).0, 3.0);
        // CL with two 15.2 cm twin mounts (medium guns): acc 4√2 − 2·3, fp +2√2; a 20.3 cm gun costs 3.
        let (acc, fp) = gun_fit(ShipClass::CL, 21, 200, 99.0, &[(65, CAT_MEDIUM_GUN), (65, CAT_MEDIUM_GUN)]);
        assert!((acc - (4.0 * 2f64.sqrt() - 6.0)).abs() < 1e-9 && (fp - 2.0 * 2f64.sqrt()).abs() < 1e-9);
        assert_eq!(gun_fit(ShipClass::CL, 21, 200, 99.0, &[(6, CAT_MEDIUM_GUN)]).0, -3.0);
        // AV with a 15.2 cm gun: -6; DD without class guns: 0.
        assert_eq!(gun_fit(ShipClass::AV, 0, 0, 99.0, &[(65, CAT_MEDIUM_GUN)]).0, -6.0);
        assert_eq!(gun_fit(ShipClass::DD, 23, 145, 99.0, &[(63, 1)]), (0.0, 0.0));
    }
}
