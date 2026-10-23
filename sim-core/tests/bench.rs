//! Throughput check (criterion-free). Run with `cargo test --release -- --nocapture bench`.
mod common;

use common::*;
use sim_core::model::*;
use sim_core::sim::simulate;
use std::time::Instant;

fn rate(input: &BattleInput, count: u32) -> f64 {
    let t = Instant::now();
    let s = simulate(input, count, 2024).unwrap();
    assert_eq!(s.count, count);
    count as f64 / t.elapsed().as_secs_f64()
}

#[test]
fn bench_battles_per_second() {
    let release = !cfg!(debug_assertions);
    let count = if release { 200_000 } else { 5_000 };
    let day = battle(friend_fleet(), enemy_fleet(), BattleKind::Day);
    let day_rate = rate(&day, count);
    let carriers = FleetInput { ships: vec![friend_cv(), friend_cv(), friend_bb(), friend_ca(), friend_dd(), friend_dd()], formation: None, ..Default::default() };
    let night = battle(carriers, enemy_fleet(), BattleKind::DayNight);
    let night_rate = rate(&night, count);
    // Worst case: nobody sinks, every phase runs to the end (6 tough battleships on both sides).
    let tough = |side_friend: bool| {
        let mut s = if side_friend { friend_bb() } else { enemy_bb() };
        s.max_hp = 400;
        s.stats.armor = 150.0;
        s
    };
    let long = battle(
        FleetInput { ships: (0..6).map(|_| tough(true)).collect(), formation: None, ..Default::default() },
        FleetInput { ships: (0..6).map(|_| tough(false)).collect(), formation: None, ..Default::default() },
        BattleKind::DayNight,
    );
    let long_rate = rate(&long, count);
    println!("6v6 day battle:            {:>10.0} battles/s (single thread, {} build)", day_rate, if release { "release" } else { "debug" });
    println!("6v6 carrier day+night:     {:>10.0} battles/s", night_rate);
    println!("6v6 BB day+night, no sink: {:>10.0} battles/s", long_rate);
    if release {
        assert!(day_rate >= 50_000.0, "6v6 day battle: {day_rate:.0} battles/s < 50k");
        assert!(long_rate >= 50_000.0, "6v6 long battle: {long_rate:.0} battles/s < 50k");
    }
}

#[test]
fn bench_sorties_per_second() {
    use sim_core::sortie::{model::SortieInput, simulate_sortie};
    let release = !cfg!(debug_assertions);
    let count = if release { 100_000 } else { 2_000 };
    let time = |input: &SortieInput| {
        let t = Instant::now();
        let s = simulate_sortie(input, count, 7).unwrap();
        (count as f64 / t.elapsed().as_secs_f64(), s.battles_mean)
    };
    // 1-5 with API comps (2 battles per sortie).
    let (r15, b15) = time(&sortie_1_5(fleet_1_5()));
    // Synthetic 5-battle surface map: Start → A → B → C → D → E(boss), 6v6 at every node, night at the boss.
    let mut routing = serde_json::json!({ "map": "9-9", "sources": [{ "id": "t", "note": "bench" }], "nodes": {} });
    let letters = ["Start", "A", "B", "C", "D", "E"];
    let mut nodes = serde_json::Map::new();
    for w in letters.windows(2) {
        routing["nodes"][w[0]] = serde_json::json!({ "rules": [{ "to": w[1] }] });
        nodes.insert(w[1].into(), serde_json::json!({ "kind": "battle", "boss": w[1] == "E", "comps": [{ "weight": 1, "fleet": enemy_fleet() }] }));
    }
    routing["nodes"]["E"] = serde_json::json!({ "end": true });
    let mut friend = friend_fleet();
    for s in &mut friend.ships {
        s.speed = Some(10.0);
    }
    let five: SortieInput = serde_json::from_value(serde_json::json!({
        "friend": friend, "hqLevel": 120, "map": { "routing": routing, "nodes": nodes }
    }))
    .unwrap();
    let (r5, b5) = time(&five);
    println!("1-5 sortie (API comps):    {r15:>10.0} sorties/s ({b15:.2} battles/sortie)");
    println!("5-node 6v6 surface sortie: {r5:>10.0} sorties/s ({b5:.2} battles/sortie)");
}

/// Forward-model grid of the estimator (`hitProbabilityGrid`): one 201 × 101 grid per call.
#[test]
fn bench_hit_probability_grid() {
    use sim_core::query::hit_probability_grid;
    let release = !cfg!(debug_assertions);
    let reps = if release { 2_000 } else { 20 };
    let axis = |n: usize| (0..n).map(|i| i as f64).collect::<Vec<_>>();
    let query = |kind: QueryKind, attacker: ShipInput, defender: ShipInput, side: Side| AttackQuery {
        kind, attacker, defender, attacker_side: Some(side), attacker_formation: None, defender_formation: None, attacker_index: None,
        attacker_fleet_size: None, defender_index: None, defender_fleet_size: None, engagement: None, special: None, night: None, slot: None,
        contact_modifier: None,
    };
    let evasion = |q: AttackQuery| HitGridQuery { query: q, target: GridTarget::Defender, evasion: axis(201), luck: axis(101), hidden_accuracy: vec![] };
    let accuracy = |q: AttackQuery| HitGridQuery { query: q, target: GridTarget::Attacker, evasion: vec![], luck: axis(101), hidden_accuracy: axis(201) };
    let cases = [
        ("shelling, evasion (ev × luck)", evasion(query(QueryKind::Shelling, friend_ca(), enemy_ca(), Side::Friend))),
        ("torpedo, evasion (ev × luck)", evasion(query(QueryKind::Torpedo, friend_dd(), enemy_cl(), Side::Friend))),
        ("night, evasion (ev × luck)", evasion(query(QueryKind::Night, friend_cl(), enemy_dd(), Side::Friend))),
        ("shelling, accuracy (luck × acc)", accuracy(query(QueryKind::Shelling, enemy_bb(), friend_dd(), Side::Enemy))),
        ("torpedo, accuracy (luck × acc)", accuracy(query(QueryKind::Torpedo, enemy_cl(), friend_ca(), Side::Enemy))),
    ];
    for (name, g) in &cases {
        let n = hit_probability_grid(g).unwrap().len();
        let t = Instant::now();
        for _ in 0..reps {
            std::hint::black_box(hit_probability_grid(std::hint::black_box(g)).unwrap());
        }
        println!("grid {name:<32} {:>8.1} µs/call ({n} values)", t.elapsed().as_secs_f64() * 1e6 / reps as f64);
    }
}
