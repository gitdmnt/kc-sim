//! Enemy combined fleets (kcsimcombined `sim6vs12` / `sim12vs12`), night-to-day battles (kcsim
//! `simNightFirstCombined`), detection and air-phase participants, combined-fleet fixes.
mod common;

use common::*;
use serde_json::json;
use sim_core::model::*;
use sim_core::sim::{run_battle, simulate};
use sim_core::sortie::model::*;
use sim_core::sortie::simulate_sortie;

fn tough(mut s: ShipInput) -> ShipInput {
    s.max_hp = 600;
    s.stats.armor = 150.0;
    s
}

fn enemy_cvl(hp: i32) -> ShipInput {
    let mut s = ship(7, 1.0, hp, 0.0, 0.0, 30.0, 40.0, 20.0, 0.0, 10.0, vec![db_suisei(24), tb_ryuusei(24)]);
    s.range = Some(1.0);
    s
}

/// Enemy combined fleet that survives the day: main [BB, CA, CA, CL, DD, DD], escort
/// [CL, DD x5], all with 600 HP.
fn enemy_combined() -> FleetInput {
    FleetInput {
        ships: [enemy_bb(), enemy_ca(), enemy_ca(), enemy_cl(), enemy_dd(), enemy_dd()].into_iter().map(tough).collect(),
        escort: Some([enemy_cl(), enemy_dd(), enemy_dd(), enemy_dd(), enemy_dd(), enemy_dd()].into_iter().map(tough).collect()),
        ..Default::default()
    }
}

fn friend_combined(ct: CombinedType) -> FleetInput {
    FleetInput {
        ships: vec![friend_cv(), friend_bb(), friend_bb(), friend_ca(), friend_ca(), friend_cl()],
        escort: Some(vec![friend_cl(), friend_ca(), friend_dd(), friend_dd(), friend_dd(), friend_dd()]),
        combined: Some(ct),
        ..Default::default()
    }
}

fn logged(friend: FleetInput, enemy: FleetInput, kind: BattleKind) -> BattleInput {
    let mut b = battle(friend, enemy, kind);
    b.options.log = true;
    b
}

fn events(input: &BattleInput, seed: u64) -> Vec<AttackEvent> {
    run_battle(input, seed).unwrap().result.events.unwrap()
}

/// (friend ship index, enemy ship index) of an event.
fn sides(e: &AttackEvent) -> (usize, usize) {
    if e.attacker_side == Side::Friend {
        (e.attacker, e.defender)
    } else {
        (e.defender, e.attacker)
    }
}

#[test]
fn six_vs_twelve_phase_order_and_targets() {
    let input = logged(friend_fleet(), enemy_combined(), BattleKind::DayNight);
    let (mut s3_main, mut s3_escort, mut torp_escort_hit, mut torp_main_hit) = (0, 0, 0, 0);
    for seed in 0..40 {
        let out = run_battle(&input, seed).unwrap();
        assert_eq!(out.result.enemy.len(), 12);
        for e in out.result.events.unwrap() {
            let (_, en) = sides(&e);
            let enemy_att = e.attacker_side == Side::Enemy;
            match e.phase {
                // Shelling 1 against the enemy escort, shelling 2 against the enemy main fleet.
                Phase::Shelling1 => assert!(en >= 6, "{e:?}"),
                Phase::Shelling2 => assert!(en < 6, "{e:?}"),
                // Shelling 3: enemy main fleet in fleet order; the friend shoots at both fleets.
                Phase::Shelling3 if enemy_att => assert!(en < 6, "{e:?}"),
                Phase::Shelling3 => {
                    if en >= 6 {
                        s3_escort += 1;
                    } else {
                        s3_main += 1;
                    }
                }
                // Only the enemy escort fires torpedoes; friend torpedoes reach both fleets and the
                // enemy main flagship is covered by main-fleet ships only.
                Phase::OpeningTorpedo | Phase::ClosingTorpedo if enemy_att => assert!(en >= 6, "{e:?}"),
                Phase::OpeningTorpedo | Phase::ClosingTorpedo => {
                    assert!(!e.covered || en < 6, "{e:?}");
                    if en >= 6 {
                        torp_escort_hit += 1;
                    } else {
                        torp_main_hit += 1;
                    }
                }
                Phase::OpeningAsw if enemy_att => assert!(en >= 6, "{e:?}"),
                _ => {}
            }
        }
    }
    assert!(s3_main > 0 && s3_escort > 0, "{s3_main} {s3_escort}");
    assert!(torp_main_hit > 0 && torp_escort_hit > 0, "{torp_main_hit} {torp_escort_hit}");
}

#[test]
fn twelve_vs_twelve_phase_order_per_combined_type() {
    for ct in [CombinedType::Carrier, CombinedType::Surface, CombinedType::Transport] {
        let input = logged(friend_combined(ct), enemy_combined(), BattleKind::DayNight);
        let mut both = 0;
        let mut night = 0;
        for seed in 0..25 {
            for e in events(&input, seed) {
                let (fr, en) = sides(&e);
                let (fa, ea) = if e.attacker_side == Side::Friend { (Some(fr), None) } else { (None, Some(en)) };
                let surface = ct == CombinedType::Surface;
                // (fleets of the round: Some(escort?) or None = mains vs both fleets)
                let round = match e.phase {
                    Phase::Shelling1 => Some(false),
                    Phase::Shelling2 if surface => None,
                    Phase::Shelling2 => Some(true),
                    Phase::Shelling3 if surface => Some(true),
                    Phase::Shelling3 => None,
                    _ => {
                        if matches!(e.phase, Phase::OpeningTorpedo | Phase::ClosingTorpedo | Phase::OpeningAsw | Phase::Night) {
                            // Escorts attack (torpedoes, OASW, night); main fleets never.
                            assert!(fa.is_none_or(|a| a >= 6) && ea.is_none_or(|a| a >= 6), "{ct:?} {e:?}");
                        }
                        if e.phase == Phase::Night {
                            night += 1;
                        }
                        continue;
                    }
                };
                match round {
                    Some(escort) => assert!((fr >= 6) == escort && (en >= 6) == escort, "{ct:?} {e:?}"),
                    None => {
                        assert!(fa.is_none_or(|a| a < 6) && ea.is_none_or(|a| a < 6), "{ct:?} {e:?}");
                        if fr >= 6 || en >= 6 {
                            both += 1;
                        }
                    }
                }
            }
        }
        assert!(both > 0, "{ct:?}: the mains' second round never targeted an escort");
        assert!(night > 0, "{ct:?}");
    }
}

#[test]
fn twelve_vs_twelve_escort_planes_launch() {
    let mut friend = friend_combined(CombinedType::Carrier);
    friend.escort.as_mut().unwrap()[1] = tough(enemy_cvl(60)); // a CVL in the friend escort
    friend.escort.as_mut().unwrap()[1].ship_type = 7;
    let mut enemy = enemy_combined();
    enemy.escort.as_mut().unwrap()[2] = enemy_cvl(600);
    let input = logged(friend.clone(), enemy.clone(), BattleKind::Day);
    let (mut friend_escort, mut enemy_escort) = (0, 0);
    for seed in 0..20 {
        for e in events(&input, seed).iter().filter(|e| e.phase == Phase::AirStrike) {
            match e.attacker_side {
                Side::Friend if e.attacker >= 6 => friend_escort += 1,
                Side::Enemy if e.attacker >= 6 => enemy_escort += 1,
                _ => {}
            }
        }
    }
    assert!(friend_escort > 0 && enemy_escort > 0, "{friend_escort} {enemy_escort}");
    // Against a single enemy the friend escort's planes stay home (main fleet only).
    let input = logged(friend, enemy_fleet(), BattleKind::Day);
    for seed in 0..20 {
        assert!(events(&input, seed).iter().all(|e| e.phase != Phase::AirStrike || e.attacker_side != Side::Friend || e.attacker < 6));
    }
}

#[test]
fn night_fleet_is_enemy_escort_or_main() {
    let night_defenders = |enemy: &FleetInput| {
        let input = logged(friend_fleet(), enemy.clone(), BattleKind::NightOnly);
        let mut idx = Vec::new();
        for seed in 0..10 {
            for e in events(&input, seed) {
                assert_eq!(e.phase, Phase::Night);
                idx.push(sides(&e).1);
            }
        }
        assert!(!idx.is_empty());
        idx
    };
    // Healthy escort: score 6 + 1 ≥ 3 → the escort.
    assert!(night_defenders(&enemy_combined()).iter().all(|&i| i >= 6));
    // Escort heavily damaged (0 points) with its flagship afloat (+1) → the main fleet.
    let mut weak = enemy_combined();
    for s in weak.escort.as_mut().unwrap() {
        s.hp = Some(100);
    }
    assert!(night_defenders(&weak).iter().all(|&i| i < 6));
    // Two healthy escort ships (2) + flagship (1) = 3 → the escort.
    for s in &mut weak.escort.as_mut().unwrap()[..2] {
        s.hp = None;
    }
    assert!(night_defenders(&weak).iter().all(|&i| i >= 6));
    // Main fleet sunk → the escort regardless.
    let mut no_main = enemy_combined();
    for s in &mut no_main.ships {
        s.hp = Some(0);
    }
    for s in no_main.escort.as_mut().unwrap() {
        s.hp = Some(100);
    }
    assert!(night_defenders(&no_main).iter().all(|&i| i >= 6));
}

#[test]
fn rank_counts_twelve_enemy_ships() {
    // Main fleet of 1-HP destroyers, unsinkable escort: at most 6 of 12 sunk → never A or S (A
    // needs floor(12 × 0.7) = 8).
    let mut enemy = enemy_combined();
    for s in &mut enemy.ships {
        *s = enemy_dd();
        s.max_hp = 1;
    }
    for s in enemy.escort.as_mut().unwrap() {
        s.max_hp = 5000;
        s.stats.armor = 300.0;
    }
    let s = simulate(&battle(friend_fleet(), enemy, BattleKind::DayNight), 300, 3).unwrap();
    assert_eq!(s.enemy.len(), 12);
    assert_eq!(s.rank_rates.ss + s.rank_rates.s + s.rank_rates.a, 0.0, "{:?}", s.rank_rates);
    assert!(s.rank_rates.b > 0.5, "{:?}", s.rank_rates);
    assert!(s.enemy_flagship_sunk_rate > 0.5);
}

#[test]
fn night_to_day_single_enemy() {
    let mut enemy = enemy_fleet();
    enemy.ships = enemy.ships.into_iter().map(tough).collect();
    let input = logged(friend_fleet(), enemy.clone(), BattleKind::NightToDay);
    for seed in 0..10 {
        let out = run_battle(&input, seed).unwrap();
        assert!(out.result.night_battle);
        let ev = out.result.events.unwrap();
        let first_day = ev.iter().position(|e| e.phase != Phase::Night).expect("day battle follows");
        assert!(first_day > 0 && ev[first_day..].iter().all(|e| e.phase != Phase::Night));
        assert!(ev.iter().any(|e| e.phase == Phase::Shelling1));
        // 20% fuel / 30% ammo, as a day battle with night pursuit.
        let day_night = run_battle(&logged(friend_fleet(), enemy.clone(), BattleKind::DayNight), seed).unwrap();
        assert!(day_night.result.night_battle);
        let (a, b) = (&out.state.friend.ships[0], &day_night.state.friend.ships[0]);
        assert_eq!((a.fuel, a.ammo), (b.fuel, b.ammo));
    }
    // No day battle once the night sank every enemy.
    let mut weak = enemy_fleet();
    weak.ships.truncate(2);
    for s in &mut weak.ships {
        s.max_hp = 1;
    }
    let input = logged(friend_fleet(), weak, BattleKind::NightToDay);
    let mut annihilated = 0;
    for seed in 0..20 {
        let out = run_battle(&input, seed).unwrap();
        if out.result.enemy.iter().all(|s| s.sunk) && out.result.events.as_ref().unwrap().iter().all(|e| e.phase == Phase::Night) {
            annihilated += 1;
        }
        let ev = out.result.events.unwrap();
        if ev.iter().any(|e| e.phase != Phase::Night) {
            // The day battle only started with an enemy afloat after the night.
            let night_sunk = ev.iter().filter(|e| e.phase == Phase::Night && e.attacker_side == Side::Friend && e.defender_hp_after <= 0).count();
            assert!(night_sunk < 2, "seed {seed}");
        }
    }
    assert!(annihilated > 0);
}

#[test]
fn night_to_day_vs_enemy_combined() {
    // Weak escort (no ship above 50%): the day battle follows, against the main fleet only.
    let mut enemy = enemy_combined();
    for s in enemy.escort.as_mut().unwrap() {
        s.hp = Some(250);
    }
    let input = logged(friend_fleet(), enemy, BattleKind::NightToDay);
    let mut day = 0;
    for seed in 0..15 {
        let ev = events(&input, seed);
        let night: Vec<_> = ev.iter().take_while(|e| e.phase == Phase::Night).collect();
        // Night round 1: the enemy escort attacks, round 2: the enemy main fleet.
        let enemy_att: Vec<usize> = night.iter().filter(|e| e.attacker_side == Side::Enemy).map(|e| e.attacker).collect();
        let first_main = enemy_att.iter().position(|&a| a < 6).unwrap_or(enemy_att.len());
        assert!(enemy_att[..first_main].iter().all(|&a| a >= 6) && enemy_att[first_main..].iter().all(|&a| a < 6), "{enemy_att:?}");
        assert!(first_main > 0 && first_main < enemy_att.len());
        for e in &ev[night.len()..] {
            assert_ne!(e.phase, Phase::Night);
            day += 1;
            let (_, en) = sides(e);
            assert!(en < 6, "day part fights the main fleet only: {e:?}");
            assert!(!(e.attacker_side == Side::Enemy && matches!(e.phase, Phase::OpeningTorpedo | Phase::ClosingTorpedo)), "{e:?}");
        }
    }
    assert!(day > 0);
    // Healthy escort (6 ships above 50%): no day battle.
    let input = logged(friend_fleet(), enemy_combined(), BattleKind::NightToDay);
    for seed in 0..5 {
        assert!(events(&input, seed).iter().all(|e| e.phase == Phase::Night));
    }
}

#[test]
fn second_shelling_ignores_escort_battleships() {
    // Carrier combined fleet vs a single enemy without battleships; the only friend battleship is
    // the escort flagship, right after a sunk main-fleet ship (the old `alive().take(escort_start)`
    // counted it).
    let mut friend = friend_combined(CombinedType::Carrier);
    friend.ships = vec![friend_ca(), friend_ca()];
    friend.ships[1].hp = Some(0);
    friend.escort.as_mut().unwrap()[0] = friend_bb();
    let mut enemy = enemy_fleet();
    enemy.ships[0] = enemy_ca();
    enemy.ships = enemy.ships.into_iter().map(tough).collect();
    let input = logged(friend.clone(), enemy.clone(), BattleKind::Day);
    for seed in 0..20 {
        assert!(events(&input, seed).iter().all(|e| e.phase != Phase::Shelling3), "seed {seed}");
    }
    // Control: a main-fleet battleship enables the second main round (api_hougeki3).
    friend.ships[1] = friend_bb();
    let input = logged(friend, enemy, BattleKind::Day);
    assert!((0..20).any(|seed| events(&input, seed).iter().any(|e| e.phase == Phase::Shelling3)));
}

#[test]
fn combined_detection_uses_the_main_fleet() {
    // Blind main fleet (LoS 0, no planes); recon seaplanes and LoS in the escort do not help.
    let mut friend = friend_combined(CombinedType::Surface);
    friend.ships = vec![friend_ca(), friend_ca()];
    for s in &mut friend.ships {
        s.stats.los = Some(0.0);
        s.slots.clear();
    }
    for s in friend.escort.as_mut().unwrap() {
        s.stats.los = Some(80.0);
        s.slots = vec![zero_recon(2)];
    }
    let input = battle(friend.clone(), enemy_fleet(), BattleKind::Day);
    for seed in 0..10 {
        assert_eq!(run_battle(&input, seed).unwrap().result.detection, Detection::NotFound);
    }
    // The same escort as a single fleet detects.
    let single = FleetInput { ships: friend.escort.unwrap(), ..Default::default() };
    assert_ne!(run_battle(&battle(single, enemy_fleet(), BattleKind::Day), 1).unwrap().result.detection, Detection::NotFound);
}

#[test]
fn validation_and_sorties() {
    let err = |i: &BattleInput| run_battle(i, 1).unwrap_err();
    let mut b = battle(friend_fleet(), enemy_combined(), BattleKind::Day);
    b.enemy.formation = Some(Formation::LineAhead);
    assert!(err(&b).contains("needs a combined formation"), "{}", err(&b));
    let mut b = battle(friend_fleet(), enemy_combined(), BattleKind::Day);
    b.enemy.ships.clear();
    assert!(err(&b).contains("at least one ship"), "{}", err(&b));
    let mut b = battle(friend_fleet(), enemy_combined(), BattleKind::Day);
    b.enemy.escort.as_mut().unwrap().push(enemy_dd());
    assert!(err(&b).contains("enemy escort fleet has 7 ships (max 6)"), "{}", err(&b));
    let b = battle(friend_combined(CombinedType::Surface), enemy_combined(), BattleKind::NightToDay);
    assert!(err(&b).contains("nightToDay"), "{}", err(&b));
    let sortie = |friend: FleetInput, kind: &str| -> SortieInput {
        serde_json::from_value(json!({
            "friend": friend,
            "hqLevel": 120,
            "map": {
                "routing": {
                    "map": "9-9", "sources": [{ "id": "t", "note": "test" }],
                    "nodes": { "Start": { "rules": [{ "to": "A" }] }, "A": { "end": true } }
                },
                "nodes": { "A": { "kind": kind, "boss": true, "comps": [{ "weight": 1.0, "fleet": enemy_combined() }] } }
            }
        }))
        .unwrap()
    };
    for kind in ["battle", "night_to_day", "nightToDay"] {
        let s = simulate_sortie(&sortie(friend_fleet(), kind), 30, 1).unwrap();
        assert_eq!(s.nodes["A"].battle_rate, 1.0, "{kind}");
    }
    let e = simulate_sortie(&sortie(friend_combined(CombinedType::Surface), "nightToDay"), 1, 1).unwrap_err();
    assert!(e.contains("nightToDay"), "{e}");
}
