//! Fleet special attacks, Zuiun / jet cut-ins, night Zuiun, Ark Royal, AACI, rocket barrage.
mod common;

use common::*;
use sim_core::model::*;
use sim_core::sim::run_battle;

fn with_id(mut s: ShipInput, id: u32, class: u32) -> ShipInput {
    s.id = Some(id);
    s.ship_class = Some(class);
    s
}

fn lv_luck(mut s: ShipInput, level: f64, luck: f64) -> ShipInput {
    s.level = Some(level);
    s.stats.luck = Some(luck);
    s
}

/// Enemy that survives a whole battle and never hurts anyone (no firepower, huge HP).
fn dummy_enemy(n: usize) -> FleetInput {
    let s = ship(9, 1.0, 9999, 0.0, 0.0, 0.0, 300.0, 1.0, 0.0, 0.0, vec![]);
    FleetInput { ships: vec![s; n], formation: Some(Formation::LineAhead), ..Default::default() }
}

fn bb(id: u32, class: u32) -> ShipInput {
    with_id(friend_bb(), id, class)
}

fn logged(friend: FleetInput, enemy: FleetInput, kind: BattleKind) -> BattleInput {
    let mut b = battle(friend, enemy, kind);
    b.options.log = true;
    b
}

fn always(b: &mut BattleInput) {
    b.options.special_attack_rates = Some(SpecialAttackRates {
        nelson_touch: Some(100.0),
        nagato: Some(100.0),
        mutsu: Some(100.0),
        colorado: Some(100.0),
        kongou: Some(100.0),
        richelieu: Some(100.0),
        queen_elizabeth: Some(100.0),
        yamato3: Some(100.0),
        yamato2: Some(100.0),
        sub_fleet: Some(100.0),
        sub_fleet_second: Some(0.0),
    });
}

/// Attackers of the given special attack in one battle.
fn attackers(r: &BattleResult, kind: SpecialAttack) -> Vec<usize> {
    r.events.as_ref().unwrap().iter().filter(|e| e.special == kind && e.attacker_side == Side::Friend).map(|e| e.attacker).collect()
}

fn surface_six(lead: Vec<ShipInput>, form: Formation) -> FleetInput {
    let mut ships = lead;
    while ships.len() < 6 {
        ships.push(friend_ca());
    }
    FleetInput { ships, formation: Some(form), ..Default::default() }
}

#[test]
fn nelson_touch_attackers_and_once_per_battle() {
    let fleet = surface_six(vec![bb(571, 88), friend_ca(), bb(572, 88), friend_ca(), friend_bb()], Formation::DoubleLine);
    let mut b = logged(fleet, dummy_enemy(6), BattleKind::Day);
    always(&mut b);
    let out = run_battle(&b, 1).unwrap();
    assert_eq!(attackers(&out.result, SpecialAttack::NelsonTouch), vec![0, 2, 4]);
    assert_eq!(out.state.friend.special_attack_used, Some(true));
    // Carried over: the next node gets none.
    let mut next = logged(out.state.friend.clone(), dummy_enemy(6), BattleKind::Day);
    always(&mut next);
    assert!(attackers(&run_battle(&next, 2).unwrap().result, SpecialAttack::NelsonTouch).is_empty());
    // Wrong formation: none.
    let mut f = b.friend.clone();
    f.formation = Some(Formation::LineAhead);
    let mut lb = logged(f, dummy_enemy(6), BattleKind::Day);
    always(&mut lb);
    assert!(attackers(&run_battle(&lb, 1).unwrap().result, SpecialAttack::NelsonTouch).is_empty());
}

#[test]
fn nagato_needs_battleship_partner_and_healthy_flagship() {
    let fleet = surface_six(vec![bb(541, 19), bb(573, 19)], Formation::Echelon);
    let mut b = logged(fleet.clone(), dummy_enemy(6), BattleKind::Day);
    always(&mut b);
    assert_eq!(attackers(&run_battle(&b, 3).unwrap().result, SpecialAttack::NagatoCutin), vec![0, 0, 1]);
    // Chuuha flagship (≤ 50% HP): none.
    let mut hurt = fleet.clone();
    hurt.ships[0].hp = Some(40);
    let mut b = logged(hurt, dummy_enemy(6), BattleKind::Day);
    always(&mut b);
    assert!(attackers(&run_battle(&b, 3).unwrap().result, SpecialAttack::NagatoCutin).is_empty());
    // Cruiser as the 2nd ship: none.
    let mut no_bb = fleet;
    no_bb.ships[1] = friend_ca();
    let mut b = logged(no_bb, dummy_enemy(6), BattleKind::Day);
    always(&mut b);
    assert!(attackers(&run_battle(&b, 3).unwrap().result, SpecialAttack::NagatoCutin).is_empty());
}

#[test]
fn colorado_yamato_richelieu_qe_and_sub_fleet_attackers() {
    let cases: [(Vec<ShipInput>, Formation, SpecialAttack, Vec<usize>); 6] = [
        (vec![bb(601, 93), bb(913, 93), friend_bb()], Formation::Echelon, SpecialAttack::ColoradoCutin, vec![0, 1, 2]),
        (vec![bb(911, 37), bb(546, 37)], Formation::Echelon, SpecialAttack::YamatoCutin2, vec![0, 0, 1]),
        (vec![bb(911, 37), bb(541, 19), bb(573, 19)], Formation::Echelon, SpecialAttack::YamatoCutin3, vec![0, 1, 2]),
        (vec![bb(392, 79), bb(724, 79)], Formation::DoubleLine, SpecialAttack::RichelieuCutin, vec![0, 0, 1]),
        (vec![bb(364, 67), bb(733, 67)], Formation::Echelon, SpecialAttack::QueenElizabethCutin, vec![0, 0, 1]),
        (vec![bb(916, 37), bb(178, 37)], Formation::Echelon, SpecialAttack::YamatoCutin2, vec![0, 0, 1]),
    ];
    for (lead, form, kind, expect) in cases {
        let mut b = logged(surface_six(lead, form), dummy_enemy(6), BattleKind::Day);
        always(&mut b);
        assert_eq!(attackers(&run_battle(&b, 5).unwrap().result, kind), expect, "{kind:?}");
    }
    // Submarine fleet attack: submarine tender flagship (Lv ≥ 30), submarines 2nd/3rd, echelon.
    let tender = with_id(ship(20, 50.0, 40, 10.0, 0.0, 10.0, 20.0, 30.0, 0.0, 10.0, vec![]), 184, 59);
    let sub = || ship(13, 99.0, 20, 0.0, 80.0, 0.0, 10.0, 50.0, 0.0, 30.0, vec![torp_61_oxy()]);
    let fleet = FleetInput { ships: vec![tender, sub(), sub()], formation: Some(Formation::Echelon), ..Default::default() };
    let mut b = logged(fleet, dummy_enemy(3), BattleKind::Day);
    always(&mut b);
    // Level 99 submarines without a submarine radar: second attacks at 0% here.
    assert_eq!(attackers(&run_battle(&b, 7).unwrap().result, SpecialAttack::SubFleetAttack), vec![1, 2]);
}

#[test]
fn combined_fleet_special_attacks_by_formation() {
    let escort = vec![friend_cl(), friend_dd(), friend_dd(), friend_dd(), friend_dd(), friend_dd()];
    let main = |lead: Vec<ShipInput>| surface_six(lead, Formation::CombinedForward).ships;
    let fleet = |ships: Vec<ShipInput>, form: Formation| FleetInput {
        ships,
        formation: Some(form),
        escort: Some(escort.clone()),
        combined: Some(CombinedType::Surface),
        ..Default::default()
    };
    let run = |f: FleetInput, kind: SpecialAttack| {
        let mut b = logged(f, dummy_enemy(6), BattleKind::Day);
        always(&mut b);
        attackers(&run_battle(&b, 9).unwrap().result, kind)
    };
    let nagato = main(vec![bb(541, 19), bb(573, 19)]);
    assert_eq!(run(fleet(nagato.clone(), Formation::CombinedForward), SpecialAttack::NagatoCutin), vec![0, 0, 1]);
    assert!(run(fleet(nagato, Formation::CombinedBattle), SpecialAttack::NagatoCutin).is_empty());
    let yamato = main(vec![bb(911, 37), bb(546, 37)]);
    assert_eq!(run(fleet(yamato.clone(), Formation::CombinedBattle), SpecialAttack::YamatoCutin2), vec![0, 0, 1]);
    assert!(run(fleet(yamato, Formation::CombinedForward), SpecialAttack::YamatoCutin2).is_empty());
}

fn kongou_fleet(form: Formation) -> FleetInput {
    let lead = vec![lv_luck(bb(591, 6), 99.0, 18.0), lv_luck(bb(593, 6), 99.0, 48.0)];
    let mut f = surface_six(lead, form);
    f.ships.truncate(5);
    f
}

#[test]
fn kongou_night_attack_three_per_sortie() {
    let mut b = logged(kongou_fleet(Formation::LineAhead), dummy_enemy(6), BattleKind::NightOnly);
    always(&mut b);
    let out = run_battle(&b, 11).unwrap();
    assert_eq!(attackers(&out.result, SpecialAttack::KongouCutin), vec![0, 1]);
    assert_eq!(out.state.friend.kongou_special_count, Some(1));
    assert_eq!(out.state.friend.special_attack_used, None, "counted apart from the other special attacks");
    let mut spent = b.friend.clone();
    spent.kongou_special_count = Some(3);
    let mut b2 = logged(spent, dummy_enemy(6), BattleKind::NightOnly);
    always(&mut b2);
    assert!(attackers(&run_battle(&b2, 11).unwrap().result, SpecialAttack::KongouCutin).is_empty());
    // Day battles never trigger it.
    let mut day = logged(kongou_fleet(Formation::LineAhead), dummy_enemy(6), BattleKind::Day);
    always(&mut day);
    assert!(attackers(&run_battle(&day, 11).unwrap().result, SpecialAttack::KongouCutin).is_empty());
}

/// Share of battles in which `kind` fires on the flagship's first chance.
fn trigger_share(input: &BattleInput, kind: SpecialAttack, phase: Phase, n: u64) -> f64 {
    let hits = (0..n)
        .filter(|&seed| {
            let r = run_battle(input, seed).unwrap().result;
            r.events.unwrap().iter().any(|e| e.special == kind && e.phase == phase)
        })
        .count();
    hits as f64 / n as f64
}

#[test]
fn default_trigger_rates_follow_the_wiki_formulas() {
    // wikiwiki 長門改二: ⌊√99 + √99 + 1.2(√40 + √16) + 30⌋ = 62% (page example: 62.2%).
    let fleet = surface_six(vec![lv_luck(bb(541, 19), 99.0, 40.0), lv_luck(bb(573, 19), 99.0, 16.0)], Formation::Echelon);
    let p = trigger_share(&logged(fleet, dummy_enemy(6), BattleKind::Day), SpecialAttack::NagatoCutin, Phase::Shelling1, 3000);
    assert!((p - 0.62).abs() < 0.03, "nagato {p}");
    // wikiwiki 金剛改二丙: Kongou Lv99 luck 18 + Haruna Kai Ni B Lv99 luck 48, no radar → 48%.
    let p = trigger_share(&logged(kongou_fleet(Formation::LineAhead), dummy_enemy(6), BattleKind::NightOnly), SpecialAttack::KongouCutin, Phase::Night, 3000);
    assert!((p - 0.48).abs() < 0.03, "kongou {p}");
}

#[test]
fn ise_zuiun_and_jet_carrier_cut_ins() {
    let zuiun = || plane(26, 11, 10, EquipmentStats { bombing: Some(4.0), anti_air: Some(2.0), los: Some(6.0), ..Default::default() }, 22, 7);
    let mut ise = with_id(ship(10, 99.0, 77, 80.0, 0.0, 60.0, 80.0, 40.0, 0.0, 40.0, vec![gun_41cm(), gun_41cm(), zuiun(), zuiun()]), 553, 2);
    ise.range = Some(3.0);
    let jet = |id: u32, cat: u32, planes: i32| plane(id, cat, 40, EquipmentStats { bombing: Some(13.0), anti_air: Some(6.0), ..Default::default() }, planes, 7);
    let cv = with_id(ship(11, 99.0, 80, 50.0, 0.0, 70.0, 70.0, 45.0, 0.0, 30.0, vec![jet(199, 57, 30), jet(200, 57, 30), jet(250, 56, 20)]), 0, 0);
    let fleet = FleetInput { ships: vec![ise, cv, friend_dd(), friend_dd()], formation: Some(Formation::LineAhead), ..Default::default() };
    let input = logged(fleet, dummy_enemy(6), BattleKind::Day);
    let (mut zuiun_ci, mut jet_ci) = (0, 0);
    for seed in 0..200 {
        let r = run_battle(&input, seed).unwrap().result;
        for e in r.events.unwrap() {
            zuiun_ci += (e.special == SpecialAttack::ZuiunCutin) as u32;
            jet_ci += matches!(e.special, SpecialAttack::CvciJfJbJb | SpecialAttack::CvciJfJb) as u32;
        }
    }
    assert!(zuiun_ci > 0 && jet_ci > 0, "zuiun {zuiun_ci} jet {jet_ci}");
}

#[test]
fn night_zuiun_cut_in_and_ark_royal_swordfish() {
    let night_zuiun = || plane(490, 11, 10, EquipmentStats { firepower: Some(3.0), bombing: Some(11.0), ..Default::default() }, 4, 0);
    let cav = ship(6, 99.0, 70, 70.0, 20.0, 60.0, 70.0, 50.0, 0.0, 40.0, vec![gun_203(), gun_203(), night_zuiun(), night_zuiun(), radar_22()]);
    let swordfish = plane(242, 8, 8, EquipmentStats { firepower: Some(2.0), torpedo: Some(3.0), ..Default::default() }, 24, 0);
    let ark = with_id(ship(11, 99.0, 80, 50.0, 0.0, 60.0, 60.0, 40.0, 0.0, 20.0, vec![swordfish]), 393, 78);
    let fleet = FleetInput { ships: vec![cav, ark], formation: Some(Formation::LineAhead), ..Default::default() };
    let input = logged(fleet, dummy_enemy(6), BattleKind::NightOnly);
    let (mut nz, mut ark_attacks) = (0, 0);
    for seed in 0..300 {
        for e in run_battle(&input, seed).unwrap().result.events.unwrap() {
            nz += (e.special == SpecialAttack::NightZuiunZzr && e.attacker == 0) as u32;
            ark_attacks += (e.attacker_side == Side::Friend && e.attacker == 1) as u32;
        }
    }
    assert!(nz > 0, "night Zuiun cut-ins");
    assert_eq!(ark_attacks, 300, "Ark Royal attacks every night battle with a Swordfish");
}

#[test]
fn aaci_kinds_of_ship_specific_setups() {
    use sim_core::ship::ShipCore;
    let kinds = |s: &ShipInput| ShipCore::new(s, true).aaci;
    let ha = |id: u32, aa: f64| eq(id, 21, 16, EquipmentStats { anti_air: Some(aa), ..Default::default() });
    let aa_gun = |id: u32, aa: f64| eq(id, 21, 15, EquipmentStats { anti_air: Some(aa), ..Default::default() });
    let air_radar = || eq(27, 12, 11, EquipmentStats { anti_air: Some(4.0), los: Some(4.0), ..Default::default() });
    // Maya Kai Ni: HA gun + concentrated AA gun + air radar → 10, 11 (then generic 12, 13 is excluded).
    let maya = with_id(ship(5, 99.0, 70, 60.0, 0.0, 90.0, 60.0, 50.0, 0.0, 20.0, vec![eq(122, 4, 16, EquipmentStats { anti_air: Some(10.0), ..Default::default() }), aa_gun(131, 9.0), air_radar()]), 428, 7);
    let k = kinds(&maya);
    assert_eq!(&k[..2], &[10, 11]);
    assert!(!k.contains(&13));
    // Atlanta class: two GFCS Mk.37 + 5inch twin (id 363) → 38 first.
    let atlanta = with_id(ship(3, 99.0, 50, 40.0, 30.0, 90.0, 40.0, 60.0, 0.0, 20.0, vec![ha(363, 11.0), ha(363, 11.0)]), 597, 99);
    assert_eq!(kinds(&atlanta)[0], 38);
    // Isuzu Kai Ni: HA gun + AA gun (+ air radar) → 14, 15.
    let isuzu = with_id(ship(3, 99.0, 45, 30.0, 40.0, 80.0, 40.0, 60.0, 0.0, 20.0, vec![ha(3, 4.0), aa_gun(40, 6.0), air_radar()]), 141, 20);
    assert_eq!(&kinds(&isuzu)[..2], &[14, 15]);
    // Musashi Kai Ni: 12cm 30-tube rocket launcher Kai 2 + air radar + type 3 shell → 25 is Ise / Musashi only.
    let rocket = || eq(274, 21, 15, EquipmentStats { anti_air: Some(10.0), ..Default::default() });
    let t3 = || eq(35, 18, 12, EquipmentStats { anti_air: Some(5.0), ..Default::default() });
    let musashi = with_id(ship(9, 99.0, 106, 100.0, 0.0, 90.0, 100.0, 50.0, 0.0, 20.0, vec![gun_41cm(), rocket(), air_radar(), t3()]), 546, 37);
    assert!(kinds(&musashi).contains(&28));
    // Enemy ships get kinds too (kcsim `getAACItype` for both sides).
    let enemy = ShipCore::new(&ship(5, 1.0, 50, 0.0, 0.0, 40.0, 40.0, 30.0, 0.0, 10.0, vec![ha(3, 4.0), eq(30, 36, 30, EquipmentStats { anti_air: Some(2.0), ..Default::default() })]), false);
    assert!(enemy.aaci.contains(&9));
}

#[test]
fn rocket_barrage_and_enemy_aaci_are_logged() {
    // Ise Kai Ni with two rocket launchers vs enemy carriers.
    let rocket = || eq(274, 21, 15, EquipmentStats { anti_air: Some(10.0), ..Default::default() });
    let ise = with_id(ship(10, 99.0, 77, 80.0, 0.0, 90.0, 80.0, 40.0, 0.0, 40.0, vec![gun_41cm(), rocket(), rocket()]), 553, 2);
    let fleet = FleetInput { ships: vec![ise, friend_cv()], formation: Some(Formation::LineAhead), ..Default::default() };
    let wo = ship(11, 1.0, 9999, 0.0, 0.0, 40.0, 300.0, 1.0, 0.0, 0.0, vec![db_suisei(40), db_suisei(40)]);
    // Enemy cruiser with HA gun + AA fire director: AACI kind 9 (39.6%) against the friend strike.
    let ca = ship(5, 1.0, 9999, 0.0, 0.0, 40.0, 300.0, 1.0, 0.0, 0.0, vec![eq(3, 4, 16, st(0.0, 0.0, 4.0, 0.0)), eq(30, 36, 30, st(0.0, 0.0, 2.0, 0.0))]);
    let enemy = FleetInput { ships: vec![wo, ca], formation: Some(Formation::LineAhead), ..Default::default() };
    let input = logged(fleet, enemy, BattleKind::Day);
    let (mut barrages, mut enemy_aaci, mut phases) = (0, 0, 0);
    for seed in 0..1000 {
        let r = run_battle(&input, seed).unwrap().result;
        let events = r.events.as_ref().unwrap();
        phases += events.iter().any(|e| e.phase == Phase::AirStrike && e.attacker_side == Side::Friend && e.kind == AttackKind::Air) as u32;
        for ev in r.air_defense.unwrap() {
            if ev.rocket_barrage {
                barrages += 1;
                assert_eq!((ev.side, ev.ship), (Side::Friend, 0));
                // The barrage ship's airstrikes of that phase all miss (logged as misses, pHit 0).
                assert!(events.iter().filter(|e| e.phase == ev.phase && e.kind == AttackKind::Air && e.attacker_side == Side::Enemy && e.defender == 0).all(|e| e.hit == HitResult::Miss && e.damage == 0 && e.p_hit == 0.0));
            }
            if ev.side == Side::Enemy {
                assert_eq!((ev.ship, ev.aaci), (1, Some(9)));
                enemy_aaci += 1;
            }
        }
    }
    assert!(barrages > 0);
    // Each friend air strike rolls the enemy AACI once.
    let share = enemy_aaci as f64 / phases.max(1) as f64;
    assert!(share > 0.3 && share < 0.5, "enemy AACI share {share}");
}

#[test]
fn heavy_cruiser_night_accuracy_and_night_zuiun_query() {
    use sim_core::query::{damage_distribution, hit_probability};
    let ca = |gun: u32| {
        let g = eq(gun, 2, 2, EquipmentStats { firepower: Some(10.0), accuracy: Some(1.0), ..Default::default() });
        ship(5, 99.0, 60, 60.0, 30.0, 40.0, 50.0, 50.0, 0.0, 20.0, vec![g.clone(), g])
    };
    let q = |att: ShipInput, special: Option<SpecialAttack>| -> AttackQuery {
        serde_json::from_value(serde_json::json!({
            "kind": "night", "attacker": att, "defender": enemy_ca(),
            "special": special,
        }))
        .unwrap()
    };
    // kcEQDATA `CANBbonus`: 20.3cm (No.2) +15 accuracy, 20.3cm twin (id 6) +10 (overrides 15).
    let base = hit_probability(&q(ca(1), None)).unwrap().accuracy;
    let no2 = hit_probability(&q(ca(50), None)).unwrap().accuracy;
    let twin = hit_probability(&q(ca(6), None)).unwrap().accuracy;
    assert!((no2 - base - 15.0).abs() < 1.0, "{base} {no2}");
    assert!((twin - base - 10.0).abs() < 1.0, "{base} {twin}");
    // Night Zuiun cut-in: ×1.32 power, ×1.07 accuracy; fleet special attacks are rejected.
    let plain = damage_distribution(&q(ca(1), None)).unwrap();
    let zz = damage_distribution(&q(ca(1), Some(SpecialAttack::NightZuiunZz))).unwrap();
    assert!(zz.mean_hit > plain.mean_hit);
    assert!(hit_probability(&q(ca(1), Some(SpecialAttack::NagatoCutin))).is_err());
}

#[test]
fn yamato_pair_rate_follows_the_wiki_formula() {
    // wikiwiki 大和改二: Yamato Lv99 luck 18 + Musashi Lv99 luck 10, both with an accuracy-8 radar,
    // Yamato flagship → 89.3%.
    let radar = || eq(142, 13, 11, EquipmentStats { los: Some(8.0), accuracy: Some(8.0), anti_air: Some(4.0), ..Default::default() });
    let mut yamato = lv_luck(bb(911, 37), 99.0, 18.0);
    let mut musashi = lv_luck(bb(546, 37), 99.0, 10.0);
    yamato.slots[3] = radar();
    musashi.slots[3] = radar();
    let input = logged(surface_six(vec![yamato, musashi], Formation::Echelon), dummy_enemy(6), BattleKind::Day);
    let p = trigger_share(&input, SpecialAttack::YamatoCutin2, Phase::Shelling1, 3000);
    assert!((p - 0.89).abs() < 0.025, "yamato {p}");
}
