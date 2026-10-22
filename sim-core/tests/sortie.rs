//! Sortie simulator: 1-5 end-to-end with comps from the server API fixture, policies, gauges.
mod common;

use common::*;
use serde_json::json;
use sim_core::model::*;
use sim_core::sortie::model::*;
use sim_core::sortie::simulate_sortie;

#[test]
fn sortie_1_5_end_to_end() {
    let input = sortie_1_5(fleet_1_5());
    let s = simulate_sortie(&input, 3000, 1).unwrap();
    println!(
        "1-5: boss reach {:.3} S+ {:.3} kill {:.3} flagship sunk {:.3} retreat {:.3} battles {:.2} fuel {:.1} ammo {:.1}",
        s.boss.reach_rate,
        s.boss.rank_rates.ss + s.boss.rank_rates.s,
        s.boss.kill_rate,
        s.boss.flagship_sunk_rate,
        s.retreat_rate,
        s.battles_mean,
        s.fuel_used_mean,
        s.ammo_used_mean
    );
    for p in &s.paths {
        println!("  {:.3} {}", p.rate, p.path.join("-"));
    }
    // CL + 3 DD always routes Start-A-D-F-G-J; only F and J have comps (A/D are warned and skipped).
    assert_eq!(s.paths[0].path.join("-"), "Start-A-D-F-G-J");
    assert!(s.paths.iter().all(|p| p.path.starts_with(&["Start".into(), "A".into(), "D".into(), "F".into()])));
    assert!(s.warnings.iter().any(|w| w.contains("node A: battle node without enemy comps")), "{:?}", s.warnings);
    assert_eq!(s.nodes["F"].reach_rate, 1.0);
    assert_eq!(s.nodes["F"].battle_rate, 1.0);
    assert_eq!(s.nodes["A"].battle_rate, 0.0);
    assert_eq!(s.nodes["G"].battle_rate, 0.0);
    let reached = s.nodes["J"].reach_rate;
    assert!((reached + s.nodes["F"].retreat_rate - 1.0).abs() < 1e-9);
    assert!((s.boss.reach_rate - reached).abs() < 1e-12);
    assert!(s.boss.reach_rate > 0.9, "{}", s.boss.reach_rate);
    assert!(s.boss.kill_rate > 0.8, "{}", s.boss.kill_rate);
    let r = &s.boss.rank_rates;
    assert!((r.ss + r.s + r.a + r.b + r.c + r.d + r.e - 1.0).abs() < 1e-9);
    // Taiha retreat ⇒ nobody sinks; formation vs all-sub comps is line abreast (no crash).
    assert_eq!(s.sunk_rate, 0.0);
    assert!((s.battles_mean - (1.0 + s.boss.reach_rate)).abs() < 1e-9);
    // Supply: CL 15/20 max → F: 3 fuel; sub-only enemy ⇒ 0 ammo.
    assert!(s.fuel_used_mean > 0.0 && s.ammo_used_mean == 0.0);
    assert_eq!(s.friend.len(), 4);
}

#[test]
fn sortie_is_deterministic() {
    let input = sortie_1_5(fleet_1_5());
    assert_eq!(simulate_sortie(&input, 500, 9).unwrap(), simulate_sortie(&input, 500, 9).unwrap());
    assert_ne!(simulate_sortie(&input, 500, 9).unwrap(), simulate_sortie(&input, 500, 10).unwrap());
}

#[test]
fn retreat_policy() {
    // Four fragile destroyers without ASW gear: subs hurt them, nobody can fight back.
    let weak = || {
        let mut s = ship(2, 1.0, 16, 10.0, 20.0, 9.0, 5.0, 10.0, 0.0, 5.0, vec![]);
        s.speed = Some(10.0);
        s
    };
    let fleet = FleetInput { ships: vec![weak(), weak(), weak(), weak()], formation: None };
    let mut input = sortie_1_5(fleet);
    let s = simulate_sortie(&input, 3000, 2).unwrap();
    assert!(s.retreat_rate > 0.05, "{}", s.retreat_rate);
    assert!(s.nodes["F"].retreat_heavy_rate > 0.0);
    assert_eq!(s.sunk_rate, 0.0);
    // Without taiha retreat, a ship that enters J heavily damaged can sink.
    input.policy.retreat.on_heavy = false;
    let s = simulate_sortie(&input, 3000, 2).unwrap();
    assert!(s.sunk_rate > 0.0, "{}", s.sunk_rate);
    assert!(s.friend.iter().skip(1).any(|f| f.sunk_rate > 0.0));
    assert_eq!(s.friend[0].sunk_rate, 0.0);
    // Moderate-damage retreat retreats at least as often as heavy-only.
    input.policy.retreat = RetreatPolicy { on_heavy: true, allow_damecon: true, on_moderate: true };
    let m = simulate_sortie(&input, 3000, 2).unwrap();
    assert!(m.retreat_rate >= s.retreat_rate);
    assert!(m.nodes["F"].retreat_moderate_rate > 0.0);
}

#[test]
fn gauges() {
    let mut input = sortie_1_5(fleet_1_5());
    input.gauge = Some(GaugeInput { kind: GaugeKind::Kill, remaining: 4.0, final_comps: None, final_threshold: None, runs: None, max_sorties: None });
    let s = simulate_sortie(&input, 2000, 3).unwrap();
    let g = s.gauge.as_ref().unwrap();
    let expected = 4.0 / s.boss.kill_rate;
    assert!((g.expected_sorties.unwrap() - expected).abs() < 0.15 * expected, "{g:?} vs {expected}");
    assert!(g.p50_sorties.unwrap() <= g.p90_sorties.unwrap());
    // HP gauge: 300 HP with the boss comps as final form.
    input.gauge = Some(GaugeInput { kind: GaugeKind::Hp, remaining: 300.0, final_comps: None, final_threshold: None, runs: Some(100), max_sorties: None });
    let s = simulate_sortie(&input, 500, 4).unwrap();
    let g = s.gauge.as_ref().unwrap();
    println!("hp gauge: {g:?}, flagship damage mean {:.1}", s.boss.flagship_damage_mean);
    let e = g.expected_sorties.unwrap();
    assert!(e > 1.0 && e < 50.0, "{e}");
    assert_eq!(g.capped_rate, 0.0);
}

#[test]
fn node_kinds_and_warnings() {
    // Start → A (air raid) → B (night battle) → C (boss day battle, end); D unknown kind, unused.
    let routing = json!({
        "map": "9-9", "sources": [{ "id": "t", "note": "test" }],
        "nodes": { "Start": { "rules": [{ "to": "A" }] }, "A": { "rules": [{ "to": "B" }] },
                   "B": { "rules": [{ "to": "C" }] }, "C": { "end": true }, "D": { "end": true } }
    });
    let mut cv = friend_cv();
    cv.max_hp = 90;
    let enemy_cv = FleetInput { ships: vec![cv, enemy_dd()], formation: Some(Formation::LineAhead) };
    let comp = |f: FleetInput| json!([{ "weight": 1.0, "fleet": f }]);
    let input: SortieInput = serde_json::from_value(json!({
        "friend": friend_fleet(),
        "hqLevel": 100,
        "map": { "routing": routing, "nodes": {
            "Start": { "kind": "start" },
            "A": { "kind": "air_raid", "comps": comp(enemy_cv) },
            "B": { "kind": "nightBattle", "comps": comp(enemy_fleet()) },
            "C": { "kind": "boss", "comps": comp(enemy_fleet()) },
            "D": { "kind": "mystery" }
        } },
        "policy": { "night": "never", "formations": { "C": "doubleLine" } }
    }))
    .unwrap();
    let s = simulate_sortie(&input, 500, 5).unwrap();
    assert_eq!(s.nodes["A"].battle_rate, 1.0);
    assert!(s.nodes["B"].battle_rate > 0.0);
    assert!(s.nodes["B"].night_rate == 1.0);
    assert_eq!(s.nodes["C"].night_rate, 0.0);
    assert!(s.boss.reach_rate > 0.0);
    // Unknown kinds are only warned about when reached.
    assert!(!s.warnings.iter().any(|w| w.contains("node D")));
    assert!(s.warnings.iter().any(|w| w.contains("speed")), "{:?}", s.warnings);
    // An unknown predicate is an input error.
    let mut bad = input.clone();
    bad.map.routing["nodes"]["A"]["rules"] = json!([{ "when": { "m": "luck" }, "to": "B" }, { "to": "C" }]);
    assert!(simulate_sortie(&bad, 1, 1).unwrap_err().contains("unknown predicate metric 'luck'"));
    // An unknown kind at a reached node is treated as empty and warned.
    let mut odd = input;
    odd.map.routing["nodes"]["A"]["rules"] = json!([{ "to": "D" }]);
    odd.map.routing["nodes"]["D"] = json!({ "rules": [{ "to": "B" }] });
    let s = simulate_sortie(&odd, 50, 1).unwrap();
    assert!(s.warnings.iter().any(|w| w.contains("node D: unknown kind")), "{:?}", s.warnings);
    assert!((s.nodes["D"].reach_rate - (1.0 - s.nodes["A"].retreat_rate)).abs() < 1e-12);
    assert_eq!(s.nodes["D"].battle_rate, 0.0);
}

#[test]
fn max_nodes_guard() {
    let routing = json!({
        "map": "9-9", "sources": [{ "id": "t", "note": "test" }],
        "nodes": { "Start": { "rules": [{ "to": "A" }] }, "A": { "rules": [{ "to": "B" }] }, "B": { "rules": [{ "to": "A" }] } }
    });
    let input: SortieInput = serde_json::from_value(json!({
        "friend": friend_fleet(), "hqLevel": 100, "maxNodes": 7,
        "map": { "routing": routing, "nodes": { "A": { "kind": "empty" }, "B": { "kind": "empty" } } }
    }))
    .unwrap();
    let s = simulate_sortie(&input, 10, 1).unwrap();
    assert_eq!(s.nodes_mean, 7.0);
    assert!(s.warnings.iter().any(|w| w.contains("maxNodes")));
}
