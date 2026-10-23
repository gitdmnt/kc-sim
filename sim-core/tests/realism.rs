//! Battle-level checks against numbers published on en.kancollewiki.net (Accuracy, Damage
//! Calculations, Aerial Combat pages; snapshots 2025-11 … 2026-04) and the AACI / night-carrier ports.
mod common;

use common::*;
use sim_core::battle::calc::{night_air_power, Unit, CF_NONE};
use sim_core::formulas::{accuracy_and_crit, protect, Evasion};
use sim_core::model::*;
use sim_core::rng::Rng;
use sim_core::ship::{aaci_trigger_rate, NightCi, ShipCore};
use sim_core::query::{damage_distribution, hit_probability};
use sim_core::sim::run_battle;

fn eqp(id: u32, cat: u32, icon: u32, stats: EquipmentStats, planes: i32) -> Option<EquipmentInput> {
    Some(EquipmentInput { id, types: vec![0, 0, cat, icon, 0], stats: Some(stats), planes: Some(planes), ..Default::default() })
}

/// Wiki (Damage Calculations, overkill protection): a 32 HP DD hit by an overkill has a 15.5% chance to
/// end heavily damaged, a 31 HP DD 6.5%; a 6 HP ship can never be taiha'd by an overkill.
#[test]
fn overkill_taiha_odds() {
    let mut rng = Rng::new(11);
    let rate = |rng: &mut Rng, hp: i32| {
        let n = 400_000;
        let taiha = (0..n).filter(|_| (hp - protect(rng, 9999, hp, false)) as f64 <= 0.25 * hp as f64).count();
        taiha as f64 / n as f64
    };
    assert!((rate(&mut rng, 32) - 5.0 / 32.0).abs() < 0.003); // 15.6%
    assert!((rate(&mut rng, 31) - 2.0 / 31.0).abs() < 0.003); // 6.5%
    assert_eq!(rate(&mut rng, 6), 0.0);
}

/// Wiki (Accuracy): a 50% hit rate on a shelling attack gives a 10% critical rate (40% normal hits).
#[test]
fn crit_example() {
    let ev = Evasion { ev: 0.0, luck: 0.0, ev_mod: 1.0, ev_flat: 0.0, fuel_pct: 100, morale: 49, ev_bonus: 1.0 };
    let hc = accuracy_and_crit(0.49, &ev, 1.3, None, 0.0);
    assert_eq!((hc.p_hit(), hc.p_crit()), (0.5, 0.1));
}

/// Wiki (Damage Calculations, ASW synergy): small sonar + projector + depth charge = 1.15 × 1.25.
#[test]
fn asw_synergy_example() {
    let st = |asw: f64| EquipmentStats { asw: Some(asw), ..Default::default() };
    let mut dd = ship(2, 99.0, 32, 30.0, 70.0, 40.0, 30.0, 80.0, 64.0, 15.0, vec![eqp(46, 14, 18, st(6.0), 0), eqp(45, 15, 17, st(8.0), 0), eqp(226, 15, 17, st(4.0), 0)]);
    dd.equip_bonus = None;
    let c = ShipCore::new(&dd, true);
    let plain = 2.0 * 64f64.sqrt() + 1.5 * 18.0 + 13.0;
    assert!((c.asw_power / plain - 1.4375).abs() < 1e-9, "{}", c.asw_power / plain);
}

fn akizuki_like(ship_class: Option<u32>) -> ShipCore {
    let st = |aa: f64, los: f64| EquipmentStats { anti_air: Some(aa), los: Some(los), ..Default::default() };
    let mut s = ship(
        2,
        99.0,
        37,
        30.0,
        40.0,
        70.0,
        30.0,
        80.0,
        60.0,
        20.0,
        vec![eqp(122, 1, 16, st(10.0, 0.0), 0), eqp(122, 1, 16, st(10.0, 0.0), 0), eqp(27, 12, 11, st(4.0, 3.0), 0), eqp(131, 21, 15, st(9.0, 0.0), 0)],
    );
    s.ship_class = ship_class;
    ShipCore::new(&s, true)
}

/// Wiki (Aerial Combat, AACI examples): an Akizuki-class with 2 HA guns w/ fire director (8+ AA), an
/// air radar and a 9+ AA gun can trigger AACI 1, 2, 3, 13 (in this order): 94.98% overall.
#[test]
fn aaci_examples() {
    let aki = akizuki_like(Some(54));
    assert_eq!(aki.aaci, vec![1, 2, 3, 13]);
    assert!((aaci_trigger_rate(&aki.aaci) - 0.9498).abs() < 5e-5, "{}", aaci_trigger_rate(&aki.aaci));
    // Same equipment on a non-Akizuki destroyer (Isokaze B Kai minus her ship-specific AACI 29): 5, 8, 13.
    let other = akizuki_like(None);
    assert_eq!(other.aaci, vec![5, 8, 13]);
}

#[test]
fn enemy_subs_without_opening_torpedo() {
    let sub = |id: u32| {
        let mut s = enemy_ss();
        s.id = Some(id);
        s.level = Some(50.0);
        s
    };
    let enemy = FleetInput { ships: vec![sub(1530), sub(1532)], formation: None, ..Default::default() };
    let mut input = battle(FleetInput { ships: vec![friend_dd(), friend_dd()], formation: None, ..Default::default() }, enemy, BattleKind::Day);
    input.options.log = true;
    let mut fired = [0, 0];
    for seed in 0..50 {
        for e in run_battle(&input, seed).unwrap().result.events.unwrap() {
            if e.phase == Phase::OpeningTorpedo && e.attacker_side == Side::Enemy {
                fired[e.attacker] += 1;
            }
        }
    }
    assert_eq!(fired[0], 0, "潜水カ級 (1530) must not fire opening torpedoes");
    assert_eq!(fired[1], 50, "潜水カ級elite (1532, lv 50) fires one opening torpedo per battle");
}

fn night_carrier() -> ShipInput {
    let mut s = ship(
        11,
        99.0,
        80,
        50.0,
        0.0,
        70.0,
        70.0,
        45.0,
        0.0,
        30.0,
        vec![
            eqp(254, 6, 45, EquipmentStats { anti_air: Some(8.0), ..Default::default() }, 20),
            eqp(257, 8, 46, EquipmentStats { torpedo: Some(9.0), asw: Some(7.0), ..Default::default() }, 18),
            eqp(258, 35, 51, EquipmentStats::default(), 0),
        ],
    );
    s.range = Some(1.0);
    s
}

/// Carrier night air attack power (kcsim CV.NBPower) for a night fighter (20) + night attacker (18):
/// 50 + (0 + 3·20) + (9 + 3·18 + 1.5·0.3·(9 + 7)·√18) = 203.55.
#[test]
fn carrier_night_air_attack() {
    let cv = night_carrier();
    let core = ShipCore::new(&cv, true);
    let st = core.initial_state(&cv);
    assert!(core.night_air_gear && core.can_night_air(&st));
    assert_eq!(core.night_cv_ci(&st), vec![NightCi::CvFa]);
    let unit = Unit { core: &core, st: &st, form: Formation::LineAhead, idx: 0, len: 1, cf: CF_NONE, smoke: 0, balloons: 0, bonus: None };
    let dd = ShipCore::new(&enemy_dd(), false);
    let p = night_air_power(&unit, &dd);
    assert!((p - (50.0 + 60.0 + 9.0 + 54.0 + 0.45 * 16.0 * 18f64.sqrt())).abs() < 1e-9, "{p}");
    // In a night battle the carrier attacks and sometimes cuts in; without the personnel it cannot.
    let mut input = battle(FleetInput { ships: vec![cv.clone()], formation: None, ..Default::default() }, enemy_fleet(), BattleKind::NightOnly);
    input.options.log = true;
    let (mut attacks, mut cutins) = (0, 0);
    for seed in 0..200 {
        for e in run_battle(&input, seed).unwrap().result.events.unwrap() {
            if e.attacker_side == Side::Friend {
                attacks += 1;
                cutins += (e.special == SpecialAttack::NightCvciFa) as i32;
            }
        }
    }
    assert!(attacks >= 200 && cutins > 20, "{attacks} {cutins}");
    let mut no_crew = cv;
    no_crew.slots.pop();
    input.friend.ships = vec![no_crew];
    let events = run_battle(&input, 1).unwrap().result.events.unwrap();
    assert!(events.iter().all(|e| e.attacker_side == Side::Enemy));
}

/// Abyssal carriers shell in the day battle with the carrier formula while they have bombers, and
/// cannot shell once every bomber slot is empty.
#[test]
fn enemy_carrier_shelling() {
    let mut wo = friend_cv();
    wo.id = Some(1510);
    let enemy = FleetInput { ships: vec![wo.clone()], formation: None, ..Default::default() };
    let friend = FleetInput { ships: vec![friend_dd(), friend_dd()], formation: None, ..Default::default() };
    let mut input = battle(friend.clone(), enemy, BattleKind::Day);
    input.options.log = true;
    let mut shelled = 0;
    for seed in 0..50 {
        for e in run_battle(&input, seed).unwrap().result.events.unwrap() {
            shelled += (e.attacker_side == Side::Enemy && e.kind == AttackKind::Shelling) as i32;
        }
    }
    assert!(shelled >= 50, "{shelled}");
    for s in wo.slots.iter_mut().flatten() {
        if s.types[2] != 6 {
            s.planes = Some(0);
        }
    }
    input.enemy.ships = vec![wo];
    let events = run_battle(&input, 1).unwrap().result.events.unwrap();
    assert!(events.iter().all(|e| !(e.attacker_side == Side::Enemy && e.kind == AttackKind::Shelling)));
}

fn query(kind: &str, attacker: &ShipInput, defender: &ShipInput, side: &str) -> AttackQuery {
    serde_json::from_value(serde_json::json!({ "kind": kind, "attacker": attacker, "defender": defender, "attackerSide": side })).unwrap()
}

/// Wiki (Accuracy, torpedo): `Mod_ship` is an innate torpedo accuracy that only abyssal ships have
/// (kcsim `TACC`, the data API's abyssal `acc`). It must raise torpedo accuracy only — as the
/// all-attack `hiddenAccuracy` it lifted enemy shelling hit rates from ~49% to ~90% (6-5 C).
#[test]
fn torpedo_accuracy_is_torpedo_only() {
    let mut enemy = ship(2, 1.0, 38, 44.0, 72.0, 36.0, 29.0, 56.0, 0.0, 42.0, vec![]);
    let target = friend_dd();
    let plain = |kind: &str, e: &ShipInput| hit_probability(&query(kind, e, &target, "enemy")).unwrap();
    let (shell0, torp0, night0) = (plain("shelling", &enemy), plain("torpedo", &enemy), plain("night", &enemy));
    enemy.torpedo_accuracy = Some(60.0);
    assert_eq!(plain("shelling", &enemy).accuracy, shell0.accuracy);
    assert_eq!(plain("night", &enemy).accuracy, night0.accuracy);
    assert!((plain("torpedo", &enemy).accuracy - torp0.accuracy - 60.0).abs() < 1e-9);
    // The generic hidden accuracy still applies to every attack.
    enemy.torpedo_accuracy = None;
    enemy.hidden_accuracy = Some(10.0);
    assert!((plain("shelling", &enemy).accuracy - shell0.accuracy - 10.0).abs() < 1e-9);
}

/// kcsim `AO.loadEquips` / kcSHIPDATA `canAirAttack`: 速吸改 (352), 山汐丸改, しまね丸改 with a dive or
/// torpedo bomber shell with the carrier formula 25 + ⌊1.5·(15 + FP + 5 + TP_equip + ⌊1.3·DB⌋)⌋ and,
/// like carriers, only while a bomber slot has planes.
#[test]
fn air_capable_oiler_shells_like_a_carrier() {
    let ryuusei = || eqp(52, 8, 8, EquipmentStats { torpedo: Some(13.0), ..Default::default() }, 6);
    let mut hayasui = ship(22, 99.0, 48, 36.0, 0.0, 48.0, 19.0, 33.0, 36.0, 44.0, vec![ryuusei()]);
    hayasui.id = Some(352);
    let target = ship(2, 1.0, 999, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, vec![]);
    let mean = |s: &ShipInput| damage_distribution(&query("shelling", s, &target, "friend")).unwrap().mean_hit;
    // power 25 + ⌊1.5·(15 + 36 + 5 + 13)⌋ = 128 vs armor 1: ⌊128 − 0.7⌋ = 127
    assert_eq!(mean(&hayasui), 127.0);
    assert!(ShipCore::new(&hayasui, true).cv_like());
    // Not one of the three oilers: a plain ship, ⌊(36 + 5) − 0.7⌋ = 40.
    let mut plain = hayasui.clone();
    plain.id = Some(1);
    assert_eq!(mean(&plain), 40.0);
    // Bombers shot down: no shelling turn.
    let mut empty = hayasui.clone();
    empty.slots = vec![eqp(52, 8, 8, EquipmentStats { torpedo: Some(13.0), ..Default::default() }, 0)];
    let enemy = FleetInput { ships: vec![ship(2, 1.0, 999, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, vec![])], formation: None, ..Default::default() };
    let mut input = battle(FleetInput { ships: vec![empty], formation: None, ..Default::default() }, enemy, BattleKind::Day);
    input.options.log = true;
    let events = run_battle(&input, 3).unwrap().result.events.unwrap();
    assert!(events.iter().all(|e| !(e.attacker_side == Side::Friend && e.kind == AttackKind::Shelling)));
}

/// The game's shelling order (kcsim `COMMON.zendQsort` with a coin-flip comparator on equal ranges)
/// is not a uniform shuffle. Reference position distributions from kcsim's own sort (2M runs).
#[test]
fn shelling_order_matches_game_sort() {
    use sim_core::battle::game_range_sort;
    let dist = |ranges: &[u8], n: usize| {
        let mut rng = Rng::new(5);
        let mut pos = vec![vec![0.0; ranges.len()]; ranges.len()];
        for _ in 0..n {
            let mut items: Vec<usize> = (0..ranges.len()).collect();
            let mut r = ranges.to_vec();
            game_range_sort(&mut items, &mut r, &mut rng);
            for (p, &s) in items.iter().enumerate() {
                pos[s][p] += 1.0 / n as f64;
            }
        }
        pos
    };
    let close = |a: &[f64], b: &[f64]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.006);
    let p = dist(&[1, 1, 1], 200_000);
    assert!(close(&p[0], &[0.4998, 0.1877, 0.3125]), "{p:?}");
    assert!(close(&p[1], &[0.1253, 0.6248, 0.2500]), "{p:?}");
    let p = dist(&[3, 1, 1, 3, 1, 2], 200_000);
    assert!(close(&p[0], &[0.4995, 0.5005, 0.0, 0.0, 0.0, 0.0]), "{p:?}");
    assert!(close(&p[1], &[0.0, 0.0, 0.0, 0.3749, 0.2500, 0.3751]), "{p:?}");
    assert!((p[5][2] - 1.0).abs() < 1e-9);
}
