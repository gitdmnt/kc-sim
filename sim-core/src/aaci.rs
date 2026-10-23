//! Anti-air cut-in (対空カットイン) kinds. Ported from KC3Kai/kancolle-replay `js/kcsim.js`
//! (`AACIDATA`, priority order `orderKnown`, `aaciRatesNew`) and `js/kcships.js`
//! (`Ship.getAACItype`), MIT © fourinone41.

use crate::equipment::{cat, f, Equip};
use crate::ship::ShipClass;

/// AACI kinds in roll priority order (kcsim `orderKnown`): (kind, fixed shoot-down `num` (friend
/// total = 1 + this), flat multiplier, trigger rate, `num1` (part of `num` kept against
/// AA-resistant planes)). Rates of kinds 1–13 are the en.kancollewiki "Aerial Combat" table (May 2025
/// update); the others are kcsim's (`AACIDATA`, kinds 34–38 with `aaciRatesNew`).
pub const AACI_TABLE: [(u8, i32, f64, f64, i32); 53] = [
    (38, 10, 1.85, 0.58, 5),
    (39, 10, 1.7, 0.57, 5),
    (40, 10, 1.7, 0.56, 5),
    (42, 10, 1.65, 0.65, 1),
    (41, 9, 1.65, 0.55, 5),
    (10, 8, 1.65, 0.594, 3),
    (43, 8, 1.6, 0.58, 1),
    (46, 8, 1.55, 0.6, 1),
    (11, 6, 1.5, 0.544, 2),
    (25, 7, 1.55, 0.6, 1),
    (48, 8, 1.75, 0.65, 1),
    (1, 7, 1.7, 0.643, 3),
    (34, 7, 1.6, 0.55, 1),
    (44, 6, 1.6, 0.55, 1),
    (26, 6, 1.4, 0.6, 1),
    (4, 6, 1.5, 0.514, 5),
    (2, 6, 1.7, 0.574, 3),
    (35, 6, 1.55, 0.54, 1),
    (36, 6, 1.55, 0.53, 1),
    (27, 6, 1.55, 0.55, 1),
    (45, 6, 1.55, 0.5, 1),
    (50, 7, 1.5, 0.5, 1),
    (49, 6, 1.5, 0.5, 1),
    (51, 5, 1.4, 0.5, 1),
    (52, 5, 1.4, 0.5, 1),
    (19, 5, 1.45, 0.55, 1),
    (21, 5, 1.45, 0.6, 1),
    (29, 5, 1.55, 0.6, 1),
    (53, 4, 1.6, 0.6, 1),
    (16, 4, 1.4, 0.62, 1),
    (14, 4, 1.45, 0.63, 1),
    (3, 4, 1.6, 0.495, 2),
    (5, 4, 1.5, 0.544, 2),
    (6, 4, 1.45, 0.396, 4),
    (28, 4, 1.4, 0.55, 1),
    (37, 4, 1.45, 0.44, 1),
    (33, 3, 1.35, 0.42, 1),
    (30, 3, 1.3, 0.45, 1),
    (8, 4, 1.4, 0.495, 2),
    (13, 4, 1.35, 0.346, 1),
    (15, 3, 1.3, 0.55, 1),
    (7, 3, 1.35, 0.445, 2),
    (20, 3, 1.25, 0.65, 1),
    (24, 3, 1.25, 0.55, 1),
    (32, 3, 1.2, 0.5, 1),
    (12, 3, 1.25, 0.445, 1),
    (31, 2, 1.25, 0.5, 1),
    (47, 2, 1.3, 0.7, 1),
    (17, 2, 1.25, 0.55, 1),
    (18, 2, 1.2, 0.6, 1),
    (22, 2, 1.2, 0.6, 1),
    (9, 2, 1.3, 0.396, 1),
    (23, 1, 1.05, 0.8, 1),
];

/// Priority index of an AACI kind in [`AACI_TABLE`].
pub fn priority(kind: u8) -> Option<usize> {
    AACI_TABLE.iter().position(|t| t.0 == kind)
}

/// Probability that at least one of `kinds` triggers (each kind is rolled independently).
pub fn aaci_trigger_rate(kinds: &[u8]) -> f64 {
    1.0 - kinds.iter().filter_map(|k| priority(*k)).map(|p| 1.0 - AACI_TABLE[p].3).product::<f64>()
}

/// Ship data `getAACItype` reads.
pub struct AaciShip<'a> {
    pub master_id: u32,
    pub ship_class: u32,
    pub class: ShipClass,
    /// Naked AA (stands in for kcSHIPDATA `AA` in the kind-47 check).
    pub naked_aa: f64,
    pub equips: &'a [&'a Equip],
}

/// kcships `Ship.getAACItype`, in kcsim's order.
pub fn aaci_kinds(s: &AaciShip) -> Vec<u8> {
    let eq = s.equips;
    let n = |fl: u64| eq.iter().filter(|e| e.has(fl)).count();
    let id = |x: u32| eq.iter().filter(|e| e.id == x).count();
    let ha = n(f::HA_GUN);
    let hafd = n(f::HAFD);
    let aafd = n(f::AAFD);
    let air_radar = n(f::AIR_RADAR);
    let aagun = n(f::AA_GUN);
    let t3 = n(f::TYPE3_SHELL);
    let radar = n(f::RADAR);
    let conc = n(f::CONCENTRATED);
    let radar4 = eq.iter().any(|e| e.has(f::RADAR) && e.aa >= 4.0);
    let mid = s.master_id;
    let sclass = s.ship_class;
    let akizuki = sclass == 54;
    let in_ = |l: &[u32]| l.contains(&mid);
    let mut t: Vec<u8> = Vec::new();

    if in_(&[330, 346, 357, 537, 538, 963, 968, 1040]) && id(533) >= 2 && radar4 {
        t.push(48);
    }
    if in_(&[745, 981, 982, 983, 986, 987, 1033, 1034, 1071, 426, 1035, 1040]) && hafd >= 2 && radar4 {
        t.push(49);
    }
    if akizuki || in_(&[745, 981, 982, 983, 986, 987, 1033, 1034, 426, 1035, 1040]) {
        let n10k = id(533) + id(553);
        let aafd121 = id(121) > 0;
        if (!akizuki || in_(&[330, 346, 357, 537, 538, 963, 968])) && n10k >= 2 && radar4 && aafd121 {
            t.push(50);
        }
        if !akizuki && n10k > 0 && radar4 && eq.iter().any(|e| e.has(f::AA_GUN) && e.aa >= 5.0) {
            t.push(51);
        }
        if id(553) >= 2 && aafd121 {
            t.push(52);
        }
    }
    if in_(&[1031, 1071]) && eq.iter().any(|e| e.has(f::HAFD) && e.aa >= 9.0) && radar4 {
        t.push(53);
    }
    if mid == 1035 {
        if ha > 0 && aagun > 0 {
            t.push(15);
        }
        if ha > 0 && aagun > 0 && air_radar > 0 {
            t.push(16);
        }
        if ha > 0 && air_radar > 0 {
            t.push(21);
        }
        if ha > 0 && aagun > conc {
            t.push(24);
        }
    }
    let mk30 = id(313) + id(284);
    if mid == 1040 {
        if hafd > 0 && radar > 0 {
            t.push(2);
        }
        if ha > 0 && air_radar > 0 {
            t.push(21);
        }
        if id(308) >= 2 {
            t.push(34);
        }
        if mk30 >= 1 && id(308) >= 1 {
            t.push(35);
        }
        if mk30 >= 2 && id(307) > 0 {
            t.push(36);
        }
    }
    if akizuki {
        if ha >= 2 && radar > 0 {
            t.push(1);
        }
        if hafd > 0 && radar > 0 {
            t.push(2);
        }
        if ha >= 2 {
            t.push(3);
        }
    }
    if in_(&[428, 1031, 1071]) && conc > 0 && ha > 0 {
        if air_radar > 0 {
            t.push(10);
        }
        if in_(&[428, 1031]) {
            t.push(11);
        }
    }
    if in_(&[141, 1071]) && ha > 0 && aagun > 0 {
        if air_radar > 0 {
            t.push(14);
        }
        if mid == 141 {
            t.push(15);
        }
    }
    if in_(&[470, 622]) && ha > 0 && aagun > 0 && air_radar > 0 {
        t.push(16);
    }
    if in_(&[470, 979]) && ha > 0 && aagun > 0 {
        t.push(17);
    }
    if mid == 487 && conc > 0 && ha > hafd {
        t.push(19);
    }
    if in_(&[488, 1071]) && ha > 0 && air_radar > 0 {
        t.push(21);
    }
    if in_(&[82, 88, 553, 554]) && id(274) > 0 && air_radar > 0 && t3 > 0 {
        t.push(25);
    }
    if sclass == 91 {
        if id(308) >= 2 {
            t.push(34);
        }
        if mk30 >= 1 && id(308) >= 1 {
            t.push(35);
        }
        if id(313) >= 2 {
            t.push(37);
        }
        if mk30 >= 2 && id(307) > 0 {
            t.push(36);
        }
    }
    if sclass == 99 {
        let (a, b) = (id(363), id(362));
        if a >= 2 {
            t.push(38);
        }
        if a > 0 && b > 0 {
            t.push(39);
        }
        if id(307) > 0 && a + b >= 2 {
            t.push(40);
        }
        if a + b >= 2 {
            t.push(41);
        }
    }
    let yamato_k2 = in_(&[546, 911, 916]);
    let duplex = id(142) + id(460);
    if yamato_k2 {
        let high = eq.iter().filter(|e| e.cat == cat::AA_GUN && e.aa >= 6.0).count();
        let sec_ha = id(464);
        if sec_ha >= 2 && duplex > 0 && high > 0 {
            t.push(42);
        }
        if sec_ha >= 2 && duplex > 0 {
            t.push(43);
        }
        if sec_ha > 0 && duplex > 0 && high > 0 {
            t.push(44);
        }
        if sec_ha > 0 && duplex > 0 {
            t.push(45);
        }
    }
    if mid == 593 && (id(502) + id(503)) > 0 && conc > 0 && air_radar > 0 {
        t.push(46);
    }
    if sclass == 23 && s.naked_aa >= 70.0 {
        let ck = id(529);
        if ck >= 2 || (ck > 0 && (id(505) > 0 || radar4)) {
            t.push(47);
        }
    }
    let large = n(f::LARGE_GUN);
    let add6 = s.class.is_bb_class() && large > 0 && t3 > 0 && aafd > 0;
    if add6 && air_radar > 0 {
        t.push(4);
    }
    if !akizuki && hafd >= 2 && air_radar > 0 {
        t.push(5);
    }
    if add6 {
        t.push(6);
    }
    if !akizuki && hafd > 0 && air_radar > 0 {
        t.push(8);
    }
    if !akizuki && ha > 0 && aafd > 0 && air_radar > 0 {
        t.push(7);
    }
    if (yamato_k2 || in_(&[136, 148])) && id(275) > 0 && air_radar > 0 {
        t.push(26);
    }
    if in_(&[321, 1031]) && (id(275) + id(71) + id(220)) > 0 && id(274) > 0 && air_radar > 0 {
        t.push(27);
    }
    if in_(&[82, 88, 553, 554, 148, 546]) && id(274) > 0 && air_radar > 0 {
        t.push(28);
    }
    if in_(&[557, 558]) && ha > 0 && air_radar > 0 {
        t.push(29);
    }
    if ha > 0 && aafd > 0 {
        t.push(9);
    }
    if in_(&[579, 630]) && ha > 0 && aagun > 0 {
        t.push(33);
    }
    if conc > 0 && aagun >= 2 && air_radar > 0 {
        t.push(12);
    }
    if !in_(&[428, 1031]) && conc > 0 && hafd > 0 && air_radar > 0 {
        t.push(13);
    }
    if in_(&[418, 979]) && conc > 0 {
        t.push(18);
    }
    if mid == 487 && conc > 0 {
        t.push(20);
    }
    if mid == 548 && conc > 0 {
        t.push(22);
    }
    if in_(&[539, 530]) && aagun > conc {
        t.push(23);
    }
    if in_(&[477, 579, 630]) && ha >= 3 {
        t.push(30);
    }
    if in_(&[477, 979]) && ha >= 2 {
        t.push(31);
    }
    if in_(&[478, 477]) && ha > 0 && aagun > conc {
        t.push(24);
    }
    let royal = [67, 78, 82, 88, 108, 112].contains(&sclass) || in_(&[149, 150, 151, 152, 591, 592, 593, 954, 694]);
    if royal && ((id(191) > 0 && id(300) > 0) || (id(301) > 0 && id(191) > 0) || id(301) >= 2) {
        t.push(32);
    }
    t
}
