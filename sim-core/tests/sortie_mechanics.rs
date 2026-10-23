//! Sortie mechanics beyond routing and battles: command-facility evacuation, striking forces,
//! advance choices, node supply costs, underway replenishment, rations, anchorage repair,
//! land-base cost, landing nodes and the kill-gauge criterion.
mod common;

use common::*;
use serde_json::{json, Value};
use sim_core::model::*;
use sim_core::sortie::model::*;
use sim_core::sortie::simulate_sortie;

fn map3() -> Value {
    json!({
        "map": "9-9", "sources": [{ "id": "t", "note": "test" }],
        "nodes": { "Start": { "rules": [{ "to": "A" }] }, "A": { "rules": [{ "to": "B" }] }, "B": { "end": true } }
    })
}

/// An enemy that cannot hurt anyone in an air battle (no planes).
fn harmless() -> Value {
    json!([{ "weight": 1.0, "fleet": { "ships": [ship(2, 1.0, 24, 0.0, 0.0, 0.0, 7.0, 20.0, 0.0, 5.0, vec![])] } }])
}

/// Start → A (air battle, harmless) → B (boss, `boss` comps).
fn input(friend: FleetInput, boss: Value, extra: Value) -> SortieInput {
    let mut v = json!({
        "friend": friend, "hqLevel": 120,
        "map": { "routing": map3(), "nodes": {
            "Start": { "kind": "start" },
            "A": { "kind": "airBattle", "comps": harmless() },
            "B": { "kind": "boss", "comps": boss }
        } },
        "policy": { "night": "never" }
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn fcf_equip(id: u32) -> Option<EquipmentInput> {
    eq(id, 34, 28, EquipmentStats::default())
}

fn taiha(s: &mut ShipInput) {
    s.hp = Some(s.max_hp / 5);
}

fn weak_boss() -> Value {
    json!([{ "weight": 1.0, "fleet": { "ships": [enemy_dd()] } }])
}

#[test]
fn combined_fcf_evacuates_with_an_escort_destroyer() {
    let mut main = vec![friend_bb(), friend_bb(), friend_ca(), friend_ca(), friend_ca(), friend_ca()];
    main[0].slots[3] = fcf_equip(107);
    taiha(&mut main[2]);
    main[2].fuel_max = Some(40);
    let escort = vec![friend_cl(), friend_ca(), friend_ca(), friend_dd(), friend_dd(), friend_dd()];
    let fleet = FleetInput { ships: main, escort: Some(escort), combined: Some(CombinedType::Surface), formation: None };
    let s = simulate_sortie(&input(fleet.clone(), weak_boss(), json!({})), 100, 1).unwrap();
    // The heavily damaged CA leaves with the first escort DD (escort #4 = friend index 9).
    assert_eq!(s.fcf_rate, 1.0);
    assert_eq!(s.nodes["A"].fcf_rate, 1.0);
    assert_eq!(s.nodes["B"].reach_rate, 1.0);
    assert_eq!(s.friend[2].evacuated_rate, 1.0);
    assert_eq!(s.friend[9].evacuated_rate, 1.0);
    assert_eq!(s.friend[10].evacuated_rate, 0.0);
    // Evacuated ships fight no more: they come home with an empty fuel tank.
    assert_eq!(s.friend[2].fuel_used_mean, 40.0);
    assert_eq!(s.friend[2].damage_taken_mean, 0.0);
    // Without the facility (or with useFcf off) the sortie ends at A.
    let mut off = input(fleet.clone(), weak_boss(), json!({}));
    off.policy.retreat.use_fcf = false;
    let s = simulate_sortie(&off, 50, 1).unwrap();
    assert_eq!((s.fcf_rate, s.nodes["A"].retreat_heavy_rate, s.nodes["B"].reach_rate), (0.0, 1.0, 0.0));
    // Two heavily damaged ships: one evacuation is not enough.
    let mut two = fleet.clone();
    taiha(&mut two.ships[3]);
    let s = simulate_sortie(&input(two, weak_boss(), json!({})), 50, 1).unwrap();
    assert_eq!((s.fcf_rate, s.nodes["B"].reach_rate), (0.0, 0.0));
    // No healthy escort destroyer: no evacuation.
    let mut no_dd = fleet;
    for s in no_dd.escort.as_mut().unwrap().iter_mut().skip(3) {
        s.hp = Some(s.max_hp * 7 / 10);
    }
    let s = simulate_sortie(&input(no_dd, weak_boss(), json!({})), 50, 1).unwrap();
    assert_eq!(s.fcf_rate, 0.0);
}

#[test]
fn striking_force_fcf_and_routing() {
    let mut ships = vec![friend_bb(), friend_bb(), friend_ca(), friend_ca(), friend_cl(), friend_dd(), friend_dd()];
    ships[0].slots[3] = fcf_equip(272);
    taiha(&mut ships[4]);
    let max = ships[4].max_hp;
    let fleet = FleetInput { ships, formation: None, ..Default::default() };
    let s = simulate_sortie(&input(fleet.clone(), weak_boss(), json!({})), 50, 1).unwrap();
    assert_eq!((s.fcf_rate, s.nodes["B"].reach_rate, s.friend[4].evacuated_rate), (1.0, 1.0, 1.0));
    // The evacuated ship loses 20 % of its max HP on the way home (kcsim `canContinue`).
    let hp0 = max / 5;
    assert_eq!(s.friend[4].damage_taken_mean, (hp0 - (hp0 - max / 5).max(1)) as f64);
    // Routing sees a striking force (7 ships, or `striking: true` with fewer).
    let routing = json!({
        "map": "9-9", "sources": [{ "id": "t", "note": "test" }],
        "nodes": { "Start": { "rules": [{ "when": { "m": "fleetType", "in": ["striking"] }, "to": "A" }, { "to": "B" }] },
                   "A": { "end": true }, "B": { "end": true } }
    });
    let mut i = input(fleet.clone(), weak_boss(), json!({}));
    i.map.routing = routing.clone();
    assert_eq!(simulate_sortie(&i, 10, 1).unwrap().nodes["A"].reach_rate, 1.0);
    let mut six = fleet;
    six.ships.pop();
    let mut i = input(six, weak_boss(), json!({}));
    i.map.routing = routing;
    assert_eq!(simulate_sortie(&i, 10, 1).unwrap().nodes["B"].reach_rate, 1.0);
    i.striking = Some(true);
    assert_eq!(simulate_sortie(&i, 10, 1).unwrap().nodes["A"].reach_rate, 1.0);
}

#[test]
fn torpedo_squadron_hq_drops_fuel_and_ammo() {
    let mut ships = vec![friend_cl(), friend_dd(), friend_dd(), friend_dd(), friend_dd(), friend_dd()];
    ships[0].slots[2] = fcf_equip(413);
    taiha(&mut ships[2]);
    ships[2].ammo_max = Some(20);
    let s = simulate_sortie(&input(FleetInput { ships: ships.clone(), formation: None, ..Default::default() }, weak_boss(), json!({})), 30, 1).unwrap();
    assert_eq!(s.fcf_rate, 1.0);
    assert_eq!(s.friend[2].ammo_used_mean, 20.0);
    // A battleship in the fleet: not a torpedo squadron.
    ships[5] = friend_bb();
    let s = simulate_sortie(&input(FleetInput { ships, formation: None, ..Default::default() }, weak_boss(), json!({})), 30, 1).unwrap();
    assert_eq!(s.fcf_rate, 0.0);
}

#[test]
fn advance_choices() {
    let i = input(friend_fleet(), weak_boss(), json!({ "policy": { "night": "never", "advance": { "A": "retreat" } } }));
    let s = simulate_sortie(&i, 20, 1).unwrap();
    assert_eq!((s.retreat_rate, s.nodes["A"].retreat_rate, s.nodes["B"].reach_rate), (1.0, 1.0, 0.0));
    // Push on with a heavily damaged ship; the flagship's heavy damage still ends the sortie.
    let mut f = friend_fleet();
    taiha(&mut f.ships[3]);
    let i = input(f.clone(), weak_boss(), json!({ "policy": { "night": "never", "advance": { "A": "push" } } }));
    assert_eq!(simulate_sortie(&i, 20, 1).unwrap().nodes["B"].reach_rate, 1.0);
    taiha(&mut f.ships[0]);
    let i = input(f, weak_boss(), json!({ "policy": { "night": "never", "advance": { "A": "push" } } }));
    assert_eq!(simulate_sortie(&i, 20, 1).unwrap().nodes["B"].reach_rate, 0.0);
    let bad = input(friend_fleet(), weak_boss(), json!({ "policy": { "advance": { "Z": "push" } } }));
    assert!(simulate_sortie(&bad, 1, 1).unwrap_err().contains("policy.advance.Z"));
}

fn one_battle(comp: Value, node: Value) -> SortieInput {
    let mut a = json!({ "kind": "battle", "comps": comp });
    for (k, x) in node.as_object().unwrap() {
        a[k] = x.clone();
    }
    let mut f = friend_fleet();
    f.ships[4].fuel_max = Some(100);
    f.ships[4].ammo_max = Some(100);
    serde_json::from_value(json!({
        "friend": f, "hqLevel": 120,
        "map": { "routing": { "map": "9-9", "sources": [{ "id": "t", "note": "t" }], "nodes": { "Start": { "rules": [{ "to": "A" }] }, "A": { "end": true } } },
                 "nodes": { "A": a } },
        "policy": { "night": "never" }
    }))
    .unwrap()
}

#[test]
fn node_supply_costs() {
    let used = |i: SortieInput| {
        let s = simulate_sortie(&i, 20, 1).unwrap();
        (s.friend[4].fuel_used_mean, s.friend[4].ammo_used_mean)
    };
    let dd = json!([{ "weight": 1.0, "fleet": { "ships": [enemy_dd()] } }]);
    assert_eq!(used(one_battle(dd.clone(), json!({}))), (20.0, 20.0));
    // Caller-supplied rates (e.g. radar ambush 4 % / 0 %).
    assert_eq!(used(one_battle(dd, json!({ "supply": { "fuel": 0.04, "ammo": 0.0 } }))), (4.0, 0.0));
    // PT imp packs only: 4 % / 8 %.
    let mut pt = enemy_dd();
    pt.id = Some(1637);
    assert_eq!(used(one_battle(json!([{ "weight": 1.0, "fleet": { "ships": [pt] } }]), json!({}))), (4.0, 8.0));
}

#[test]
fn underway_replenishment_and_rations_before_the_boss() {
    let mut f = friend_fleet();
    let mut ao = friend_dd();
    ao.ship_type = 22;
    ao.slots[2] = eq(146, 44, 25, EquipmentStats::default());
    f.ships[5] = ao;
    f.ships[1].slots[3] = eq(145, 43, 25, EquipmentStats::default());
    let on = simulate_sortie(&input(f.clone(), weak_boss(), json!({})), 50, 1).unwrap();
    assert_eq!(on.underway_used_mean, 1.0);
    assert_eq!(on.rations_used_mean, 1.0);
    let off = simulate_sortie(&input(f, weak_boss(), json!({ "policy": { "night": "never", "underway": false, "rations": false } })), 50, 1).unwrap();
    assert_eq!((off.underway_used_mean, off.rations_used_mean), (0.0, 0.0));
    // The refill is paid like any resupply (no marriage here): the totals do not change.
    assert_eq!(on.fuel_used_mean, off.fuel_used_mean);
}

#[test]
fn anchorage_repair_heals_covered_seats() {
    let mut f = friend_fleet();
    let mut akashi = friend_dd();
    akashi.id = Some(187);
    akashi.ship_type = 19;
    akashi.slots[0] = eq(86, 31, 31, EquipmentStats::default());
    f.ships[1] = akashi;
    let max = f.ships[2].max_hp;
    f.ships[2].hp = Some(max * 4 / 10);
    f.ships[4].hp = Some(f.ships[4].max_hp / 2); // seat 5: not covered by slot 1
    let i: SortieInput = serde_json::from_value(json!({
        "friend": f, "hqLevel": 120,
        "map": { "routing": { "map": "9-9", "sources": [{ "id": "t", "note": "t" }], "nodes": { "Start": { "rules": [{ "to": "R" }] }, "R": { "end": true } } },
                 "nodes": { "R": { "kind": "anchorageRepair" } } }
    }))
    .unwrap();
    let s = simulate_sortie(&i, 5, 1).unwrap();
    let e = s.effects.unwrap();
    let healed = ((max as f64 * 0.3).ceil()).min((max - max * 4 / 10) as f64);
    assert_eq!(e.anchorage_hp_mean, healed);
    assert_eq!(e.anchorage_materials_mean, 1.0);
    assert_eq!(e.anchorage_steel_mean, 3.0 * healed);
}

#[test]
fn land_base_cost() {
    let bomber = json!({ "id": 169, "types": [0, 0, 47, 37, 0], "stats": { "torpedo": 12, "bombing": 10, "antiAir": 2 }, "proficiency": 7 });
    let i = input(friend_fleet(), weak_boss(), json!({ "lbas": [{ "squadrons": [bomber, bomber, bomber, bomber], "targets": ["B", "B"] }] }));
    let s = simulate_sortie(&i, 30, 1).unwrap();
    let c = s.lbas_cost_mean.unwrap();
    // 18 land attackers per squadron: ⌈27⌉ fuel, ⌊12.6⌋ ammo; losses add 3 fuel / 5 bauxite.
    assert_eq!(c.ammo, 48.0);
    assert!(c.fuel >= 108.0 && (c.fuel - 108.0) * 5.0 / 3.0 - c.bauxite < 1e-9, "{c:?}");
    assert!(s.resources_per_sortie.ammo.mean >= 48.0);
}

#[test]
fn landing_goal_delivers_tp() {
    let mut f = friend_fleet();
    f.ships[4].slots[2] = eq(75, 30, 25, EquipmentStats::default()); // drum: 5 TP
    let i: SortieInput = serde_json::from_value(json!({
        "friend": f, "hqLevel": 120,
        "map": { "routing": { "map": "9-9", "sources": [{ "id": "t", "note": "t" }], "nodes": { "Start": { "rules": [{ "to": "L" }] }, "L": { "end": true } } },
                 "nodes": { "L": { "kind": "landing", "boss": true } } },
        "gauge": { "kind": "tp", "remaining": 100, "runs": 10 }
    }))
    .unwrap();
    let s = simulate_sortie(&i, 5, 1).unwrap();
    // CL 2 + DD 5 + DD 5 + drum 5 = 17 TP per arrival → 6 sorties for 100.
    let g = s.gauge.unwrap();
    assert_eq!(g.expected_sorties, Some(6.0));
    assert_eq!(s.boss.reach_rate, 1.0);
}

#[test]
fn kill_gauge_counts_sunk_flagships() {
    let s = simulate_sortie(&input(friend_fleet(), json!([{ "weight": 1.0, "fleet": enemy_fleet() }]), json!({})), 400, 2).unwrap();
    assert_eq!(s.boss.kill_rate, s.boss.flagship_sunk_rate);
    let r = &s.boss.rank_rates;
    assert!(s.boss.kill_rate <= r.ss + r.s + r.a + r.b + 1e-12);
}

#[test]
fn node_battle_kind_override() {
    let dd = json!([{ "weight": 1.0, "fleet": { "ships": [enemy_dd(), enemy_dd()] } }]);
    let s = simulate_sortie(&one_battle(dd.clone(), json!({ "battleKind": "nightOnly" })), 50, 1).unwrap();
    assert_eq!(s.nodes["A"].night_rate, 1.0);
    // Night-only battles cost 10 % / 10 %.
    assert_eq!(s.friend[4].fuel_used_mean, 10.0);
    let s = simulate_sortie(&one_battle(dd, json!({})), 50, 1).unwrap();
    assert_eq!(s.nodes["A"].night_rate, 0.0);
}

#[test]
fn consecutive_sorties_carry_morale() {
    let boss = json!([{ "weight": 1.0, "fleet": enemy_fleet() }]);
    let base = input(friend_fleet(), boss.clone(), json!({}));
    let ind = simulate_sortie(&base, 200, 5).unwrap();
    assert_eq!(ind.wait_minutes_mean, None);
    let fixed = simulate_sortie(&input(friend_fleet(), boss.clone(), json!({ "consecutive": { "waitMinutes": 15 } })), 200, 5).unwrap();
    assert_eq!(fixed.wait_minutes_mean, Some(15.0));
    // Back to back without a wait, morale only goes down: the fleet does no better than fresh sorties.
    let tired = simulate_sortie(&input(friend_fleet(), boss, json!({ "consecutive": { "untilMorale": 0 } })), 200, 5).unwrap();
    assert_eq!(tired.wait_minutes_mean, Some(0.0));
    assert!(tired.boss.kill_rate <= ind.boss.kill_rate + 0.08, "{} vs {}", tired.boss.kill_rate, ind.boss.kill_rate);
}
