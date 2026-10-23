//! Main-gun fit (砲フィット): a flat accuracy term (in %, added after the hit-rate formula, day and
//! night alike as in kcsim `fitGunUpdate1` where `ACCfitN = ACCfit`) and, for light cruisers, the
//! 14 cm / 15.2 cm firepower fit. Friend ships only; keyed by equipment master id and `shipClass`
//! (api_ctype).
//!
//! Sources:
//! - wikiwiki.jp/kancolle/命中と回避について §フィット補正 (BB table as of 2023-02, CL table
//!   2024-03, DD / AV tables 2024-03, comments up to 2026-08: 18cm/57 and 20.3cm/50 SHS改 are
//!   CL category F, 15.2cm三連装主砲 behaves like D on non-Gloire CLs).
//! - KC3Kai/kancolle-replay `Ship.prototype.getFit` (kcships.js) for classes the wiki leaves
//!   unspecified (Richelieu/Gangut/Cavour detail, Warspite 38.1cm, Yura K2, Mutsuki 12.7cm後期型,
//!   Yamato + 15.5cm secondary).
//! Not here: the CA/CAV 20.3cm night accuracy bonus (one-off, not √n) lives with the night hit
//! formula (calc.rs). Zara-class 203mm/53 fit has no published value and is omitted.

use crate::ship::ShipClass;

// --- Battleship gun categories (wiki 主砲カテゴリ表). ---
const G46: &[u32] = &[9];
const GP46: &[u32] = &[117];
const G41: &[u32] = &[8, 105, 236, 290, 298, 299, 300, 318, 330, 331, 332, 381, 385, 390];
const G356: &[u32] = &[7, 76, 103, 104, 114, 190, 192, 289, 328, 329, 502, 503, 530];
const G38Q: &[u32] = &[245, 246, 468];
const G381: &[u32] = &[133, 137];
const G16MK7: &[u32] = &[161, 183];
const G46K: &[u32] = &[276];
const G51: &[u32] = &[128, 281, 465];
const G305: &[u32] = &[231, 232];
const G320: &[u32] = &[426, 427, 428, 429];
const SEC155: &[u32] = &[12, 234, 463];

// --- Light cruiser medium-gun categories (wiki 軽巡の主砲フィット補正 A–G). ---
const CL_A: &[u32] = &[4, 119, 310];
const CL_B: &[u32] = &[65, 139, 407, 303, 359, 360, 361];
const CL_C: &[u32] = &[5, 235];
const CL_D: &[u32] = &[386, 387, 399, 340, 341, 536, 537];
const CL_E: &[u32] = &[362, 363];
const CL_F: &[u32] = &[6, 90, 50, 123, 162, 555, 582, 583];
const CL_G: &[u32] = &[356, 357];

/// CL firepower fit: single 14 cm / 15.2 cm mounts (+√n) and twin mounts (+2√n).
const CL_FP_SINGLE: &[u32] = &[4, 11];
const CL_FP_TWIN: &[u32] = &[65, 119, 139, 303, 310, 359, 360, 361, 407, 518, 534, 535];
/// Seaplane-tender light-gun group (14 cm / 15.2 cm incl. 14cm連装砲改二).
const AV_LIGHT: &[u32] = &[4, 119, 310, 518, 65, 139, 407];
/// Battleships with master HP > 92 (戦艦B群: Yamato / Musashi forms, Nelson改): no generic BB fit.
const HEAVY_BB: &[u32] = &[131, 136, 143, 148, 546, 576];
/// Medium-calibre main gun (api_type[2] = 2).
const CAT_MEDIUM_GUN: u32 = 2;

const YAMATO: u32 = 37;
const NAGATO: u32 = 19;
const NAGATO_K2: u32 = 541;
const AGANO: u32 = 41;
const OOYODO: u32 = 52;
const ATLANTA: u32 = 99;

/// `(accuracy %, firepower)` fit for a friend ship.
pub fn gun_fit(class: ShipClass, ctype: u32, master_id: u32, level: f64, equips: &[(u32, u32)]) -> (f64, f64) {
    let n = |ids: &[u32]| equips.iter().filter(|(id, _)| ids.contains(id)).count() as f64;
    let s = |ids: &[u32]| n(ids).sqrt();
    let is_married = level >= 100.0;
    // Marriage scales the (underlined) penalties by 0.6.
    let married = if is_married { 0.6 } else { 1.0 };
    match class {
        ShipClass::FBB => {
            // 46cm and 46cm改 share one category for the 巡洋戦艦 base fit (wiki, 2024-01).
            let mut fit = -10.0 * (n(G46) + n(G46K)).sqrt() * married - 7.0 * s(GP46) * married
                - 5.0 * s(G41) * married
                + 4.0 * s(G356)
                - 2.0 * s(G381) * married
                - 5.0 * s(G16MK7) * married
                - 10.0 * s(G51) * married
                + 12.0 * s(G305)
                + 14.0 * s(G320);
            match ctype {
                47 | 58 => fit += 3.0 * s(G381) * married,
                6 => fit += 3.0 * s(G356),
                65 => fit += 7.0 * s(&[161]) * married + 14.0 * s(&[183]) * married,
                73 => fit += -4.0 * s(G41) * married + 3.0 * s(G356),
                79 => fit += 2.0 * s(G38Q) - 2.0 * (n(G41) + n(G16MK7)).sqrt() * married,
                113 => fit -= 4.0 * s(G41) * married,
                YAMATO => fit += 3.0 * s(G46) + 3.0 * s(GP46) + 7.0 * s(G46K),
                _ => {}
            }
            (fit, 0.0)
        }
        ShipClass::BB => {
            let mut fit = 0.0;
            if !HEAVY_BB.contains(&master_id) {
                // 戦艦A群 base (wiki): 46cm改 -7 (kcsim: -3), 51cm 0 (kcsim: -5 for all).
                fit += -7.0 * s(G46) * married - 7.0 * s(G46K) * married - 3.0 * s(GP46) * married
                    + 2.0 * s(G41)
                    + 2.0 * s(G356)
                    + 2.0 * s(G381) * married;
            }
            match ctype {
                NAGATO => {
                    fit -= 5.0 * s(G51) * married;
                    if master_id == NAGATO_K2 {
                        fit += 4.0 * s(&[8]) + 3.0 * s(&G41[1..]);
                    } else {
                        fit += 2.0 * s(G41);
                    }
                }
                67 => fit += 2.0 * s(&[190, 192]),
                YAMATO => {
                    fit += 3.0 * s(G46) + 3.0 * s(GP46) + 7.0 * s(G46K);
                    // kcsim only [unverified]: +2 with any 15.5 cm secondary.
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
                // 航空戦艦B群 (Yamato K2重): 46cm / 46cm改 / 51cm share the -8 base category.
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
            (cl_acc_fit(ctype, master_id, is_married, &n), s(CL_FP_SINGLE) + 2.0 * s(CL_FP_TWIN))
        }
        ShipClass::AV | ShipClass::AO => {
            let medium = equips.iter().filter(|(_, cat)| *cat == CAT_MEDIUM_GUN).count() as f64;
            if medium == 0.0 {
                return (0.0, 0.0);
            }
            // wiki: light only -6n; heavy only -10n - 8; mixed -6·light - 10·heavy.
            let light = n(AV_LIGHT);
            let fit = if light > 0.0 { -6.0 * light } else { -8.0 } - 10.0 * (medium - light);
            (fit, 0.0)
        }
        _ => {
            let fit = match ctype {
                9 => 4.0 * s(CL_C),
                81 => 5.0 * s(&[282]),
                _ if master_id == 147 => 5.0 * s(&[282]),
                82 => 3.0 * s(&[280]) + 3.0 * s(&[260, 261, 262]),
                // Samuel B. Roberts: Mk.30 (284) not applied (wiki: likely a game bug).
                87 => 4.0 * s(&[308, 313]),
                // Fletcher: 4√n; two Mk.30 observed up to ≈+10 (wiki note), kcsim adds +4.
                91 => 4.0 * s(&[284, 308, 313]) + if n(&[284]) >= 2.0 { 4.0 } else { 0.0 },
                28 => 5.0 * s(&[229, 293]),
                _ => 0.0,
            };
            (fit, 0.0)
        }
    }
}

/// Light cruiser accuracy fit (wiki table for 1–2 guns per category). Where only the two-gun
/// value is published the penalty is taken as linear per gun [unverified].
fn cl_acc_fit(ctype: u32, master_id: u32, married: bool, n: &dyn Fn(&[u32]) -> f64) -> f64 {
    let (a, b, c, d, e, f, g) = (n(CL_A), n(CL_B), n(CL_C), n(CL_D), n(CL_E), n(CL_F), n(CL_G));
    let m6 = if married { 0.6 } else { 1.0 };
    let mut fit = 0.0;
    // A/B: 0, married +2 (Agano B: +5 / +6 for 1 / 2, married +2).
    if ctype == AGANO && b > 0.0 {
        fit += if b >= 2.0 { 6.0 } else { 5.0 };
    }
    if a + b > 0.0 && married {
        fit += 2.0;
    }
    fit += match ctype {
        OOYODO => -1.0 * c * m6,
        _ => c * if married { -0.5 } else { -2.5 },
    };
    fit += -3.0 * d * m6;
    fit += if ctype == ATLANTA {
        if e > 0.0 && married { 3.0 } else { 0.0 }
    } else {
        -3.0 * e * m6
    };
    fit += match ctype {
        AGANO => f * if married { -3.0 } else { -4.0 },
        OOYODO => -5.0 * f * m6,
        _ => -3.0 * f * m6,
    };
    // 8inch: -22 for two, marriage ×0.8.
    fit += -11.0 * g * if married { 0.8 } else { 1.0 };
    // Yura K2 with 12.7cm単装高角砲(後期型): kcsim/KC3 value.
    if master_id == 488 {
        fit += 10.0 * n(&[229]).sqrt();
    }
    fit
}
