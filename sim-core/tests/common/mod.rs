//! Test fixtures: approximate master stats of common ships / equipment.
#![allow(dead_code)]

use sim_core::model::*;

pub fn eq(id: u32, cat: u32, icon: u32, stats: EquipmentStats) -> Option<EquipmentInput> {
    Some(EquipmentInput { id, types: vec![0, 0, cat, icon, 0], stats: Some(stats), ..Default::default() })
}

pub fn plane(id: u32, cat: u32, icon: u32, stats: EquipmentStats, planes: i32, prof: u32) -> Option<EquipmentInput> {
    let mut e = eq(id, cat, icon, stats).unwrap();
    e.planes = Some(planes);
    e.proficiency = Some(prof);
    Some(e)
}

pub fn st(fp: f64, tp: f64, aa: f64, ar: f64) -> EquipmentStats {
    EquipmentStats { firepower: Some(fp), torpedo: Some(tp), anti_air: Some(aa), armor: Some(ar), ..Default::default() }
}

// --- equipment -------------------------------------------------------------
pub fn gun_41cm() -> Option<EquipmentInput> {
    eq(8, 3, 3, EquipmentStats { firepower: Some(20.0), anti_air: Some(4.0), range: Some(3.0), ..Default::default() })
}
pub fn gun_203() -> Option<EquipmentInput> {
    eq(50, 2, 2, EquipmentStats { firepower: Some(10.0), anti_air: Some(4.0), accuracy: Some(1.0), range: Some(2.0), ..Default::default() })
}
pub fn gun_127_dd() -> Option<EquipmentInput> {
    eq(63, 1, 1, EquipmentStats { firepower: Some(3.0), anti_air: Some(2.0), accuracy: Some(1.0), range: Some(1.0), ..Default::default() })
}
pub fn torp_61_oxy() -> Option<EquipmentInput> {
    eq(15, 5, 5, EquipmentStats { torpedo: Some(10.0), range: Some(1.0), ..Default::default() })
}
pub fn sec_155() -> Option<EquipmentInput> {
    eq(12, 4, 4, EquipmentStats { firepower: Some(7.0), anti_air: Some(3.0), accuracy: Some(2.0), range: Some(2.0), ..Default::default() })
}
pub fn ap_shell() -> Option<EquipmentInput> {
    eq(36, 19, 13, EquipmentStats { firepower: Some(8.0), accuracy: Some(1.0), ..Default::default() })
}
pub fn zero_recon(planes: i32) -> Option<EquipmentInput> {
    plane(
        25,
        10,
        10,
        EquipmentStats { anti_air: Some(1.0), asw: Some(2.0), los: Some(5.0), bombing: Some(1.0), accuracy: Some(1.0), ..Default::default() },
        planes,
        0,
    )
}
pub fn radar_22() -> Option<EquipmentInput> {
    eq(28, 12, 11, EquipmentStats { los: Some(5.0), accuracy: Some(3.0), ..Default::default() })
}
pub fn sonar_93() -> Option<EquipmentInput> {
    eq(46, 14, 18, EquipmentStats { asw: Some(6.0), accuracy: Some(1.0), ..Default::default() })
}
pub fn dc_type3() -> Option<EquipmentInput> {
    eq(45, 15, 17, EquipmentStats { asw: Some(8.0), ..Default::default() })
}
pub fn fighter_reppu(planes: i32) -> Option<EquipmentInput> {
    plane(22, 6, 6, EquipmentStats { anti_air: Some(10.0), ..Default::default() }, planes, 7)
}
pub fn tb_ryuusei(planes: i32) -> Option<EquipmentInput> {
    plane(52, 8, 8, EquipmentStats { torpedo: Some(13.0), anti_air: Some(1.0), asw: Some(3.0), los: Some(1.0), ..Default::default() }, planes, 7)
}
pub fn db_suisei(planes: i32) -> Option<EquipmentInput> {
    plane(24, 7, 7, EquipmentStats { bombing: Some(8.0), asw: Some(3.0), ..Default::default() }, planes, 7)
}
pub fn damecon_goddess() -> Option<EquipmentInput> {
    eq(43, 23, 14, EquipmentStats::default())
}

// --- ships -----------------------------------------------------------------
#[allow(clippy::too_many_arguments)]
pub fn ship(stype: u32, level: f64, hp: i32, fp: f64, tp: f64, aa: f64, ar: f64, ev: f64, asw: f64, luck: f64, slots: Vec<Option<EquipmentInput>>) -> ShipInput {
    ShipInput {
        ship_type: stype,
        level: Some(level),
        max_hp: hp,
        stats: ShipStats { firepower: fp, torpedo: tp, anti_air: aa, armor: ar, evasion: Some(ev), asw: Some(asw), los: Some(15.0), luck: Some(luck) },
        slots,
        ..Default::default()
    }
}

pub fn friend_bb() -> ShipInput {
    let mut s = ship(9, 99.0, 90, 82.0, 0.0, 61.0, 75.0, 38.0, 0.0, 20.0, vec![gun_41cm(), gun_41cm(), ap_shell(), zero_recon(3)]);
    s.range = Some(3.0);
    s.fuel_max = Some(100);
    s.ammo_max = Some(130);
    s
}
pub fn friend_ca() -> ShipInput {
    let mut s = ship(5, 90.0, 57, 54.0, 60.0, 50.0, 55.0, 50.0, 0.0, 15.0, vec![gun_203(), gun_203(), zero_recon(2), radar_22()]);
    s.range = Some(2.0);
    s.fuel_max = Some(40);
    s.ammo_max = Some(45);
    s
}
pub fn friend_cl() -> ShipInput {
    let mut s = ship(3, 85.0, 45, 46.0, 70.0, 40.0, 40.0, 70.0, 60.0, 15.0, vec![gun_127_dd(), torp_61_oxy(), sonar_93()]);
    s.range = Some(2.0);
    s
}
pub fn friend_dd() -> ShipInput {
    ship(2, 80.0, 32, 30.0, 70.0, 40.0, 30.0, 80.0, 60.0, 15.0, vec![gun_127_dd(), torp_61_oxy(), torp_61_oxy()])
}
pub fn friend_dd_asw() -> ShipInput {
    // OASW-capable destroyer (ASW 70 naked + sonar 6 + DC 8 + ... >= 100 with 3 slots)
    ship(2, 99.0, 33, 30.0, 70.0, 40.0, 30.0, 85.0, 80.0, 20.0, vec![sonar_93(), dc_type3(), dc_type3()])
}
pub fn friend_cv() -> ShipInput {
    let mut s = ship(11, 99.0, 79, 48.0, 0.0, 70.0, 70.0, 45.0, 0.0, 20.0, vec![fighter_reppu(20), db_suisei(32), tb_ryuusei(46), fighter_reppu(12)]);
    s.range = Some(1.0);
    s
}

pub fn friend_fleet() -> FleetInput {
    FleetInput { ships: vec![friend_bb(), friend_ca(), friend_ca(), friend_cl(), friend_dd(), friend_dd()], formation: Some(Formation::LineAhead), ..Default::default() }
}

pub fn enemy_bb() -> ShipInput {
    ship(9, 1.0, 90, 70.0, 0.0, 40.0, 80.0, 30.0, 0.0, 10.0, vec![eq(1501, 3, 3, st(15.0, 0.0, 0.0, 0.0)), eq(1501, 3, 3, st(15.0, 0.0, 0.0, 0.0))])
}
pub fn enemy_ca() -> ShipInput {
    ship(5, 1.0, 76, 50.0, 30.0, 30.0, 60.0, 30.0, 0.0, 10.0, vec![eq(1505, 2, 2, st(8.0, 0.0, 0.0, 0.0)), eq(1505, 2, 2, st(8.0, 0.0, 0.0, 0.0))])
}
pub fn enemy_cl() -> ShipInput {
    ship(3, 1.0, 35, 20.0, 40.0, 15.0, 20.0, 25.0, 20.0, 10.0, vec![eq(1502, 1, 1, st(4.0, 0.0, 0.0, 0.0)), eq(1513, 5, 5, st(0.0, 8.0, 0.0, 0.0))])
}
pub fn enemy_dd() -> ShipInput {
    ship(2, 1.0, 24, 8.0, 20.0, 8.0, 7.0, 20.0, 15.0, 5.0, vec![eq(1502, 1, 1, st(2.0, 0.0, 0.0, 0.0))])
}
pub fn enemy_ss() -> ShipInput {
    let mut s = ship(13, 50.0, 19, 0.0, 30.0, 0.0, 7.0, 20.0, 0.0, 10.0, vec![eq(1513, 5, 5, st(0.0, 8.0, 0.0, 0.0))]);
    s.stats.los = Some(5.0);
    s
}

pub fn enemy_fleet() -> FleetInput {
    FleetInput { ships: vec![enemy_bb(), enemy_ca(), enemy_cl(), enemy_dd(), enemy_dd(), enemy_dd()], formation: Some(Formation::LineAhead), ..Default::default() }
}

pub fn battle(friend: FleetInput, enemy: FleetInput, kind: BattleKind) -> BattleInput {
    BattleInput { friend, enemy, options: BattleOptions { kind, ..Default::default() }, ..Default::default() }
}

// --- 1-5 sortie from the saved server API responses -------------------------------------

pub const FIXTURE_1_5: &str = include_str!("../fixtures/1-5.api.json");

/// Reference conversion of private notes API shapes into `SortieInput` (what the UI does).
pub fn sortie_input_from_api(api: &serde_json::Value, friend: FleetInput, difficulty: u64) -> sim_core::sortie::model::SortieInput {
    use serde_json::{json, Value};
    let formation = |id: u64| ["lineAhead", "doubleLine", "diamond", "echelon", "lineAbreast", "vanguard"][(id.clamp(1, 6) - 1) as usize];
    let ships = &api["ships"];
    let equips = &api["equipments"];
    let best = |b: &Value, k: &str| b[k]["value"].as_f64();
    let enemy_ship = |s: &Value| -> Value {
        let id = s["shipId"].as_u64().unwrap();
        let d = &ships[id.to_string()];
        let m = &d["ship"];
        let b = &d["best"];
        let plane_counts = m["slots"].as_array().cloned().unwrap_or_default();
        let slots: Vec<Value> = s["equips"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(_, e)| e.as_i64().unwrap_or(-1) > 0)
            .map(|(i, e)| {
                let q = &equips[e.as_u64().unwrap().to_string()]["equipment"];
                json!({
                    "id": q["id"], "types": q["type"],
                    "stats": { "firepower": q["fp"], "torpedo": q["tp"], "antiAir": q["aa"], "armor": q["ar"], "evasion": q["ev"],
                               "asw": q["asw"], "los": q["los"], "accuracy": q["acc"], "bombing": q["bomb"], "luck": q["luck"], "range": q["range"] },
                    "planes": plane_counts.get(i).cloned().unwrap_or(json!(0))
                })
            })
            .collect();
        json!({
            "id": id, "name": m["name"], "shipType": m["stype"], "level": s["level"], "maxHp": s["hp"],
            "stats": { "firepower": s["fp"], "torpedo": s["tp"], "antiAir": s["aa"], "armor": s["ar"],
                       "evasion": best(b, "ev"), "asw": best(b, "asw"), "los": best(b, "los"), "luck": best(b, "luck") },
            "hiddenAccuracy": best(b, "acc"), "range": m["range"], "speed": m["speed"], "slots": slots
        })
    };
    let mut nodes = serde_json::Map::new();
    for n in api["map"]["nodes"].as_array().unwrap() {
        let letter = n["letter"].as_str().unwrap();
        let mut node = json!({ "kind": n["type"], "boss": n["isBoss"] });
        if let Some(c) = api["enemyComps"].get(letter) {
            let set = c["sets"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|s| s["difficulty"].as_u64() == Some(difficulty))
                .max_by(|a, b| a["retrievedAt"].as_str().cmp(&b["retrievedAt"].as_str()))
                .unwrap();
            let comps: Vec<Value> = set["comps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|cp| {
                    json!({ "weight": cp["weight"], "fleet": {
                        "formation": formation(cp["formation"].as_u64().unwrap()),
                        "ships": cp["main"].as_array().unwrap().iter().map(enemy_ship).collect::<Vec<_>>() } })
                })
                .collect();
            node["comps"] = Value::Array(comps);
        }
        nodes.insert(letter.to_string(), node);
    }
    let input = json!({
        "friend": friend,
        "hqLevel": 120,
        "map": { "routing": api["map"]["routing"], "nodes": nodes },
        "config": { "difficulty": difficulty }
    });
    serde_json::from_value(input).unwrap()
}

/// Typical 1-5 boss fleet: ASW light cruiser (always OASW) + 3 OASW destroyers, all fast.
pub fn fleet_1_5() -> FleetInput {
    let mut cl = ship(3, 99.0, 45, 46.0, 70.0, 40.0, 40.0, 70.0, 60.0, 15.0, vec![sonar_93(), dc_type3(), dc_type3()]);
    cl.always_opening_asw = Some(true);
    let mut ships = vec![cl, friend_dd_asw(), friend_dd_asw(), friend_dd_asw()];
    for s in &mut ships {
        s.speed = Some(10.0);
        s.fuel_max = Some(15);
        s.ammo_max = Some(20);
    }
    FleetInput { ships, formation: None, ..Default::default() }
}

pub fn sortie_1_5(friend: FleetInput) -> sim_core::sortie::model::SortieInput {
    sortie_input_from_api(&serde_json::from_str(FIXTURE_1_5).unwrap(), friend, 0)
}
