//! Jet assault, land-base wave carry-over, LBAS against an enemy combined fleet, base air raids,
//! base radius and air-raid nodes.
mod common;

use common::*;
use serde_json::json;
use sim_core::battle::lbas::LandBaseCore;
use sim_core::battle::raid::{base_raid, BaseTarget, RaidBases, Raider};
use sim_core::battle::{Battle, FleetCore, Prepared};
use sim_core::model::*;
use sim_core::rng::Rng;
use sim_core::sim::{run_battle, simulate};
use sim_core::sortie::model::SortieInput;
use sim_core::sortie::simulate_sortie;

fn sq(id: u32, cat: u32, icon: u32, stats: EquipmentStats) -> EquipmentInput {
    EquipmentInput { id, types: vec![0, 0, cat, icon, 0], stats: Some(stats), ..Default::default() }
}
/// 噴式景雲改.
fn keiun() -> EquipmentInput {
    sq(199, 57, 39, EquipmentStats { bombing: Some(15.0), anti_air: Some(6.0), ..Default::default() })
}
/// 一式陸攻.
fn rikko() -> EquipmentInput {
    sq(169, 47, 37, EquipmentStats { torpedo: Some(12.0), bombing: Some(10.0), anti_air: Some(2.0), los: Some(2.0), ..Default::default() })
}
/// 雷電 (intercept 2, anti-bomber 5) or a rocket interceptor id with the same stats.
fn interceptor(id: u32) -> EquipmentInput {
    sq(id, 48, 44, EquipmentStats { anti_air: Some(6.0), evasion: Some(2.0), accuracy: Some(5.0), ..Default::default() })
}
fn wave(squadrons: Vec<EquipmentInput>) -> LandBaseWave {
    LandBaseWave { squadrons }
}

/// A carrier with jets in its first slot.
fn jet_cv() -> ShipInput {
    let mut cv = friend_cv();
    let mut jet = keiun();
    jet.planes = Some(10);
    cv.slots[0] = Some(jet);
    cv
}

fn tanky(mut fleet: FleetInput, hp: i32) -> FleetInput {
    for s in &mut fleet.ships {
        s.max_hp = hp;
    }
    fleet
}

fn logged(friend: FleetInput, enemy: FleetInput, kind: BattleKind, lbas: Vec<LandBaseWave>) -> BattleInput {
    let mut b = battle(friend, enemy, kind);
    b.options.log = true;
    b.lbas = Some(lbas);
    b
}

#[test]
fn jet_phases_in_game_order() {
    let friend = FleetInput { ships: vec![jet_cv(), friend_bb()], ..Default::default() };
    let input = logged(friend, tanky(enemy_fleet(), 500), BattleKind::Day, vec![wave(vec![keiun(), rikko()])]);
    let order = [Phase::JetLandBase, Phase::JetAirStrike, Phase::LandBase, Phase::AirStrike];
    let mut seen = [0; 4];
    for seed in 0..30 {
        let ev = run_battle(&input, seed).unwrap().result.events.unwrap();
        let rank = |p: Phase| order.iter().position(|&q| q == p).unwrap_or(4);
        assert!(ev.windows(2).all(|w| rank(w[0].phase) <= rank(w[1].phase)), "seed {seed}: out of order");
        for e in &ev {
            if let Some(k) = order.iter().position(|&q| q == e.phase) {
                seen[k] += 1;
            }
            match e.phase {
                // The base's jet squadron (slot 0), attacker = the base's wave.
                Phase::JetLandBase => assert!(e.attacker_side == Side::Friend && e.attacker == 0 && e.slot == Some(0)),
                // Only the carrier's jet slot, never the jet-less battleship.
                Phase::JetAirStrike => assert!(e.attacker_side == Side::Friend && e.attacker == 0 && e.slot == Some(0)),
                _ => {}
            }
        }
        // Jets keep attacking in the regular wave / air phase (×0.7071, wikiwiki 基地航空隊).
        assert!(ev.iter().filter(|e| e.phase == Phase::LandBase).all(|e| e.slot.is_some_and(|s| s < 2)));
    }
    assert!(seen.iter().all(|&n| n > 0), "{seen:?}");
    let jets_in_waves = (0..30).any(|s| {
        run_battle(&input, s).unwrap().result.events.unwrap().iter().any(|e| e.phase == Phase::LandBase && e.slot == Some(0))
    });
    assert!(jets_in_waves);

    // Without jets there is no jet phase.
    let plain = logged(friend_fleet(), enemy_fleet(), BattleKind::Day, vec![wave(vec![rikko()])]);
    for seed in 0..10 {
        let ev = run_battle(&plain, seed).unwrap().result.events.unwrap();
        assert!(ev.iter().all(|e| !matches!(e.phase, Phase::JetLandBase | Phase::JetAirStrike)));
    }
}

#[test]
fn concentrated_jet_base_attacks_once() {
    // Two identical waves = one base sent twice: one jet assault strike per jet squadron.
    let input = logged(friend_fleet(), tanky(enemy_fleet(), 500), BattleKind::Day, vec![wave(vec![keiun()]), wave(vec![keiun()])]);
    for seed in 0..20 {
        let ev = run_battle(&input, seed).unwrap().result.events.unwrap();
        assert!(ev.iter().filter(|e| e.phase == Phase::JetLandBase).count() <= 1);
    }
}

/// Final squadron size of the base's first squadron after `p`'s battle (`seed`).
fn final_planes(p: &Prepared, seed: u64) -> i32 {
    let mut rng = Rng::new(seed);
    let mut b = p.battle(&mut rng);
    b.run();
    b.lb_planes().unwrap()[0][0]
}

#[test]
fn concentrated_waves_restart_from_the_same_planes() {
    // Strong enemy AA, no enemy planes, nothing sinks: every wave loses planes to stage 2.
    let mut enemy = tanky(enemy_fleet(), 9999);
    for s in &mut enemy.ships {
        s.stats.anti_air = 150.0;
    }
    let one = battle(friend_fleet(), enemy.clone(), BattleKind::Day);
    let mut single = one.clone();
    single.lbas = Some(vec![wave(vec![rikko()])]);
    let mut twice = one.clone();
    twice.lbas = Some(vec![wave(vec![rikko()]), wave(vec![rikko()])]);
    let (ps, pt) = (Prepared::new(&single).unwrap(), Prepared::new(&twice).unwrap());
    let n = 400;
    let mean = |p: &Prepared| (0..n).map(|s| final_planes(p, s) as f64).sum::<f64>() / n as f64;
    let (m1, m2) = (mean(&ps), mean(&pt));
    // Carried losses (split targets / a second node): the second battle starts from the survivors.
    let waves = [0usize];
    let carried = (0..n)
        .map(|s| {
            let mut rng = Rng::new(s);
            let mut b = ps.battle(&mut rng);
            b.run();
            let planes = b.lb_planes().unwrap();
            let mut b2 = Battle::new([&ps.fleets[0], &ps.fleets[1]], [ps.init[0].clone(), ps.init[1].clone()], ps.setup, &mut rng);
            b2.set_lbas(&ps.lbas, &waves, planes);
            b2.run();
            b2.lb_planes().unwrap()[0][0] as f64
        })
        .sum::<f64>()
        / n as f64;
    assert!(m1 < 17.0, "{m1}");
    assert!((m1 - m2).abs() < 0.5, "single {m1} vs concentrated {m2}");
    assert!(carried < m1 - 1.0, "carried {carried} vs {m1}");
}

#[test]
fn enemy_combined_fleet_lbas_targets_and_evasion() {
    let ca = || { let mut s = enemy_ca(); s.max_hp = 9999; s };
    let combined = FleetInput { ships: (0..6).map(|_| ca()).collect(), escort: Some((0..6).map(|_| ca()).collect()), ..Default::default() };
    let single = FleetInput { ships: (0..6).map(|_| ca()).collect(), ..Default::default() };
    let friend = FleetInput { ships: vec![jet_cv(), friend_bb()], ..Default::default() };
    let lb = vec![wave(vec![keiun(), rikko(), rikko(), rikko()]); 2];
    let (mut main, mut escort, mut jet_escort_cover) = (0, 0, 0);
    let (mut p_comb, mut p_single) = (0.0, 0.0);
    for seed in 0..300 {
        for (enemy, p) in [(&combined, &mut p_comb), (&single, &mut p_single)] {
            let input = logged(friend.clone(), enemy.clone(), BattleKind::Day, lb.clone());
            for e in run_battle(&input, seed).unwrap().result.events.unwrap() {
                let to_escort = enemy.escort.is_some() && e.defender >= 6;
                match e.phase {
                    Phase::LandBase if e.attacker_side == Side::Friend => {
                        *p = f64::max(*p, e.p_hit);
                        if enemy.escort.is_some() {
                            if to_escort {
                                escort += 1;
                            } else {
                                main += 1;
                            }
                        }
                        // Waves: only main-fleet ships cover the main flagship.
                        assert!(!(e.covered && to_escort), "{e:?}");
                    }
                    // Jet assaults are airstrikes: escort ships may cover the main flagship.
                    Phase::JetLandBase | Phase::JetAirStrike if e.covered && to_escort => jet_escort_cover += 1,
                    _ => {}
                }
            }
        }
    }
    let share = main as f64 / (main + escort) as f64;
    assert!((share - 0.45).abs() < 0.04, "main share {share}");
    // lbasEvaModCombined 0.68 < 0.86: less dodge, better accuracy.
    assert!(p_comb > p_single, "{p_comb} vs {p_single}");
    assert!(jet_escort_cover > 0);
}

/// Abyssal carrier raid: dive bombers `id` (heavy bomber 1597 or a plain dive bomber).
fn raid_enemy(bomber_id: u32) -> FleetInput {
    let bomber = |n: i32| {
        let mut e = sq(bomber_id, 7, 7, EquipmentStats { firepower: Some(17.0), bombing: Some(27.0), anti_air: Some(9.0), accuracy: Some(3.0), ..Default::default() });
        e.planes = Some(n);
        Some(e)
    };
    let cv = ship(11, 1.0, 400, 0.0, 0.0, 50.0, 60.0, 30.0, 0.0, 10.0, vec![bomber(30), bomber(30), bomber(30), bomber(30)]);
    FleetInput { ships: vec![cv.clone(), cv], ..Default::default() }
}

fn raid_input(enemy: FleetInput, bases: Vec<RaidBase>) -> BattleInput {
    let mut b = battle(friend_fleet(), enemy_fleet(), BattleKind::Day);
    b.base_raid = Some(BaseRaidInput { enemy, bases, high_altitude: None });
    b
}

#[test]
fn base_raid_with_and_without_defense() {
    let squadrons = vec![interceptor(175); 4];
    let bases = |defense: bool| vec![RaidBase { squadrons: squadrons.clone(), defense, hp: None }, RaidBase { squadrons: vec![rikko()], ..Default::default() }];
    let none = simulate(&raid_input(raid_enemy(1500), bases(false)), 400, 1).unwrap().base_raid.unwrap();
    let def = simulate(&raid_input(raid_enemy(1500), bases(true)), 400, 1).unwrap().base_raid.unwrap();
    assert_eq!(none.hp_lost_mean.len(), 2);
    assert!(none.rate.is_none());
    // No defence: no friend planes, the raid has air supremacy.
    assert!((none.air_state_rates.incapability - 1.0).abs() < 1e-12, "{:?}", none.air_state_rates);
    assert!(def.air_state_rates.incapability < 1.0);
    let lost = |s: &BaseRaidSummary| s.hp_lost_mean.iter().sum::<f64>();
    assert!(lost(&none) > 20.0 && lost(&def) < lost(&none) * 0.8, "{} vs {}", lost(&def), lost(&none));
    // The battle itself is unaffected by the raid inputs' existence except for the RNG stream.
    let out = run_battle(&raid_input(raid_enemy(1500), bases(true)), 3).unwrap();
    let r = out.result.base_raid.unwrap();
    assert_eq!(r.hp_lost.len(), 2);
    assert!(r.hp_lost.iter().all(|&h| (0..200).contains(&h)));
}

#[test]
fn heavy_bomber_raid_needs_rocket_interceptors() {
    let plain = vec![RaidBase { squadrons: vec![interceptor(175); 4], defense: true, hp: None }];
    let rockets = vec![RaidBase { squadrons: vec![interceptor(350), interceptor(351), interceptor(352), interceptor(352)], defense: true, hp: None }];
    let run = |enemy: FleetInput, bases: &Vec<RaidBase>| simulate(&raid_input(enemy, bases.clone()), 300, 2).unwrap().base_raid.unwrap();
    // Ordinary bombers: rocket ids do nothing.
    let (a, b) = (run(raid_enemy(1500), &plain), run(raid_enemy(1500), &rockets));
    assert_eq!(a, b);
    // Defence 4 × ⌊18 × √18⌋ = 304 vs raid 8 × ⌊9 × √30⌋ = 392: parity. Heavy bombers: × 0.5
    // without rockets (152: denial), × 1.2 with 3+ (364: parity).
    let (h0, h3) = (run(raid_enemy(1597), &plain), run(raid_enemy(1597), &rockets));
    assert_eq!(a.air_state_rates.parity, 1.0, "{a:?}");
    assert_eq!(h0.air_state_rates.denial, 1.0, "{h0:?}");
    assert_eq!(h3.air_state_rates.parity, 1.0, "{h3:?}");
    assert!(h0.hp_lost_mean[0] > a.hp_lost_mean[0]);
    // `highAltitude` without heavy bombers applies the same rule (same stats, only the id differs).
    let mut forced = raid_input(raid_enemy(1500), plain.clone());
    forced.base_raid.as_mut().unwrap().high_altitude = Some(true);
    assert_eq!(simulate(&forced, 300, 2).unwrap().base_raid.unwrap(), h0);
}

#[test]
fn heavy_raid_damage_destroys_planes_on_the_ground() {
    // An undefended base hit for 50+ HP loses 1–4 planes from its first squadron (each keeps ≥ 1).
    let (fleet, init) = FleetCore::build(&raid_enemy(1500), false);
    let bases = [LandBaseCore::new("b", &[{ let mut e = rikko(); e.planes = Some(2); e }, rikko()]).unwrap()];
    let target = BaseTarget::default();
    let mut seen_loss = false;
    for seed in 0..50 {
        let mut rng = Rng::new(seed);
        let mut planes = sim_core::battle::lbas::initial_planes(&bases);
        let mut hp = [200; 6];
        let raider = Raider { fleet: &fleet, init: &init, formation: Formation::LineAhead, high_altitude: false };
        let (air, lost) = base_raid(&mut rng, &raider, RaidBases { bases: &bases, defense: &[false], planes: &mut planes, hp: &mut hp }, &target);
        assert_eq!(air, -2);
        assert_eq!(hp[0], 200 - lost[0]);
        assert!(hp[0] >= 1);
        let gone = 2 + 18 - planes[0][0] - planes[0][1];
        if lost[0] >= 50 {
            assert!((1..=4).contains(&gone) && planes[0][0] == 1, "{gone} {:?}", planes[0]);
            seen_loss = true;
        } else {
            assert_eq!(gone, 0);
        }
    }
    assert!(seen_loss);
}

fn radius_sortie(squadrons: serde_json::Value, distance: u32) -> SortieInput {
    serde_json::from_value(json!({
        "friend": friend_fleet(),
        "hqLevel": 120,
        "map": { "routing": { "map": "9-9", "sources": [{ "id": "t", "note": "test" }], "nodes": {
            "Start": { "rules": [{ "to": "A" }] }, "A": { "end": true } } },
            "nodes": { "A": { "kind": "boss", "lbasDistance": distance, "comps": [{ "weight": 1.0, "fleet": tanky(enemy_fleet(), 400) }] } } },
        "policy": { "night": "never" },
        "lbas": [{ "squadrons": squadrons, "targets": ["A", "A"] }]
    }))
    .unwrap()
}

#[test]
fn waves_beyond_the_base_radius_are_dropped() {
    let bomber = |r: u32| EquipmentInput { radius: Some(r), ..rikko() };
    // 二式大艇 (radius 20) extends 5 by min(round(√15), 3) = 3 → 8.
    let boat = EquipmentInput { radius: Some(20), ..sq(138, 41, 33, EquipmentStats { los: Some(12.0), ..Default::default() }) };
    let none = simulate_sortie(&radius_sortie(json!([]), 7), 300, 1).unwrap();
    let far = simulate_sortie(&radius_sortie(json!([bomber(5), bomber(5)]), 7), 300, 1).unwrap();
    let ext = simulate_sortie(&radius_sortie(json!([bomber(5), boat]), 7), 300, 1).unwrap();
    let unknown = simulate_sortie(&radius_sortie(json!([rikko(), rikko()]), 7), 300, 1).unwrap();
    assert!(far.warnings.iter().any(|w| w.contains("beyond the base radius 5")), "{:?}", far.warnings);
    assert_eq!(far.boss.flagship_damage_mean, none.boss.flagship_damage_mean);
    assert!(!ext.warnings.iter().any(|w| w.contains("radius")), "{:?}", ext.warnings);
    assert!(!unknown.warnings.iter().any(|w| w.contains("radius")));
    assert!(unknown.boss.flagship_damage_mean > none.boss.flagship_damage_mean);
}

#[test]
fn sortie_base_raids_and_defense_bases() {
    let mut input = radius_sortie(json!([rikko()]), 1);
    let enemy = raid_enemy(1500);
    input.lbas.as_mut().unwrap().push(serde_json::from_value(json!({ "squadrons": vec![interceptor(175); 4], "targets": ["A"], "defense": true })).unwrap());
    input.base_raids = Some(vec![serde_json::from_value(json!({ "node": "A", "chance": 0.5, "comps": [{ "weight": 1.0, "fleet": enemy }] })).unwrap()]);
    let s = simulate_sortie(&input, 600, 3).unwrap();
    let raid = s.base_raid.unwrap();
    assert!((raid.rate.unwrap() - 0.5).abs() < 0.07, "{:?}", raid.rate);
    assert_eq!(raid.hp_lost_mean.len(), 2);
    assert!(raid.hp_lost_mean.iter().sum::<f64>() > 0.0);
    assert!(raid.air_state_rates.incapability < 1.0);
    assert!(s.warnings.iter().any(|w| w.contains("air defence base; targets ignored")), "{:?}", s.warnings);
    // No raids configured: no summary.
    assert!(simulate_sortie(&radius_sortie(json!([rikko()]), 1), 10, 1).unwrap().base_raid.is_none());
}

#[test]
fn air_raid_node_phases() {
    // Jet carrier + land-base jets at an air-raid node: land-base jet assault and waves happen, the
    // fleet jet assault and friend airstrikes do not.
    let friend = FleetInput { ships: vec![jet_cv(), friend_bb()], ..Default::default() };
    let mut cv = friend_cv();
    cv.max_hp = 500;
    let enemy = FleetInput { ships: vec![cv.clone(), cv], ..Default::default() };
    let input = logged(friend.clone(), enemy, BattleKind::AirRaid, vec![wave(vec![keiun(), rikko()])]);
    let (mut jet_lb, mut waves) = (0, 0);
    for seed in 0..20 {
        let ev = run_battle(&input, seed).unwrap().result.events.unwrap();
        assert!(ev.iter().all(|e| e.phase != Phase::JetAirStrike));
        assert!(ev.iter().filter(|e| e.phase == Phase::AirStrike).all(|e| e.attacker_side == Side::Enemy));
        jet_lb += ev.iter().filter(|e| e.phase == Phase::JetLandBase).count();
        waves += ev.iter().filter(|e| e.phase == Phase::LandBase).count();
    }
    assert!(jet_lb > 0 && waves > 0);

    // Land bases sink the whole raid: air supremacy for a fleet with planes, rank by HP loss (SS).
    let weak = FleetInput { ships: vec![{ let mut d = enemy_dd(); d.max_hp = 1; d }], ..Default::default() };
    let mut cleared = battle(friend, weak, BattleKind::AirRaid);
    cleared.lbas = Some(vec![wave(vec![rikko(), rikko(), rikko(), rikko()]); 2]);
    let s = simulate(&cleared, 200, 5).unwrap();
    assert!(s.air_state_rates.supremacy > 0.9, "{:?}", s.air_state_rates);
    assert!(s.rank_rates.ss > 0.9);
}
