//! Main-gun fit vs published values.
//! Sources: wikiwiki.jp/kancolle/命中と回避について §フィット補正 (BB / CL / DD / AV tables and
//! worked examples 1–4), kancolle-replay `Ship.prototype.getFit`.

use sim_core::fit::gun_fit;
use sim_core::ship::ShipClass::{self, *};

const MED: u32 = 2;
const BIG: u32 = 3;
const R2: f64 = std::f64::consts::SQRT_2;

fn acc(class: ShipClass, ctype: u32, id: u32, lv: f64, eq: &[(u32, u32)]) -> f64 {
    gun_fit(class, ctype, id, lv, eq).0
}

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} != {b}");
}

#[test]
fn kongou_46cm_wiki_examples() {
    // 例1: Kongou + 46cm×2 + 35.6cm: -10√2 + 4 + 3 = -7.142…
    let eq = [(9, BIG), (9, BIG), (7, BIG)];
    close(acc(FBB, 6, 149, 99.0, &eq), -10.0 * R2 + 7.0);
    // 例2: married: -6√2 + 7 = -1.485…
    close(acc(FBB, 6, 149, 120.0, &eq), -6.0 * R2 + 7.0);
    // 46cm + 46cm改 on a 巡洋戦艦 are one category: -10√2.
    close(acc(FBB, 6, 149, 99.0, &[(9, BIG), (276, BIG)]), -10.0 * R2);
}

#[test]
fn washington_same_category_counts_together() {
    // 例3: 38cm連装砲 + 38cm連装砲改 on Washington (FBB): +4√2.
    close(acc(FBB, 95, 549, 99.0, &[(76, BIG), (114, BIG)]), 4.0 * R2);
}

#[test]
fn yamato_k2_juu_bbv() {
    // 例4: Yamato K2重 + 46cm改 + 46cm: -8√2 + 7 + 3 = -1.313…
    close(acc(BBV, 37, 916, 99.0, &[(276, BIG), (9, BIG)]), -8.0 * R2 + 10.0);
}

#[test]
fn nagato_41cm_and_51cm() {
    // Nagato K2: base +2, individual +4 (41cm連装砲) → +6 for one 41cm twin.
    close(acc(BB, 19, 541, 99.0, &[(8, BIG)]), 6.0);
    // Nagato K2 + 41cm三連装砲改二 (290): +2 + 3 = +5 (wiki 1-gun value).
    close(acc(BB, 19, 541, 99.0, &[(290, BIG)]), 5.0);
    // Nagato (non-K2) with 41cm×2: (2+2)√2; 51cm: -5 individual, 0 base.
    close(acc(BB, 19, 80, 99.0, &[(8, BIG), (8, BIG)]), 4.0 * R2);
    close(acc(BB, 19, 80, 99.0, &[(128, BIG)]), -5.0);
    // Other 戦艦A群 (Fusou): 51cm base 0, 46cm改 -7.
    close(acc(BB, 26, 411, 99.0, &[(128, BIG)]), 0.0);
    close(acc(BB, 26, 411, 99.0, &[(276, BIG)]), -7.0);
}

#[test]
fn yamato_bb_and_heavy_bb_exempt() {
    close(acc(BB, 37, 136, 99.0, &[(9, BIG)]), 3.0);
    close(acc(BB, 37, 136, 99.0, &[(276, BIG)]), 7.0);
}

#[test]
fn iowa_16inch_mk7() {
    // Base -5, Iowa individual +7 (Mk.7) / +14 (Mk.7+GFCS).
    close(acc(FBB, 65, 440, 99.0, &[(161, BIG)]), 2.0);
    close(acc(FBB, 65, 440, 99.0, &[(183, BIG)]), 9.0);
    // Kongou K2 with Mk.7+GFCS ×2: -5√2 (unmarried), -3√2 married.
    close(acc(FBB, 6, 149, 99.0, &[(183, BIG), (183, BIG)]), -5.0 * R2);
    close(acc(FBB, 6, 149, 100.0, &[(183, BIG), (183, BIG)]), -3.0 * R2);
}

#[test]
fn light_cruiser_table() {
    // Standard CL (Yuubari, ctype 34) with 15.2cm twin ×2: acc 0 (married +2), fp +2√2.
    let eq = [(65, MED), (65, MED)];
    let (a, fp) = gun_fit(CL, 34, 622, 99.0, &eq);
    close(a, 0.0);
    close(fp, 2.0 * R2);
    close(acc(CL, 34, 622, 100.0, &eq), 2.0);
    // 20.3cm: -3 for one, -6 for two; married ×0.6.
    close(acc(CL, 34, 622, 99.0, &[(50, MED)]), -3.0);
    close(acc(CL, 34, 622, 99.0, &[(50, MED), (6, MED)]), -6.0);
    close(acc(CL, 34, 622, 100.0, &[(50, MED), (6, MED)]), -3.6);
    // 8inch ×2: -22, married ×0.8.
    close(acc(CL, 34, 622, 99.0, &[(356, MED), (357, MED)]), -22.0);
    close(acc(CL, 34, 622, 100.0, &[(356, MED), (357, MED)]), -17.6);
    // Foreign 15.2cm triple ×2: -6.
    close(acc(CL, 34, 622, 99.0, &[(386, MED), (387, MED)]), -6.0);
}

#[test]
fn agano_ooyodo_atlanta() {
    close(acc(CL, 41, 662, 99.0, &[(65, MED)]), 5.0);
    close(acc(CL, 41, 662, 99.0, &[(65, MED), (139, MED)]), 6.0);
    close(acc(CL, 41, 662, 100.0, &[(65, MED), (139, MED)]), 8.0);
    close(acc(CL, 41, 662, 99.0, &[(50, MED), (50, MED)]), -8.0);
    close(acc(CL, 41, 662, 100.0, &[(50, MED), (50, MED)]), -6.0);
    close(acc(CL, 52, 321, 99.0, &[(5, MED), (235, MED)]), -2.0);
    close(acc(CL, 52, 321, 99.0, &[(50, MED), (50, MED)]), -10.0);
    close(acc(CL, 99, 597, 99.0, &[(362, MED), (363, MED)]), 0.0);
    close(acc(CL, 99, 597, 100.0, &[(362, MED), (363, MED)]), 3.0);
}

#[test]
fn destroyers_and_tenders() {
    close(acc(DD, 81, 516, 99.0, &[(282, 1)]), 5.0);
    close(acc(DD, 82, 520, 99.0, &[(280, 1), (261, 14)]), 6.0);
    close(acc(DD, 28, 1, 99.0, &[(293, 1)]), 5.0);
    close(acc(DD, 23, 145, 99.0, &[(63, 1)]), 0.0);
    // AV: 15.2cm ×1 → -6; 20.3cm ×1 → -18; mixed 14cm + 20.3cm → -16.
    close(acc(AV, 0, 0, 99.0, &[(65, MED)]), -6.0);
    close(acc(AV, 0, 0, 99.0, &[(50, MED)]), -18.0);
    close(acc(AV, 0, 0, 99.0, &[(4, MED), (50, MED)]), -16.0);
}

#[test]
fn heavy_cruiser_has_no_day_gun_fit() {
    // 20.3cm(3号) day fit for CA is 0; its night bonus is applied in the night hit formula.
    assert_eq!(gun_fit(CA, 7, 69, 99.0, &[(50, MED), (50, MED)]), (0.0, 0.0));
}
