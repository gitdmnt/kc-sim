//! Improvement (★) effects per category, checked against wikiwiki 改修工廠 (改修装備の効果) and
//! 対空砲火 (改修係数) tables. Weighted-AA terms are on the engine's halved scale (`derive_aa`).

use serde_json::json;
use sim_core::equipment::{cat, Equip};
use sim_core::model::EquipmentInput;

fn eq(id: u32, c: u32, icon: u32, stats: serde_json::Value, lv: u32) -> Equip {
    let input: EquipmentInput =
        serde_json::from_value(json!({ "id": id, "types": [0, 0, c, icon, 0], "stats": stats, "improvement": lv }))
            .unwrap();
    Equip::from_input(&input)
}

fn close(a: f64, b: f64, tol: f64) {
    assert!((a - b).abs() <= tol, "{a} != {b} (±{tol})");
}

/// Wiki early-lookup tables round to 2 decimals.
const T: f64 = 0.005;

#[test]
fn main_guns_wiki_examples() {
    // Example 1: 12.7cm twin ★6 + ★7 = √6 + √7 = 5.095 shelling.
    let a = eq(2, cat::MAIN_GUN_S, 1, json!({ "firepower": 2 }), 6);
    let b = eq(2, cat::MAIN_GUN_S, 1, json!({ "firepower": 2 }), 7);
    close(a.imp.p_shell + b.imp.p_shell, 5.095, 0.001);
    close(a.imp.p_nb, 6f64.sqrt(), 1e-9);
    close(a.imp.acc_shell, 6f64.sqrt(), 1e-9);
    close(a.imp.p_torp + a.imp.p_asw, 0.0, 0.0);
    // Example 2: 35.6cm twin ★6 + ★5 = 1.5(√6 + √5) = 7.028 day; night stays √★.
    let a = eq(7, cat::MAIN_GUN_L, 3, json!({ "firepower": 15 }), 6);
    let b = eq(7, cat::MAIN_GUN_L, 3, json!({ "firepower": 15 }), 5);
    close(a.imp.p_shell + b.imp.p_shell, 7.028, 0.001);
    close(a.imp.p_nb, 6f64.sqrt(), 1e-9);
    // Large-gun table ×1.5: ★9 4.50, max 4.74 (category 38 too).
    close(eq(9, cat::MAIN_GUN_L2, 3, json!({ "firepower": 20 }), 9).imp.p_shell, 4.50, T);
    close(eq(9, cat::MAIN_GUN_L2, 3, json!({ "firepower": 20 }), 10).imp.p_shell, 4.74, T);
    // Medium guns √★, except 20.3cm/50 Kai (SHS) (583, FP 13) which counts as large.
    close(eq(6, cat::MAIN_GUN_M, 2, json!({ "firepower": 8 }), 4).imp.p_shell, 2.0, 1e-9);
    close(eq(583, cat::MAIN_GUN_M, 2, json!({ "firepower": 13 }), 4).imp.p_shell, 3.0, 1e-9);
}

#[test]
fn secondary_guns_by_id() {
    // A: 15.2cm single / OTO 152mm: √★.
    let g = eq(11, cat::SEC_GUN, 4, json!({ "firepower": 2 }), 4);
    close(g.imp.p_shell, 2.0, 1e-9);
    close(g.imp.p_nb, 2.0, 1e-9);
    close(eq(134, cat::SEC_GUN, 4, json!({ "firepower": 8 }), 9).imp.p_shell, 3.0, 1e-9);
    // B: 12.7cm twin HA, 8cm HA, 12.7cm HA + AAFD (130): 0.2★ day and night.
    for id in [10, 66, 130, 220, 275, 464] {
        let g = eq(id, cat::SEC_GUN, 16, json!({ "firepower": 1, "antiAir": 6 }), 10);
        close(g.imp.p_shell, 2.0, 1e-9);
        close(g.imp.p_nb, 2.0, 1e-9);
    }
    // C: 15.5cm triple (kai / kai 2), 15.2cm triple, 5inch twin (secondary): 0.3★.
    for id in [12, 234, 247, 463, 467] {
        let g = eq(id, cat::SEC_GUN, 4, json!({ "firepower": 7 }), 10);
        close(g.imp.p_shell, 3.0, 1e-9);
        close(g.imp.p_nb, 3.0, 1e-9);
    }
    // Secondary accuracy √★ for all.
    close(eq(12, cat::SEC_GUN, 4, json!({ "firepower": 7 }), 4).imp.acc_shell, 2.0, 1e-9);
}

#[test]
fn torpedoes_midget_and_sub_torpedoes() {
    // Example 3: 61cm quad (oxygen) ★6 + ★3 = 1.2(√6 + √3) = 5.017 torpedo; night √★, shelling 0.
    let a = eq(15, cat::TORPEDO, 5, json!({ "torpedo": 10 }), 6);
    let b = eq(15, cat::TORPEDO, 5, json!({ "torpedo": 10 }), 3);
    close(a.imp.p_torp + b.imp.p_torp, 5.017, 0.001);
    close(a.imp.p_nb, 6f64.sqrt(), 1e-9);
    close(a.imp.p_shell, 0.0, 0.0);
    close(a.imp.acc_shell, 0.0, 0.0);
    assert!(a.imp.acc_torp > 0.0);
    // Midget sub: night √★ only.
    let m = eq(41, cat::MIDGET_SUB, 5, json!({ "torpedo": 12 }), 4);
    close(m.imp.p_nb, 2.0, 1e-9);
    close(m.imp.p_shell + m.imp.p_torp, 0.0, 0.0);
    // Sub torpedo: torpedo / night 0.2★, shelling √★.
    let s = eq(213, cat::SUB_TORPEDO, 5, json!({ "torpedo": 15 }), 10);
    close(s.imp.p_torp, 2.0, 1e-9);
    close(s.imp.p_nb, 2.0, 1e-9);
    close(s.imp.p_shell, 10f64.sqrt(), 1e-9);
}

#[test]
fn aa_guns_ha_guns_aafd_radars() {
    // AA gun: shelling √★, torpedo 1.2√★, no night / shelling accuracy.
    let g = eq(131, cat::AA_GUN, 15, json!({ "antiAir": 9 }), 9);
    close(g.imp.p_shell, 3.0, 1e-9);
    close(g.imp.p_torp, 3.60, T);
    close(g.imp.p_nb + g.imp.acc_shell + g.imp.aa_fleet, 0.0, 0.0);
    // Weighted AA 6√★ (AA ≥ 8) / 4√★ (AA ≤ 7): ★9 → 18 / 12, halved 9 / 6.
    close(g.imp.aa_self, 9.0, 1e-9);
    close(eq(40, cat::AA_GUN, 15, json!({ "antiAir": 6 }), 9).imp.aa_self, 6.0, 1e-9);
    // HA gun AA ≤ 7: weighted 2√★ (halved 1), fleet 2√★; ★9 fleet 6.00.
    let h = eq(3, cat::MAIN_GUN_S, 16, json!({ "firepower": 2, "antiAir": 7 }), 9);
    close(h.imp.aa_self, 3.0, 1e-9);
    close(h.imp.aa_fleet, 6.00, T);
    // HA gun AA ≥ 8: weighted 3√★ (halved 1.5), fleet 3√★; ★9 fleet 9.00, max 9.49.
    let h = eq(122, cat::MAIN_GUN_S, 16, json!({ "firepower": 2, "antiAir": 10 }), 10);
    close(h.imp.aa_fleet, 9.49, T);
    close(h.imp.aa_self, 1.5 * 10f64.sqrt(), 1e-9);
    // AAFD: weighted 2√★ (halved 1), fleet 2√★ (★4 4.00), shelling / night / accuracy √★.
    let d = eq(120, cat::AAFD, 30, json!({ "antiAir": 2 }), 4);
    close(d.imp.aa_self, 2.0, 1e-9);
    close(d.imp.aa_fleet, 4.00, T);
    close(d.imp.p_shell, 2.0, 1e-9);
    close(d.imp.p_nb, 2.0, 1e-9);
    close(d.imp.acc_shell, 2.0, 1e-9);
    // Air radar (AA ≥ 2): fleet 1.5√★ (★9 4.50); accuracy √★ when ACC ≤ 2; no power.
    let r = eq(27, cat::RADAR_S, 11, json!({ "antiAir": 4, "los": 2, "accuracy": 2 }), 9);
    close(r.imp.aa_fleet, 4.50, T);
    close(r.imp.acc_shell, 3.0, 1e-9);
    close(r.imp.p_shell + r.imp.p_nb + r.imp.aa_self, 0.0, 0.0);
    // Surface radar ACC ≥ 3: 1.7√★ (★9 5.10; max 5.376, the wiki table truncates to 5.37).
    close(eq(28, cat::RADAR_S, 11, json!({ "los": 5, "accuracy": 3 }), 9).imp.acc_shell, 5.10, T);
    close(eq(142, cat::RADAR_L, 11, json!({ "los": 7, "accuracy": 8 }), 10).imp.acc_shell, 5.376, 0.001);
}

#[test]
fn asw_equipment() {
    // Sonar: shelling 0.75√★ (★9 2.25), ASW √★ added outside the ×1.5 (≙ 2/3√★ of equipment ASW).
    let s = eq(46, cat::SONAR_S, 18, json!({ "asw": 10 }), 9);
    close(s.imp.p_shell, 2.25, T);
    close(s.imp.p_asw, 3.0, 1e-9);
    assert!(s.imp.ev_torp > 0.0 && s.imp.acc_asw > 0.0);
    close(eq(132, cat::SONAR_L, 18, json!({ "asw": 15 }), 4).imp.p_shell, 1.50, T);
    // Depth-charge projector: shelling 0.75√★, ASW √★, no torpedo evasion.
    let p = eq(44, cat::DEPTH_CHARGE, 17, json!({ "asw": 5 }), 4);
    close(p.imp.p_shell, 1.50, T);
    close(p.imp.p_asw, 2.0, 1e-9);
    close(p.imp.ev_torp, 0.0, 0.0);
    // Additional depth charges (Type 95 / Type 2): no shelling power.
    for id in [226, 227] {
        let c = eq(id, cat::DEPTH_CHARGE, 17, json!({ "asw": 4 }), 9);
        close(c.imp.p_shell, 0.0, 0.0);
        close(c.imp.p_asw, 3.0, 1e-9);
    }
    // Autogyro ASW ≤ 10: 0.2★, > 10: 0.3★; Type 3 liaison (ASW) 0.2★, Kai (ASW 8) 0.3★.
    close(eq(69, cat::AUTOGYRO, 21, json!({ "asw": 10 }), 10).imp.p_asw, 2.0, 1e-9);
    close(eq(326, cat::AUTOGYRO, 21, json!({ "asw": 11 }), 5).imp.p_asw, 1.5, 1e-9);
    close(eq(70, cat::ASW_PLANE, 22, json!({ "asw": 7 }), 10).imp.p_asw, 2.0, 1e-9);
    close(eq(451, cat::ASW_PLANE, 22, json!({ "asw": 8 }), 10).imp.p_asw, 3.0, 1e-9);
}

#[test]
fn misc_sqrt_categories() {
    // √★ shelling / night / accuracy (wiki ×1.0 table: ★4 2.00, max 3.16).
    for (id, c) in [
        (35, cat::TYPE3_SHELL),
        (36, cat::AP_SHELL),
        (74, cat::SEARCHLIGHT),
        (140, cat::SEARCHLIGHT_L),
        (68, cat::LANDING_CRAFT),
        (167, cat::LANDING_TANK),
        (126, cat::WG42),
        (412, cat::LOOKOUT),
        (107, cat::FCF),
        (500, cat::SMOKE),
    ] {
        let e = eq(id, c, 0, json!({ "firepower": 1 }), 10);
        close(e.imp.p_shell, 3.16, T);
        close(e.imp.p_nb, 3.16, T);
        close(e.imp.acc_shell, 3.16, T);
    }
}

#[test]
fn engine_and_bulges() {
    // Engine: shelling evasion 1.5√★ (★4 3.00); bulge M 0.2★, L 0.3★ armor.
    let en = eq(87, cat::ENGINE, 19, json!({ "evasion": 10 }), 4);
    close(en.imp.ev_shell, 3.00, T);
    close(en.imp.p_shell, 0.0, 0.0);
    close(eq(72, cat::BULGE_M, 23, json!({ "armor": 7 }), 10).imp.armor, 2.0, 1e-9);
    close(eq(73, cat::BULGE_L, 23, json!({ "armor": 9 }), 10).imp.armor, 3.0, 1e-9);
}

#[test]
fn carrier_and_land_based_planes() {
    // Fighters / seaplane fighters / interceptors: AA +0.2★ (★5 +1, max +2).
    close(eq(21, cat::FIGHTER, 6, json!({ "antiAir": 5 }), 10).aa_improve, 2.0, 1e-9);
    close(eq(164, cat::SEAPLANE_FIGHTER, 43, json!({ "antiAir": 2 }), 5).aa_improve, 1.0, 1e-9);
    close(eq(225, cat::INTERCEPTOR, 44, json!({ "antiAir": 8 }), 10).aa_improve, 2.0, 1e-9);
    // Fighter-bombers: AA 0.25★ (★4 +1), no shelling / airstrike power; 64型 (486/487) 0.3★.
    let fb = eq(60, cat::DIVE_BOMBER, 7, json!({ "antiAir": 4, "bombing": 4 }), 4);
    close(fb.aa_improve, 1.0, 1e-9);
    close(fb.imp.p_shell + fb.air_power_improve, 0.0, 0.0);
    close(eq(486, cat::FIGHTER, 6, json!({ "antiAir": 7 }), 10).aa_improve, 3.0, 1e-9);
    close(eq(487, cat::DIVE_BOMBER, 7, json!({ "antiAir": 6 }), 10).aa_improve, 3.0, 1e-9);
    // Dive / torpedo bombers: shelling 0.2★, ASW 0.2★, airstrike 0.2★, no fighter power.
    for (id, c) in [(24, cat::DIVE_BOMBER), (16, cat::TORP_BOMBER)] {
        let b = eq(id, c, 0, json!({ "bombing": 8, "torpedo": 7 }), 10);
        close(b.imp.p_shell, 2.0, 1e-9);
        close(b.imp.p_asw, 2.0, 1e-9);
        close(b.air_power_improve, 2.0, 1e-9);
        close(b.aa_improve, 0.0, 0.0);
    }
    // Seaplane bomber: airstrike 0.2★.
    close(eq(26, cat::SEAPLANE_BOMBER, 10, json!({ "bombing": 4 }), 10).air_power_improve, 2.0, 1e-9);
    // Land-based attackers: AA 0.5√★ (★4 +1, ★9 +1.5), torpedo 0.7√★ (above 1 from ★3, ★9 = 2.1).
    for c in [cat::LAND_BOMBER, cat::LAND_BOMBER_L] {
        let l = eq(168, c, 37, json!({ "torpedo": 10, "antiAir": 1 }), 9);
        close(l.aa_improve, 1.5, 1e-9);
        close(l.air_power_improve, 2.1, 1e-9);
    }
    let l = eq(168, cat::LAND_BOMBER, 37, json!({ "torpedo": 10 }), 3);
    assert!(l.air_power_improve > 1.0 && eq(168, cat::LAND_BOMBER, 37, json!({}), 2).air_power_improve < 1.0);
}

#[test]
fn unimproved_is_zero() {
    let g = eq(7, cat::MAIN_GUN_L, 3, json!({ "firepower": 15 }), 0);
    assert_eq!(g.imp, Default::default());
    assert_eq!(g.aa_improve + g.air_power_improve, 0.0);
}
