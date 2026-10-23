//! The JSON shape documented in docs/SIM_INTERFACE.md (camelCase keys, camelCase enum values).
use sim_core::model::*;
use sim_core::query::{damage_distribution, hit_probability};
use sim_core::sim::{run_battle, simulate};

const INPUT: &str = r#"{
  "friend": {
    "formation": "lineAhead",
    "ships": [{
      "id": 80, "name": "Nagato", "shipType": 9, "level": 99, "maxHp": 90, "hp": 90,
      "stats": { "firepower": 82, "torpedo": 0, "antiAir": 61, "armor": 75, "evasion": 38, "asw": 0, "los": 39, "luck": 20 },
      "equipBonus": { "firepower": 2 },
      "range": 3, "speed": 5, "morale": 53, "fuel": 100, "fuelMax": 100, "ammo": 130, "ammoMax": 130,
      "slots": [
        { "id": 8, "types": [1, 1, 3, 3, 0], "stats": { "firepower": 20, "antiAir": 4, "range": 3 }, "improvement": 4 },
        { "id": 25, "types": [5, 7, 10, 10, 0], "stats": { "los": 5, "accuracy": 1 }, "proficiency": 7, "planes": 3 },
        null
      ],
      "exSlot": { "id": 43, "types": [23, 30, 23, 14, 0] }
    }]
  },
  "enemy": {
    "formation": "doubleLine",
    "ships": [{ "shipType": 2, "maxHp": 24, "stats": { "firepower": 8, "torpedo": 20, "antiAir": 8, "armor": 7 }, "slots": [] }]
  },
  "options": { "kind": "dayNight", "engagement": "tAdvantage", "log": true }
}"#;

#[test]
fn json_roundtrip_and_keys() {
    let input: BattleInput = serde_json::from_str(INPUT).unwrap();
    assert_eq!(input.friend.formation, Some(Formation::LineAhead));
    assert_eq!(input.options.engagement, Some(Engagement::TAdvantage));
    let out = run_battle(&input, 1).unwrap();
    assert_eq!(out.result.engagement, Engagement::TAdvantage);
    let v = serde_json::to_value(&out).unwrap();
    for key in ["rank", "mvp", "engagement", "airState", "detection", "nightBattle", "enemyGauge", "friendGauge", "friend", "enemy", "events"] {
        assert!(v["result"].get(key).is_some(), "missing result.{key}");
    }
    let ev = &v["result"]["events"][0];
    for key in ["phase", "kind", "special", "attackerSide", "attacker", "defender", "covered", "hit", "damage", "defenderHpBefore", "defenderHpAfter", "pHit", "pCrit"] {
        assert!(ev.get(key).is_some(), "missing event.{key}");
    }
    assert_eq!(v["result"]["engagement"], "tAdvantage");
    let ship = &v["state"]["friend"]["ships"][0];
    assert_eq!(ship["fuel"], 80);
    assert_eq!(ship["exSlot"]["id"], 43);
    assert!(ship["slots"][2].is_null());

    let mut input2 = input.clone();
    input2.options.log = false;
    let s = serde_json::to_value(simulate(&input2, 100, 3).unwrap()).unwrap();
    for key in ["SS", "S", "A", "B", "C", "D", "E"] {
        assert!(s["rankRates"].get(key).is_some());
    }
    for key in ["maxHp", "hpMean", "hpHistogram", "sunkRate", "heavyRate", "moderateRate", "lightRate", "healthyRate", "damageDealtMean", "mvpRate"] {
        assert!(s["friend"][0].get(key).is_some(), "missing summary.{key}");
    }
    assert!(s["airStateRates"].get("supremacy").is_some());

    let q: AttackQuery = serde_json::from_value(serde_json::json!({
        "kind": "night",
        "attacker": serde_json::from_str::<serde_json::Value>(INPUT).unwrap()["friend"]["ships"][0],
        "defender": serde_json::from_str::<serde_json::Value>(INPUT).unwrap()["enemy"]["ships"][0],
        "attackerSide": "friend",
        "special": "nightDoubleAttack",
        "night": { "ownStarshell": true, "nightContactAccuracy": 1 }
    }))
    .unwrap();
    let h = serde_json::to_value(hit_probability(&q).unwrap()).unwrap();
    assert!(h["pHit"].as_f64().unwrap() > 0.0 && h.get("pCrit").is_some());
    let d = serde_json::to_value(damage_distribution(&q).unwrap()).unwrap();
    assert!(d["hit"][0].get("damage").is_some() && d["hit"][0].get("p").is_some() && d.get("meanCritical").is_some());
}

#[test]
fn combined_and_land_base_json() {
    let base: serde_json::Value = serde_json::from_str(INPUT).unwrap();
    let nagato = base["friend"]["ships"][0].clone();
    let mut dd = base["enemy"]["ships"][0].clone();
    dd["maxHp"] = 300.into();
    let bomber = serde_json::json!({ "id": 169, "types": [3, 17, 47, 37, 0], "stats": { "torpedo": 12, "bombing": 10, "antiAir": 2 }, "proficiency": 7 });
    let input: BattleInput = serde_json::from_value(serde_json::json!({
        "friend": { "formation": "combinedBattle", "combined": "carrier", "ships": [nagato, nagato], "escort": [nagato] },
        "enemy": { "ships": [dd, dd] },
        "options": { "kind": "dayNight", "log": true },
        "lbas": [{ "squadrons": [bomber, bomber] }]
    }))
    .unwrap();
    assert_eq!(input.friend.combined, Some(CombinedType::Carrier));
    assert_eq!(input.friend.formation, Some(Formation::CombinedBattle));
    let v = serde_json::to_value(run_battle(&input, 2).unwrap()).unwrap();
    assert_eq!(v["result"]["friend"].as_array().unwrap().len(), 3);
    assert_eq!(v["result"]["mvpEscort"], 2);
    assert_eq!(v["state"]["friend"]["combined"], "carrier");
    assert_eq!(v["state"]["friend"]["escort"].as_array().unwrap().len(), 1);
    let phases: Vec<&str> = v["result"]["events"].as_array().unwrap().iter().map(|e| e["phase"].as_str().unwrap()).collect();
    assert!(phases.contains(&"landBase") && phases.contains(&"shelling3"), "{phases:?}");
    // Single fleets do not emit the combined-only key.
    let single: BattleInput = serde_json::from_str(INPUT).unwrap();
    assert!(serde_json::to_value(run_battle(&single, 1).unwrap()).unwrap()["result"].get("mvpEscort").is_none());
}
