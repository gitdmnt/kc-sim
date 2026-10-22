//! Routing evaluator (docs/ROUTING_DSL.md) against the data-worker seed documents.
use std::collections::HashMap;

use serde_json::{json, Value};
use sim_core::model::*;
use sim_core::routing::{los33, RouteConfig, RouteEquip, RouteShip, Router};
use sim_core::sortie::model::*;
use sim_core::sortie::route_once;

/// Every routing seed document (`data-worker/seed/routing/*.json`), sorted by map.
fn seeds() -> Vec<(String, Value)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../data-worker/seed/routing");
    let mut out: Vec<(String, Value)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json") && !p.to_string_lossy().ends_with("schema.json"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn seed(map: &str) -> Value {
    seeds().into_iter().find(|(m, _)| m == map).unwrap().1
}

fn ship(stype: u32, speed: f64, los: f64, slots: Vec<Option<EquipmentInput>>) -> ShipInput {
    ShipInput {
        ship_type: stype,
        level: Some(99.0),
        max_hp: 30,
        speed: Some(speed),
        stats: ShipStats { firepower: 10.0, torpedo: 10.0, anti_air: 10.0, armor: 10.0, los: Some(los), ..Default::default() },
        slots,
        ..Default::default()
    }
}

fn equip(id: u32, cat: u32, los: f64, level: u32) -> Option<EquipmentInput> {
    Some(EquipmentInput {
        id,
        types: vec![0, 0, cat, 0, 0],
        stats: Some(EquipmentStats { los: Some(los), ..Default::default() }),
        improvement: Some(level),
        proficiency: None,
        planes: None,
    })
}

fn input(routing: Value, ships: Vec<ShipInput>) -> SortieInput {
    SortieInput {
        friend: FleetInput { ships, formation: None },
        hq_level: 120.0,
        map: SortieMap { routing, nodes: HashMap::new() },
        config: SortieConfig::default(),
        policy: SortiePolicy::default(),
        gauge: None,
        max_nodes: None,
        top_paths: None,
    }
}

fn path(inp: &SortieInput, seed: u64) -> String {
    route_once(inp, seed).unwrap().join("-")
}

#[test]
fn all_seed_documents_validate() {
    let all = seeds();
    assert!(all.len() >= 36, "{}", all.len());
    for (map, doc) in &all {
        Router::compile(doc, &[], &RouteConfig::default()).unwrap_or_else(|e| panic!("{map}: {e}"));
    }
}

/// Every seed routes from its start for a spread of fleets: multi-start maps (several `Start*`
/// nodes) must carry top-level start rules, and every path begins at a start node.
#[test]
fn all_seed_documents_route() {
    let fleets = [
        vec![ship(3, 10.0, 40.0, vec![]), ship(2, 10.0, 30.0, vec![]), ship(2, 10.0, 30.0, vec![]), ship(2, 10.0, 30.0, vec![])],
        vec![ship(11, 10.0, 60.0, vec![]), ship(11, 10.0, 60.0, vec![]), ship(9, 5.0, 30.0, vec![]), ship(9, 5.0, 30.0, vec![]), ship(5, 10.0, 40.0, vec![]), ship(5, 10.0, 40.0, vec![])],
        vec![ship(1, 5.0, 20.0, vec![]), ship(1, 5.0, 20.0, vec![]), ship(1, 5.0, 20.0, vec![])],
    ];
    let mut starts_seen: HashMap<String, Vec<String>> = HashMap::new();
    for (map, doc) in seeds() {
        let starts = doc["nodes"].as_object().unwrap().keys().filter(|k| k.starts_with("Start")).count();
        assert!(starts <= 1 || doc.get("start").is_some(), "{map}: {starts} start nodes but no top-level start rules");
        for (i, f) in fleets.iter().enumerate() {
            for s in 0..20 {
                let p = route_once(&input(doc.clone(), f.clone()), s).unwrap_or_else(|e| panic!("{map} fleet {i}: {e}"));
                assert!(p[0].starts_with("Start") && p.len() > 1, "{map} fleet {i}: {p:?}");
                let seen = starts_seen.entry(map.clone()).or_default();
                if !seen.contains(&p[0]) {
                    seen.push(p[0].clone());
                }
            }
        }
    }
    // The CL + 3 DD fleet starts at Start2 on 6-5 while carriers start at Start1: both points get used.
    assert_eq!(starts_seen["6-5"].len(), 2, "{:?}", starts_seen["6-5"]);
}

#[test]
fn start_rules_choose_start_point() {
    let dd = || ship(2, 10.0, 30.0, vec![]);
    let cl = || ship(3, 10.0, 40.0, vec![]);
    let first = |inp: &SortieInput| route_once(inp, 1).unwrap()[0].clone();
    // 6-5: no CL → Start1; CL + DDs (no CV/CLT, < 4 BB) → Start2.
    let doc = seed("6-5");
    assert_eq!(first(&input(doc.clone(), vec![dd(), dd(), dd(), dd()])), "Start1");
    assert_eq!(first(&input(doc.clone(), vec![cl(), dd(), dd(), dd()])), "Start2");
    // An explicit config.start overrides the rules.
    let mut inp = input(doc, vec![dd(), dd(), dd(), dd()]);
    inp.config.start = Some("Start2".into());
    assert_eq!(first(&inp), "Start2");
    // 5-6: defaults.phase = 1 → Start1 for any fleet; phase 2 from the config → Start2 for DDs.
    let doc = seed("5-6");
    assert_eq!(first(&input(doc.clone(), vec![cl(), dd(), dd(), dd()])), "Start1");
    let mut inp = input(doc, vec![cl(), dd(), dd(), dd()]);
    inp.config.phase = Some(2.0);
    assert_eq!(first(&inp), "Start2");
}

#[test]
fn start_rules_validation() {
    let mut doc = tiny(json!([{ "to": "A" }]));
    doc["start"] = json!({ "rules": [{ "to": "A" }] });
    let e = Router::compile(&doc, &[], &RouteConfig::default()).err().unwrap();
    assert!(e.contains("not a start node"), "{e}");
    // Several start points without start rules: the sortie needs config.start.
    let doc = json!({
        "map": "9-9", "sources": [{ "id": "test", "note": "unit test" }],
        "nodes": { "Start1": { "rules": [{ "to": "A" }] }, "Start2": { "rules": [{ "to": "A" }] }, "A": { "end": true } }
    });
    assert!(route_once(&input(doc.clone(), vec![ship(2, 10.0, 30.0, vec![])]), 1).is_err());
    let mut inp = input(doc, vec![ship(2, 10.0, 30.0, vec![])]);
    inp.config.start = Some("Start2".into());
    assert_eq!(path(&inp, 1), "Start2-A");
}

#[test]
fn defaults_phase_and_gauge() {
    let fleet = vec![ship(2, 10.0, 30.0, vec![])];
    let rules = json!([{ "when": { "all": [{ "m": "phase", "eq": 2 }, { "m": "gauge", "eq": 3 }] }, "to": "A" }, { "to": "B" }]);
    let mut doc = tiny(rules);
    doc["defaults"]["gauge"] = json!(3);
    assert_eq!(path(&input(doc.clone(), fleet.clone()), 1), "Start-A");
    // The sortie config wins over the document defaults; without either both default to 1.
    let mut inp = input(doc.clone(), fleet.clone());
    inp.config.gauge = Some(1.0);
    assert_eq!(path(&inp, 1), "Start-B");
    doc.as_object_mut().unwrap().remove("defaults");
    let mut inp = input(doc, fleet);
    (inp.config.phase, inp.config.gauge) = (Some(1.0), Some(1.0));
    assert_eq!(path(&inp, 1), "Start-B");
}

#[test]
fn golden_routes_1_5() {
    let doc = seed("1-5");
    let de = || ship(1, 10.0, 10.0, vec![]);
    let dd = || ship(2, 10.0, 10.0, vec![]);
    let cl = || ship(3, 10.0, 10.0, vec![]);
    // 4 DE: D → (only DE) E → (only DE) J.
    assert_eq!(path(&input(doc.clone(), vec![de(), de(), de(), de()]), 1), "Start-A-D-E-J");
    // CL + 3 DD: D → F → G → (4 ships) J.
    assert_eq!(path(&input(doc.clone(), vec![cl(), dd(), dd(), dd()]), 1), "Start-A-D-F-G-J");
    // 1 ship: D → E → C → B.
    assert_eq!(path(&input(doc.clone(), vec![dd()]), 1), "Start-A-D-E-C-B");
    // 6 ships with a submarine: D → F → I.
    let ss = ship(13, 5.0, 10.0, vec![]);
    assert_eq!(path(&input(doc.clone(), vec![cl(), dd(), dd(), dd(), dd(), ss]), 1), "Start-A-D-F-I");
    // CL + 4 DE: D random E/F (50/50); E → C → J, F → G → H.
    let inp = input(doc, vec![cl(), de(), de(), de(), de()]);
    let mut counts: HashMap<String, u32> = HashMap::new();
    for s in 0..4000 {
        *counts.entry(path(&inp, s)).or_default() += 1;
    }
    assert_eq!(counts.len(), 2, "{counts:?}");
    let j = counts["Start-A-D-E-C-J"] as f64 / 4000.0;
    assert!((j - 0.5).abs() < 0.03, "{j}");
    assert!(counts.contains_key("Start-A-D-F-G-H"));
}

#[test]
fn golden_routes_5_5_speed_and_select() {
    let doc = seed("5-5");
    let dd = |speed| ship(2, speed, 40.0, vec![]);
    let ca = |speed| ship(5, speed, 40.0, vec![]);
    // 4 DD + 2 CA at fastest speed: Start → A (4 DD) → C → E → H → N → O → S.
    let fleet = vec![dd(20.0), dd(20.0), dd(20.0), dd(20.0), ca(20.0), ca(20.0)];
    assert_eq!(path(&input(doc.clone(), fleet), 1), "Start-A-C-E-H-N-O-S");
    // 2 CV + 2 FBB + 2 DD (fast): Start → B → F (select default D) → D → H → P …
    let cv = ship(11, 10.0, 50.0, vec![]);
    let bb = ship(8, 10.0, 30.0, vec![]);
    let fleet = vec![cv.clone(), cv, bb.clone(), bb, dd(10.0), dd(10.0)];
    let p = path(&input(doc.clone(), fleet.clone()), 1);
    assert!(p.starts_with("Start-B-F-D-H-P-"), "{p}");
    // Player select F → J.
    let mut inp = input(doc.clone(), fleet.clone());
    inp.config.selects.insert("F".into(), "J".into());
    assert!(path(&inp, 1).starts_with("Start-B-F-J-P"));
    // Invalid select choice is an input error.
    let mut bad = input(doc, fleet);
    bad.config.selects.insert("F".into(), "Q".into());
    let err = route_once(&bad, 1).unwrap_err();
    assert!(err.contains("config.selects.F"), "{err}");
}

/// Shared with poi-plugin-sim `fleet/calc.test.ts` (tests/fixtures/los33-vectors.json).
#[test]
fn los_formula_33_shared_vectors() {
    let doc: Value = serde_json::from_str(include_str!("fixtures/los33-vectors.json")).unwrap();
    for v in doc["vectors"].as_array().unwrap() {
        let ships: Vec<RouteShip> = v["ships"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| RouteShip {
                stype: 2,
                id: 0,
                speed: 10.0,
                naked_los: s["nakedLos"].as_f64().unwrap(),
                equips: s["equips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| RouteEquip { id: 0, cat: e["cat"].as_u64().unwrap() as u32, los: e["los"].as_f64().unwrap(), level: e["improvement"].as_f64().unwrap() })
                    .collect(),
            })
            .collect();
        let refs: Vec<&RouteShip> = ships.iter().collect();
        for cn in 1..=4 {
            let want = v["expected"][format!("cn{cn}")].as_f64().unwrap();
            let got = los33(&refs, cn as f64, v["hq"].as_f64().unwrap());
            assert!((got - (want * 100.0).floor() / 100.0).abs() < 1e-9, "{} cn{cn}: {got} vs {want}", v["name"]);
        }
    }
}

#[test]
fn los_formula_33() {
    // Ship A: naked 16, recon seaplane LoS 5 ★4, small radar LoS 5; ship B: naked 9.
    let a = RouteShip {
        naked_los: 16.0,
        equips: vec![RouteEquip { id: 25, cat: 10, los: 5.0, level: 4.0 }, RouteEquip { id: 28, cat: 12, los: 5.0, level: 0.0 }],
        ..Default::default()
    };
    let b = RouteShip { naked_los: 9.0, ..Default::default() };
    // 4 + 3 + 2 × (1.2 × (5 + 1.2·2) + 0.6 × 5) − ceil(48) + 2 × 4 = −9.24
    assert_eq!(los33(&[&a, &b], 2.0, 120.0), -9.24);
    // Cn 4, HQ 1: 7 + 4 × 11.88 − 1 + 8 = 61.52
    assert_eq!(los33(&[&a, &b], 4.0, 1.0), 61.52);
}

fn tiny(rules: Value) -> Value {
    json!({
        "map": "9-9",
        "sources": [{ "id": "test", "note": "unit test" }],
        "defaults": { "flags": ["open"], "phase": 2 },
        "nodes": { "Start": { "rules": rules }, "A": { "end": true }, "B": { "end": true }, "C": { "end": true } }
    })
}

#[test]
fn predicates_and_actions() {
    let fleet = || vec![ship(2, 10.0, 40.0, vec![equip(75, 30, 0.0, 0), equip(28, 12, 5.0, 0)]), ship(3, 5.0, 40.0, vec![])];
    let route = |rules: Value| path(&input(tiny(rules), fleet()), 1);
    assert_eq!(route(json!([{ "when": { "m": "flag", "name": "open" }, "to": "A" }, { "to": "B" }])), "Start-A");
    assert_eq!(route(json!([{ "when": { "m": "flag", "name": "open", "eq": false }, "to": "A" }, { "to": "B" }])), "Start-B");
    assert_eq!(route(json!([{ "when": { "m": "phase", "eq": 2 }, "to": "A" }, { "to": "B" }])), "Start-A");
    assert_eq!(route(json!([{ "when": { "m": "speed", "eq": "slow" }, "to": "A" }, { "to": "B" }])), "Start-A");
    assert_eq!(route(json!([{ "when": { "m": "count", "types": ["DD_DE"], "maxSpeed": "slow", "gte": 1 }, "to": "A" }, { "to": "B" }])), "Start-B");
    assert_eq!(route(json!([{ "when": { "m": "equipShips", "equip": { "group": "DRUM" }, "eq": 1 }, "to": "A" }, { "to": "B" }])), "Start-A");
    assert_eq!(route(json!([{ "when": { "m": "equipCount", "equip": { "types": [12], "minLos": 6 }, "gte": 1 }, "to": "A" }, { "to": "B" }])), "Start-B");
    assert_eq!(route(json!([{ "when": { "m": "flagship", "in": ["DD"] }, "to": "A" }, { "to": "B" }])), "Start-A");
    assert_eq!(route(json!([{ "when": { "m": "ships", "fleet": "escort", "gte": 1 }, "to": "A" }, { "to": "B" }])), "Start-B");
    assert_eq!(route(json!([{ "when": { "m": "fleetType", "in": ["single"] }, "to": "A" }, { "to": "B" }])), "Start-A");
    assert_eq!(route(json!([{ "when": { "m": "visited", "node": "Start" }, "to": "A" }, { "to": "B" }])), "Start-A");
    assert_eq!(route(json!([{ "when": { "not": { "m": "hq", "in": [120] } }, "to": "A" }, { "to": "B" }])), "Start-B");
    assert_eq!(
        route(json!([{ "when": { "all": [{ "m": "difficulty", "eq": 0 }, { "any": [{ "m": "gauge", "eq": 2 }, { "m": "onlyTypes", "types": ["DD", "CL"] }] }] },
                       "rules": [{ "when": { "m": "countIds", "ids": [1], "gte": 1 }, "to": "C" }, { "to": "A" }] }, { "to": "B" }])),
        "Start-A"
    );
}

#[test]
fn los_interpolation_rates() {
    // Two DD with naked LoS 100 each, no equipment, HQ 120: 10 + 10 − 48 + 8 = −20.
    let fleet = || vec![ship(2, 10.0, 100.0, vec![]), ship(2, 10.0, 100.0, vec![])];
    let doc = tiny(json!([{ "los": { "cn": 1, "thresholds": [{ "min": -15, "to": "A" }, { "min": -25, "to": "B" }], "below": "C" } }]));
    let inp = input(doc, fleet());
    let a = (0..10000).filter(|&s| path(&inp, s) == "Start-A").count() as f64 / 10000.0;
    // (−20 − (−25)) / (−15 − (−25)) = 0.5
    assert!((a - 0.5).abs() < 0.02, "{a}");
    let doc = tiny(json!([{ "los": { "cn": 1, "thresholds": [{ "min": -15, "to": "A" }, { "min": -25, "to": "B" }], "below": "C", "interpolate": false } }]));
    assert_eq!(path(&input(doc, fleet()), 3), "Start-B");
    let doc = tiny(json!([{ "los": { "cn": 1, "thresholds": [{ "min": 0, "to": "A" }], "below": "C" } }]));
    assert_eq!(path(&input(doc, fleet()), 3), "Start-C");
}

#[test]
fn invalid_documents_are_rejected() {
    let fleet = vec![ship(2, 10.0, 40.0, vec![])];
    let err = |rules: Value| route_once(&input(tiny(rules), fleet.clone()), 1).unwrap_err();
    assert!(err(json!([{ "when": { "m": "nope", "eq": 1 }, "to": "A" }, { "to": "B" }])).contains("unknown predicate metric 'nope'"));
    assert!(err(json!([{ "when": { "m": "ships", "eq": 1, "foo": 1 }, "to": "A" }, { "to": "B" }])).contains("unknown key 'foo'"));
    assert!(err(json!([{ "when": { "m": "count", "types": ["XX"], "eq": 1 }, "to": "A" }, { "to": "B" }])).contains("unknown ship type"));
    assert!(err(json!([{ "when": { "m": "ships", "eq": 1 }, "to": "A" }])).contains("last rule"));
    assert!(err(json!([{ "random": [{ "to": "A", "p": 0.5 }, { "to": "B", "p": 0.4 }] }])).contains("sum"));
    assert!(err(json!([{ "los": { "cn": 1, "thresholds": [{ "min": 1, "to": "A" }, { "min": 2, "to": "B" }], "below": "C" } }])).contains("descending"));
    assert!(err(json!([{ "to": "Z" }])).contains("destination 'Z'"));
    assert!(err(json!([{ "to": "A", "random": [{ "to": "A", "p": 1 }] }])).contains("exactly one"));
    assert!(err(json!([{ "when": { "m": "equipShips", "equip": { "group": "GUN" }, "gte": 1 }, "to": "A" }, { "to": "B" }])).contains("unknown equipment group"));
}

#[test]
fn routing_is_deterministic() {
    let inp = input(seed("2-5"), (0..6).map(|_| ship(2, 10.0, 30.0, vec![])).collect());
    for s in 0..50 {
        assert_eq!(route_once(&inp, s).unwrap(), route_once(&inp, s).unwrap());
    }
}
