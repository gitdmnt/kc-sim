mod common;

use common::*;
use sim_core::battle::{compute_rank, RankShip};
use sim_core::model::*;
use sim_core::query::{damage_distribution, hit_probability};
use sim_core::sim::{run_battle, simulate};

#[test]
fn deterministic_with_seed() {
    let input = battle(friend_fleet(), enemy_fleet(), BattleKind::DayNight);
    let a = simulate(&input, 500, 42).unwrap();
    let b = simulate(&input, 500, 42).unwrap();
    assert_eq!(a, b);
    let c = simulate(&input, 500, 43).unwrap();
    assert_ne!(a, c);
    let r1 = run_battle(&input, 7).unwrap();
    let r2 = run_battle(&input, 7).unwrap();
    assert_eq!(r1, r2);
}

#[test]
fn sane_outcome_strong_vs_weak() {
    let input = battle(friend_fleet(), enemy_fleet(), BattleKind::DayNight);
    let s = simulate(&input, 2000, 1).unwrap();
    let r = &s.rank_rates;
    let total = r.ss + r.s + r.a + r.b + r.c + r.d + r.e;
    assert!((total - 1.0).abs() < 1e-9);
    // A strong 6-ship fleet should win (S/A) most of the time against a light surface fleet.
    assert!(r.ss + r.s + r.a > 0.8, "{r:?}");
    for sh in s.friend.iter().chain(&s.enemy) {
        let sum = sh.sunk_rate + sh.heavy_rate + sh.moderate_rate + sh.light_rate + sh.healthy_rate;
        assert!((sum - 1.0).abs() < 1e-9);
        assert_eq!(sh.hp_histogram.len() as i32, sh.max_hp + 1);
        assert_eq!(sh.hp_histogram.iter().sum::<u32>(), 2000);
    }
    // Protected friend ships never sink.
    assert_eq!(s.friend_sunk_any_rate, 0.0);
    let mvp: f64 = s.friend.iter().map(|x| x.mvp_rate).sum();
    assert!((mvp - 1.0).abs() < 1e-9);
}

#[test]
fn sinking_protection_rules() {
    // Strong enemy fleet vs weak friend fleet: healthy friends never sink.
    let strong_enemy = FleetInput { ships: vec![enemy_bb(), enemy_bb(), enemy_bb(), enemy_bb(), enemy_bb(), enemy_bb()], formation: None, ..Default::default() };
    let weak = FleetInput { ships: vec![friend_dd(), friend_dd(), friend_dd(), friend_dd()], formation: None, ..Default::default() };
    let s = simulate(&battle(weak.clone(), strong_enemy.clone(), BattleKind::DayNight), 3000, 3).unwrap();
    assert_eq!(s.friend_sunk_any_rate, 0.0);
    assert!(s.friend_heavy_any_rate > 0.3);

    // A non-flagship that starts heavily damaged can sink; a heavily damaged flagship cannot.
    let mut taiha = weak.clone();
    taiha.ships[0].hp = Some(5);
    taiha.ships[1].hp = Some(5);
    let s = simulate(&battle(taiha.clone(), strong_enemy.clone(), BattleKind::DayNight), 3000, 4).unwrap();
    assert_eq!(s.friend[0].sunk_rate, 0.0);
    assert!(s.friend[1].sunk_rate > 0.1, "{}", s.friend[1].sunk_rate);

    // Damage control goddess: the taiha ship never ends sunk and the item is consumed.
    taiha.ships[1].slots.push(damecon_goddess());
    let s = simulate(&battle(taiha.clone(), strong_enemy.clone(), BattleKind::DayNight), 2000, 5).unwrap();
    assert_eq!(s.friend[1].sunk_rate, 0.0);
    let mut used = false;
    for seed in 0..200 {
        let out = run_battle(&battle(taiha.clone(), strong_enemy.clone(), BattleKind::DayNight), seed).unwrap();
        if out.result.friend[1].damecon_used.is_some() {
            used = true;
            assert_eq!(out.result.friend[1].damecon_used, Some(43));
            assert!(out.state.friend.ships[1].slots.iter().all(|e| e.as_ref().map(|e| e.id) != Some(43)));
            assert!(!out.result.friend[1].sunk);
            break;
        }
    }
    assert!(used);
}

#[test]
fn edge_cases_do_not_panic() {
    let kinds = [BattleKind::Day, BattleKind::DayNight, BattleKind::NightOnly];
    let empty = FleetInput { ships: vec![], formation: None, ..Default::default() };
    let subs = FleetInput { ships: vec![enemy_ss(), enemy_ss(), enemy_ss()], formation: Some(Formation::LineAbreast), ..Default::default() };
    let friend_subs = FleetInput { ships: vec![enemy_ss(), enemy_ss()], formation: None, ..Default::default() };
    let one_hp = FleetInput { ships: (0..6).map(|_| {
        let mut s = enemy_dd();
        s.hp = Some(1);
        s
    }).collect(), formation: Some(Formation::Vanguard), ..Default::default() };
    let mut seven = friend_fleet();
    seven.ships.push(friend_dd());
    seven.formation = Some(Formation::Vanguard);
    let mut dead_start = friend_fleet();
    dead_start.ships[3].hp = Some(0);
    let mut no_ammo = friend_fleet();
    for s in &mut no_ammo.ships {
        s.ammo = Some(0);
        s.fuel = Some(0);
    }
    let bare = FleetInput { ships: vec![ship(2, 1.0, 10, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, vec![])], formation: None, ..Default::default() };
    let carriers = FleetInput { ships: vec![friend_cv(), friend_cv(), friend_dd_asw()], formation: Some(Formation::Diamond), ..Default::default() };
    let cases: Vec<(FleetInput, FleetInput)> = vec![
        (friend_fleet(), empty.clone()),
        (friend_fleet(), subs.clone()),
        (friend_subs.clone(), subs.clone()),
        (friend_subs.clone(), enemy_fleet()),
        (friend_fleet(), one_hp.clone()),
        (seven.clone(), enemy_fleet()),
        (dead_start.clone(), enemy_fleet()),
        (no_ammo.clone(), enemy_fleet()),
        (bare.clone(), bare.clone()),
        (carriers.clone(), subs.clone()),
        (carriers.clone(), enemy_fleet()),
    ];
    for (f, e) in &cases {
        for kind in kinds {
            let mut input = battle(f.clone(), e.clone(), kind);
            simulate(&input, 200, 11).unwrap();
            input.options.log = true;
            for seed in 0..20 {
                let out = run_battle(&input, seed).unwrap();
                for (r, sh) in out.result.friend.iter().zip(&out.state.friend.ships) {
                    assert_eq!(Some(r.hp_end), sh.hp);
                    assert!(r.hp_end >= 0 && r.hp_end <= r.max_hp);
                }
            }
        }
    }
    // Empty enemy fleet: nothing happens, perfect S.
    let out = run_battle(&battle(friend_fleet(), empty, BattleKind::Day), 1).unwrap();
    assert_eq!(out.result.rank, Rank::SS);
    // Empty friend fleet / too many ships are input errors.
    assert!(run_battle(&battle(FleetInput::default(), enemy_fleet(), BattleKind::Day), 1).is_err());
    let mut eight = seven;
    eight.ships.push(friend_dd());
    assert!(simulate(&battle(eight, enemy_fleet(), BattleKind::Day), 1, 1).is_err());
    // count 0
    let s = simulate(&battle(friend_fleet(), enemy_fleet(), BattleKind::Day), 0, 1).unwrap();
    assert_eq!(s.count, 0);
}

#[test]
fn subs_only_targetable_by_asw_ships() {
    // Battleship + heavy cruisers cannot attack submarines; the battle ends with no damage dealt.
    let f = FleetInput { ships: vec![friend_bb(), friend_ca()], formation: None, ..Default::default() };
    let e = FleetInput { ships: vec![enemy_ss(), enemy_ss()], formation: None, ..Default::default() };
    let mut input = battle(f, e, BattleKind::DayNight);
    input.options.log = true;
    for seed in 0..50 {
        let out = run_battle(&input, seed).unwrap();
        let ev = out.result.events.unwrap();
        assert!(ev.iter().all(|e| e.attacker_side == Side::Enemy), "friend BB/CA attacked a submarine");
        assert!(out.result.enemy.iter().all(|s| s.hp_end == s.max_hp));
    }
    // ASW destroyers do opening ASW and shell submarines.
    let f = FleetInput { ships: vec![friend_dd_asw(), friend_dd_asw()], formation: Some(Formation::LineAbreast), ..Default::default() };
    let e = FleetInput { ships: vec![enemy_ss(), enemy_ss()], formation: None, ..Default::default() };
    let mut input = battle(f, e, BattleKind::Day);
    input.options.log = true;
    let out = run_battle(&input, 3).unwrap();
    let ev = out.result.events.unwrap();
    assert!(ev.iter().any(|e| e.phase == Phase::OpeningAsw && e.kind == AttackKind::Asw));
    // Torpedoes never target submarines.
    assert!(ev.iter().filter(|e| e.kind == AttackKind::Torpedo).all(|e| e.attacker_side == Side::Enemy));
}

#[test]
fn phases_and_air_state() {
    let f = FleetInput { ships: vec![friend_cv(), friend_cv(), friend_bb(), friend_bb(), friend_dd(), friend_dd()], formation: None, ..Default::default() };
    let mut input = battle(f, enemy_fleet(), BattleKind::DayNight);
    let s = simulate(&input, 300, 9).unwrap();
    // Enemy has no aircraft: supremacy every time.
    assert_eq!(s.air_state_rates.supremacy, 1.0);
    input.options.log = true;
    let mut phases = std::collections::HashSet::new();
    // Closing torpedoes are rare here (~1% of battles: the friend fleet usually sinks everything first).
    for seed in 0..400 {
        let out = run_battle(&input, seed).unwrap();
        for e in out.result.events.unwrap() {
            phases.insert(format!("{:?}", e.phase));
            // Proficiency accuracy is added after the 96% cap, so plane attacks may reach 100%.
            let cap = if matches!(e.kind, AttackKind::Air) || (e.kind == AttackKind::Shelling && e.attacker_side == Side::Friend && e.attacker < 2) { 1.0 } else { 0.97 };
            assert!(e.p_hit >= e.p_crit && e.p_hit <= cap + 1e-12, "{e:?}");
        }
    }
    for p in ["AirStrike", "Shelling1", "Shelling2", "ClosingTorpedo"] {
        assert!(phases.contains(p), "missing phase {p}: {phases:?}");
    }
    // No aircraft at all: air state none.
    let s = simulate(&battle(FleetInput { ships: vec![friend_dd()], formation: None, ..Default::default() }, enemy_fleet(), BattleKind::Day), 50, 1).unwrap();
    assert_eq!(s.air_state_rates.none, 1.0);
}

#[test]
fn engagement_distribution() {
    let input = battle(FleetInput { ships: vec![friend_dd()], formation: None, ..Default::default() }, FleetInput { ships: vec![], formation: None, ..Default::default() }, BattleKind::Day);
    let mut counts = std::collections::HashMap::new();
    for seed in 0..20000 {
        let out = run_battle(&input, seed).unwrap();
        *counts.entry(format!("{:?}", out.result.engagement)).or_insert(0) += 1;
    }
    let rate = |k: &str| *counts.get(k).unwrap_or(&0) as f64 / 20000.0;
    assert!((rate("SameCourse") - 0.45).abs() < 0.02);
    assert!((rate("TAdvantage") - 0.15).abs() < 0.015);
    assert!((rate("HeadOn") - 0.30).abs() < 0.02);
    assert!((rate("TDisadvantage") - 0.10).abs() < 0.015);
}

#[test]
fn supply_and_morale_chain() {
    let mut friend = friend_fleet();
    let enemy = enemy_fleet();
    let ammo_max = friend.ships[0].ammo_max.unwrap();
    let fuel_max = friend.ships[0].fuel_max.unwrap();
    let mut expected_fuel = fuel_max;
    let mut expected_ammo = ammo_max;
    for node in 0..3u64 {
        let out = run_battle(&battle(friend.clone(), enemy.clone(), BattleKind::Day), node).unwrap();
        expected_fuel -= (fuel_max as f64 * 0.2).floor() as i32;
        expected_ammo -= (ammo_max as f64 * 0.2).floor() as i32;
        let bb = &out.state.friend.ships[0];
        assert_eq!(bb.fuel, Some(expected_fuel));
        assert_eq!(bb.ammo, Some(expected_ammo));
        // morale: 49 - 3 + rank bonus + flagship 3 (+ MVP 10)
        let m = bb.morale.unwrap();
        assert!(m >= 0 && m <= 100);
        friend = out.state.friend;
    }
    // Night pursuit costs extra ceil(10%) ammo.
    let out = run_battle(&battle(friend_fleet(), FleetInput { ships: vec![enemy_bb()], formation: None, ..Default::default() }, BattleKind::DayNight), 1).unwrap();
    if out.result.night_battle {
        let bb = &out.state.friend.ships[0];
        assert_eq!(bb.ammo, Some(ammo_max - (ammo_max as f64 * 0.2).floor() as i32 - (ammo_max as f64 * 0.1).ceil() as i32));
    }
    // Submarine-only enemy: 8% fuel, no ammo.
    let f = FleetInput { ships: vec![friend_dd_asw()], formation: None, ..Default::default() };
    let out = run_battle(&battle(f, FleetInput { ships: vec![enemy_ss()], formation: None, ..Default::default() }, BattleKind::Day), 1).unwrap();
    let dd = &out.state.friend.ships[0];
    assert_eq!(dd.fuel, Some(100 - 8));
    assert_eq!(dd.ammo, Some(100));
    // Morale example: flagship of an S-rank battle with morale 49 and MVP: 49 - 3 + 4 + 3 + 10 = 63.
    let mut solo = FleetInput { ships: vec![friend_bb()], formation: None, ..Default::default() };
    solo.ships[0].morale = Some(49);
    let weak = FleetInput { ships: vec![{
        let mut s = enemy_dd();
        s.hp = Some(1);
        s
    }], formation: None, ..Default::default() };
    let out = run_battle(&battle(solo, weak, BattleKind::Day), 2).unwrap();
    if matches!(out.result.rank, Rank::S | Rank::SS) {
        assert_eq!(out.state.friend.ships[0].morale, Some(63));
    }
}

#[test]
fn combined_battles_judge_morale_before_the_entry_cost() {
    // wikiwiki 疲労度: the day battle's −3 is taken before combat (51 → 48, not sparkled), but with a
    // combined fleet on either side the state is judged first (51 fights sparkled: enemy accuracy × 0.7).
    let mut friend = FleetInput { ships: vec![friend_bb(), friend_bb()], formation: None, ..Default::default() };
    friend.ships[0].morale = Some(51);
    friend.ships[1].morale = Some(49);
    // Enemy day-shelling p_hit on the morale-51 and the morale-49 ship by the same attacker.
    let p_hit = |enemy: FleetInput| {
        let mut b = battle(friend.clone(), enemy, BattleKind::Day);
        b.options.log = true;
        let mut p: std::collections::HashMap<usize, [Option<f64>; 2]> = Default::default();
        for seed in 0..60 {
            for e in run_battle(&b, seed).unwrap().result.events.unwrap() {
                if e.attacker_side == Side::Enemy && e.kind == AttackKind::Shelling && e.special == SpecialAttack::Normal {
                    p.entry(e.attacker).or_default()[e.defender] = Some(e.p_hit);
                }
            }
        }
        p.into_values().find_map(|[a, b]| Some((a?, b?))).unwrap()
    };
    let (single51, single49) = p_hit(FleetInput { ships: vec![enemy_bb()], formation: None, ..Default::default() });
    assert_eq!(single51, single49);
    let combined = FleetInput { ships: vec![enemy_bb()], escort: Some(vec![enemy_bb()]), formation: None, ..Default::default() };
    let (comb51, comb49) = p_hit(combined);
    assert!(comb51 < comb49, "{comb51} vs {comb49}");
}

#[test]
fn atoll_nodes_turn_the_opening_torpedo_into_tank_attacks() {
    // kcsim `torpedoPhase` with `useAtoll` (62-3 X packets: a submarine fires once per 特四式内火艇, none without).
    let sub = |tanks: usize| {
        let mut slots = vec![eq(213, 32, 5, st(0.0, 15.0, 0.0, 0.0))];
        slots.extend((0..tanks).map(|_| eq(525, 46, 36, st(0.0, 1.0, 1.0, 0.0))));
        ship(13, 80.0, 30, 0.0, 60.0, 0.0, 10.0, 40.0, 0.0, 20.0, slots)
    };
    let friend = FleetInput { ships: vec![sub(0), sub(1), sub(2)], formation: None, ..Default::default() };
    let shots = |atoll: bool| {
        let mut b = battle(friend.clone(), enemy_fleet(), BattleKind::Day);
        b.options.log = true;
        b.options.atoll = atoll;
        let mut n = [0; 3];
        for e in run_battle(&b, 1).unwrap().result.events.unwrap() {
            if e.phase == Phase::OpeningTorpedo && e.attacker_side == Side::Friend {
                n[e.attacker] += 1;
            }
        }
        n
    };
    assert_eq!(shots(false), [1, 1, 1]);
    assert_eq!(shots(true), [0, 1, 2]);
}

#[test]
fn ammo_penalty_reduces_damage() {
    let input = battle(friend_fleet(), enemy_fleet(), BattleKind::Day);
    let full = simulate(&input, 2000, 21).unwrap();
    let mut low = friend_fleet();
    for s in &mut low.ships {
        let max = s.ammo_max.unwrap_or(100);
        s.ammo = Some(max / 5); // 20% ammo -> x0.4 damage
    }
    let half = simulate(&battle(low, enemy_fleet(), BattleKind::Day), 2000, 21).unwrap();
    let dealt = |s: &SimulationSummary| s.friend.iter().map(|x| x.damage_dealt_mean).sum::<f64>();
    assert!(dealt(&half) < dealt(&full) * 0.8, "{} vs {}", dealt(&half), dealt(&full));
}

#[test]
fn rank_rules() {
    let s = |start: i32, end: i32, max: i32| RankShip { start, end, max };
    let full6 = |end: [i32; 6]| end.iter().map(|&e| s(30, e, 30)).collect::<Vec<_>>();
    let friend_ok = vec![s(50, 50, 50), s(40, 40, 40)];
    // SS: all enemies sunk, no damage taken; S: some damage taken.
    assert_eq!(compute_rank(&friend_ok, &full6([0; 6])).0, Rank::SS);
    assert_eq!(compute_rank(&[s(50, 49, 50), s(40, 40, 40)], &full6([0; 6])).0, Rank::S);
    // A: >= floor(0.7 * 6) = 4 sunk.
    assert_eq!(compute_rank(&friend_ok, &full6([30, 30, 0, 0, 0, 0])).0, Rank::A);
    // 3 of 6 sunk, flagship sunk, no friend sunk -> B.
    assert_eq!(compute_rank(&friend_ok, &full6([0, 30, 30, 0, 0, 30])).0, Rank::B);
    // 3 sunk, flagship alive, gauge 50% vs 0% -> B (gauge).
    assert_eq!(compute_rank(&friend_ok, &full6([30, 30, 30, 0, 0, 0])).0, Rank::B);
    // Gauges: enemy 20% vs friend 10% -> C (20 <= 25, 20 > 9).
    let f = vec![s(100, 90, 100)];
    let e = vec![s(100, 80, 100), s(100, 100, 100)];
    let f2 = vec![s(100, 90, 100), s(100, 90, 100)];
    let e2 = vec![s(100, 60, 100), s(100, 100, 100)];
    assert_eq!(compute_rank(&f2, &e2), (Rank::C, 20, 10));
    assert_eq!(compute_rank(&f2, &[s(100, 40, 100), s(100, 100, 100)]).0, Rank::B); // 30 > 25
    assert_eq!(compute_rank(&f2, &[s(200, 190, 200)]).0, Rank::D); // 5 <= 9
    // Single-ship fleet with a heavily damaged flagship -> D even if gauges favour it.
    assert_eq!(compute_rank(&[s(100, 20, 100)], &e).0, Rank::D);
    // Single healthy ship, gauges 10% vs 10%: not > 25, but > 9 -> C.
    assert_eq!(compute_rank(&f, &e).0, Rank::C);
    // E: all but one friend ship sunk.
    let f3 = vec![s(30, 30, 30), s(30, 0, 30), s(30, 0, 30)];
    assert_eq!(compute_rank(&f3, &[s(100, 100, 100)]).0, Rank::E);
    // Friend sunk blocks S/A even if all enemies sunk.
    assert_eq!(compute_rank(&[s(30, 30, 30), s(30, 0, 30)], &[s(30, 0, 30)]).0, Rank::C);
}

#[test]
fn forward_model_matches_engine() {
    // 1) The probabilities logged by the engine predict its own hit frequency.
    let mut input = battle(friend_fleet(), enemy_fleet(), BattleKind::DayNight);
    input.options.log = true;
    let (mut expected, mut observed, mut n) = (0.0f64, 0.0f64, 0.0f64);
    for seed in 0..400 {
        let out = run_battle(&input, seed).unwrap();
        for e in out.result.events.unwrap() {
            expected += e.p_hit;
            observed += if e.hit == HitResult::Miss { 0.0 } else { 1.0 };
            n += 1.0;
        }
    }
    let sd = (n * 0.25).sqrt();
    assert!((expected - observed).abs() < 4.0 * sd, "expected {expected} observed {observed} n {n}");

    // 2) hitProbability reproduces the pHit of a logged enemy shelling attack exactly.
    let mut found = false;
    'outer: for seed in 0..200 {
        let out = run_battle(&input, seed).unwrap();
        for e in out.result.events.unwrap() {
            if e.phase == Phase::Shelling1 && e.attacker_side == Side::Enemy && e.kind == AttackKind::Shelling && e.special == SpecialAttack::Normal {
                let q = AttackQuery {
                    kind: QueryKind::Shelling,
                    attacker: input.enemy.ships[e.attacker].clone(),
                    defender: input.friend.ships[e.defender].clone(),
                    attacker_side: Some(Side::Enemy),
                    attacker_formation: input.enemy.formation,
                    defender_formation: input.friend.formation,
                    attacker_index: Some(e.attacker),
                    attacker_fleet_size: Some(input.enemy.ships.len()),
                    defender_index: Some(e.defender),
                    defender_fleet_size: Some(input.friend.ships.len()),
                    engagement: Some(out.result.engagement),
                    special: None,
                    night: None,
                    slot: None,
                    contact_modifier: None,
                    attacker_bonus: None,
                    defender_bonus: None,
                };
                let hp = hit_probability(&q).unwrap();
                assert!((hp.p_hit - e.p_hit).abs() < 1e-12 && (hp.p_crit - e.p_crit).abs() < 1e-12);
                found = true;
                break 'outer;
            }
        }
    }
    assert!(found);
}

#[test]
fn damage_distribution_shape() {
    let mut defender = enemy_ca();
    defender.stats.armor = 50.0;
    defender.slots.clear();
    let q = AttackQuery {
        kind: QueryKind::Shelling,
        attacker: friend_bb(),
        defender,
        attacker_side: None,
        attacker_formation: None,
        defender_formation: None,
        attacker_index: Some(1),
        attacker_fleet_size: None,
        defender_index: Some(2),
        defender_fleet_size: None,
        engagement: None,
        special: None,
        night: None,
        slot: None,
        contact_modifier: None,
        attacker_bonus: None,
        defender_bonus: None,
    };
    let d = damage_distribution(&q).unwrap();
    let total: f64 = d.hit.iter().map(|p| p.p).sum();
    assert!((total - 1.0).abs() < 1e-9);
    // BB: FP 82 + 2x20 + 8 = 130, +5 = 135 basic, AP mod vs CA x1.08 -> floor(145.8) = 145.
    // armor 50: damage in [floor(145 - 35 - 29.4), floor(145 - 35)] = [80, 110].
    assert_eq!(d.hit.first().unwrap().damage, 80);
    assert_eq!(d.hit.last().unwrap().damage, 110);
    assert!(d.mean_critical > d.mean_hit);
    let hp = hit_probability(&q).unwrap();
    assert!(hp.p_hit > 0.5 && hp.p_hit <= 0.97 && hp.p_crit > 0.0);
}

#[test]
fn air_proficiency_accuracy_leaves_out_empty_slots() {
    // wikiwiki 命中と回避について (艦載機熟練度命中補正): a slot without planes is not part of the average proficiency.
    let mut attacker = friend_cv();
    attacker.slots = vec![tb_ryuusei(18), plane(24, 7, 7, EquipmentStats { bombing: Some(8.0), ..Default::default() }, 0, 0)];
    let q = AttackQuery {
        kind: QueryKind::Air,
        attacker,
        defender: enemy_dd(),
        attacker_side: None,
        attacker_formation: None,
        defender_formation: None,
        attacker_index: None,
        attacker_fleet_size: None,
        defender_index: None,
        defender_fleet_size: None,
        engagement: None,
        special: None,
        night: None,
        slot: None,
        contact_modifier: None,
        attacker_bonus: None,
        defender_bonus: None,
    };
    // Dodge ⌊20 + √10⌋ = 23: 95 − 23 = 72, + 12 for the rank-7 slot alone (with the empty slot: + 5) → 85%.
    assert_eq!(hit_probability(&q).unwrap().p_hit, 0.85);
}
