//! Friend combined fleets (kcsimcombined `simCombined`) and land-based air squadrons (kcsim
//! `LBASPhase`): phase structure, effects on results, sorties and validation.
mod common;

use common::*;
use serde_json::json;
use sim_core::model::*;
use sim_core::sim::{run_battle, simulate};
use sim_core::sortie::model::*;
use sim_core::sortie::simulate_sortie;

fn main_fleet() -> Vec<ShipInput> {
    vec![friend_cv(), friend_cv(), friend_bb(), friend_bb(), friend_ca(), friend_ca()]
}

fn escort_fleet() -> Vec<ShipInput> {
    vec![friend_cl(), friend_ca(), friend_ca(), friend_dd(), friend_dd(), friend_dd()]
}

fn combined(ct: CombinedType) -> FleetInput {
    FleetInput { ships: main_fleet(), escort: Some(escort_fleet()), combined: Some(ct), ..Default::default() }
}

fn hp_sum(s: &SimulationSummary) -> f64 {
    s.enemy.iter().map(|e| e.hp_mean).sum()
}

/// 一式陸攻 (land-based attack bomber).
fn land_bomber() -> EquipmentInput {
    EquipmentInput {
        id: 169,
        types: vec![0, 0, 47, 37, 0],
        stats: Some(EquipmentStats { torpedo: Some(12.0), bombing: Some(10.0), anti_air: Some(2.0), los: Some(2.0), ..Default::default() }),
        improvement: None,
        proficiency: Some(7),
        planes: None,
    }
}

fn bomber_wave() -> LandBaseWave {
    LandBaseWave { squadrons: vec![land_bomber(), land_bomber(), land_bomber(), land_bomber()] }
}

#[test]
fn combined_types_run_and_differ_from_main_fleet() {
    let enemy = || {
        let mut e = enemy_fleet();
        for s in &mut e.ships {
            s.max_hp = 600;
        }
        e
    };
    let single = simulate(&battle(FleetInput { ships: main_fleet(), ..Default::default() }, enemy(), BattleKind::DayNight), 1500, 1).unwrap();
    let mut per_type = Vec::new();
    for ct in [CombinedType::Carrier, CombinedType::Surface, CombinedType::Transport] {
        let s = simulate(&battle(combined(ct), enemy(), BattleKind::DayNight), 1500, 1).unwrap();
        assert_eq!(s.friend.len(), 12);
        // Each fleet has its own MVP.
        let mvp: f64 = s.friend.iter().map(|f| f.mvp_rate).sum();
        assert!((mvp - 2.0).abs() < 1e-9, "{ct:?} {mvp}");
        assert!((s.friend[6..].iter().map(|f| f.mvp_rate).sum::<f64>() - 1.0).abs() < 1e-9);
        // Twelve ships hit harder than the main fleet alone.
        assert!(hp_sum(&s) < hp_sum(&single), "{ct:?} {} vs {}", hp_sum(&s), hp_sum(&single));
        assert!(s.friend[6..].iter().any(|f| f.damage_dealt_mean > 0.0));
        per_type.push(hp_sum(&s));
    }
    assert!(per_type[0] != per_type[1] && per_type[1] != per_type[2], "{per_type:?}");
}

#[test]
fn combined_phase_structure() {
    for ct in [CombinedType::Carrier, CombinedType::Surface, CombinedType::Transport] {
        let mut input = battle(combined(ct), enemy_fleet(), BattleKind::DayNight);
        input.options.log = true;
        for seed in 0..20 {
            let out = run_battle(&input, seed).unwrap();
            assert_eq!(out.result.friend.len(), 12);
            assert!(out.result.mvp < 6 && out.result.mvp_escort.is_some_and(|m| (6..12).contains(&m)));
            let st = &out.state.friend;
            assert_eq!((st.ships.len(), st.escort_ships().len(), st.combined), (6, 6, Some(ct)));
            for e in out.result.events.as_ref().unwrap() {
                let escort_round = match (ct, e.phase) {
                    (_, Phase::OpeningAsw | Phase::OpeningTorpedo | Phase::ClosingTorpedo | Phase::Night) => Some(true),
                    (CombinedType::Surface, Phase::Shelling1 | Phase::Shelling2) => Some(false),
                    (CombinedType::Surface, Phase::Shelling3) => Some(true),
                    (_, Phase::Shelling1) => Some(true),
                    (_, Phase::Shelling2 | Phase::Shelling3) => Some(false),
                    _ => None,
                };
                let Some(escort) = escort_round else { continue };
                // The friend fleet of the round attacks and is the only one the enemy targets.
                let friend_idx = if e.attacker_side == Side::Friend { e.attacker } else { e.defender };
                assert_eq!(friend_idx >= 6, escort, "{ct:?} {:?} {e:?}", e.phase);
            }
            // Air phase: only main-fleet planes launch, enemy planes are absent here.
            assert!(out.result.events.as_ref().unwrap().iter().all(|e| e.phase != Phase::AirStrike || e.attacker_side != Side::Friend || e.attacker < 6));
        }
    }
}

#[test]
fn combined_night_only_uses_escort() {
    let mut input = battle(combined(CombinedType::Surface), enemy_fleet(), BattleKind::NightOnly);
    input.options.log = true;
    let mut night_attacks = 0;
    for seed in 0..20 {
        let out = run_battle(&input, seed).unwrap();
        assert!(out.result.night_battle);
        for e in out.result.events.unwrap() {
            assert_eq!(e.phase, Phase::Night);
            let friend_idx = if e.attacker_side == Side::Friend { e.attacker } else { e.defender };
            assert!(friend_idx >= 6, "{e:?}");
            night_attacks += 1;
        }
    }
    assert!(night_attacks > 0);
}

#[test]
fn lbas_waves_damage_the_enemy() {
    let weak = || FleetInput { ships: vec![friend_dd(), friend_dd()], ..Default::default() };
    let plain = battle(weak(), enemy_fleet(), BattleKind::Day);
    let mut with_lb = plain.clone();
    with_lb.lbas = Some(vec![bomber_wave(), bomber_wave(), bomber_wave(), bomber_wave()]);
    let a = simulate(&plain, 2000, 3).unwrap();
    let b = simulate(&with_lb, 2000, 3).unwrap();
    assert!(hp_sum(&b) < hp_sum(&a) - 20.0, "{} vs {}", hp_sum(&b), hp_sum(&a));
    assert!(b.rank_rates.s + b.rank_rates.ss > a.rank_rates.s + a.rank_rates.ss);
    assert!(b.enemy_flagship_sunk_rate > a.enemy_flagship_sunk_rate);
    // Land bases are not ships: friend damage credit (MVP) stays with the fleet.
    assert_eq!(b.friend.len(), 2);

    let mut logged = with_lb.clone();
    logged.options.log = true;
    let out = run_battle(&logged, 5).unwrap();
    let ev = out.result.events.unwrap();
    let lb: Vec<_> = ev.iter().filter(|e| e.phase == Phase::LandBase).collect();
    assert!(!lb.is_empty());
    assert!(lb.iter().all(|e| e.attacker_side == Side::Friend && e.attacker < 4 && e.slot.is_some_and(|s| s < 4)));
    // Waves come before every fleet phase.
    let first_other = ev.iter().position(|e| e.phase != Phase::LandBase).unwrap_or(ev.len());
    assert!(ev[first_other..].iter().all(|e| e.phase != Phase::LandBase));

    // Works with a combined fleet too, and no waves at night-only nodes.
    let mut cf = battle(combined(CombinedType::Carrier), enemy_fleet(), BattleKind::Day);
    cf.lbas = Some(vec![bomber_wave()]);
    cf.options.log = true;
    assert!(run_battle(&cf, 1).unwrap().result.events.unwrap().iter().any(|e| e.phase == Phase::LandBase));
    let mut night = plain.clone();
    night.options.kind = BattleKind::NightOnly;
    night.options.log = true;
    night.lbas = Some(vec![bomber_wave()]);
    assert!(run_battle(&night, 1).unwrap().result.events.unwrap().iter().all(|e| e.phase != Phase::LandBase));
}

#[test]
fn lbas_fighters_shoot_down_enemy_planes() {
    // Abyssal carriers without proficiency; one friend carrier: parity without land bases.
    let mut cv = friend_cv();
    cv.max_hp = 90;
    for e in cv.slots.iter_mut().flatten() {
        e.proficiency = None;
    }
    let enemy = FleetInput { ships: vec![cv.clone(), cv, enemy_dd()], ..Default::default() };
    let friend = FleetInput { ships: vec![friend_cv(), friend_dd()], ..Default::default() };
    let plain = battle(friend, enemy, BattleKind::Day);
    let fighter = || EquipmentInput {
        id: 22,
        types: vec![0, 0, 6, 6, 0],
        stats: Some(EquipmentStats { anti_air: Some(10.0), ..Default::default() }),
        improvement: None,
        proficiency: Some(7),
        planes: None,
    };
    let mut with_lb = plain.clone();
    with_lb.lbas = Some(vec![LandBaseWave { squadrons: vec![fighter(), fighter(), fighter(), fighter()] }; 6]);
    let a = simulate(&plain, 1000, 9).unwrap();
    let b = simulate(&with_lb, 1000, 9).unwrap();
    let good = |s: &SimulationSummary| s.air_state_rates.supremacy + s.air_state_rates.superiority;
    assert!(good(&b) > good(&a) + 0.1, "{} vs {}", good(&b), good(&a));
}

fn boss_map() -> serde_json::Value {
    json!({
        "map": "9-9", "sources": [{ "id": "t", "note": "test" }],
        "nodes": { "Start": { "rules": [{ "to": "A" }] }, "A": { "rules": [{ "to": "B" }] }, "B": { "end": true } }
    })
}

fn boss_sortie(friend: FleetInput, lbas: serde_json::Value) -> SortieInput {
    let mut boss = enemy_fleet();
    boss.ships[0].max_hp = 250;
    serde_json::from_value(json!({
        "friend": friend,
        "hqLevel": 120,
        "map": { "routing": boss_map(), "nodes": {
            "A": { "kind": "battle", "comps": [{ "weight": 1.0, "fleet": { "ships": [enemy_dd(), enemy_dd()] } }] },
            "B": { "kind": "boss", "comps": [{ "weight": 1.0, "fleet": boss }] }
        } },
        "policy": { "night": "never", "retreat": { "onHeavy": false } },
        "lbas": lbas
    }))
    .unwrap()
}

#[test]
fn sortie_lbas_on_the_boss() {
    let squadrons = json!([land_bomber(), land_bomber(), land_bomber(), land_bomber()]);
    let none = simulate_sortie(&boss_sortie(friend_fleet(), json!(null)), 600, 4).unwrap();
    let bases = |targets: serde_json::Value, n: usize| json!(vec![json!({ "squadrons": squadrons, "targets": targets }); n]);
    let boss = simulate_sortie(&boss_sortie(friend_fleet(), bases(json!(["B", "B"]), 3)), 600, 4).unwrap();
    assert!((none.boss.reach_rate - 1.0).abs() < 1e-12 && (boss.boss.reach_rate - 1.0).abs() < 1e-12);
    assert!(boss.boss.flagship_damage_mean > none.boss.flagship_damage_mean + 10.0, "{} vs {}", boss.boss.flagship_damage_mean, none.boss.flagship_damage_mean);
    assert!(boss.boss.kill_rate >= none.boss.kill_rate);
    // Waves spent at A first: the losses there carry into the boss wave (fewer planes ⇒ less damage).
    let split = simulate_sortie(&boss_sortie(friend_fleet(), bases(json!(["A", "B"]), 3)), 600, 4).unwrap();
    assert!(split.boss.flagship_damage_mean < boss.boss.flagship_damage_mean);
    assert!(split.boss.flagship_damage_mean > none.boss.flagship_damage_mean);
    // Unknown target letters are warned about.
    let odd = simulate_sortie(&boss_sortie(friend_fleet(), json!([{ "squadrons": squadrons, "targets": ["Z"] }])), 10, 1).unwrap();
    assert!(odd.warnings.iter().any(|w| w.contains("target node Z")), "{:?}", odd.warnings);
}

#[test]
fn combined_sortie() {
    let s = simulate_sortie(&boss_sortie(combined(CombinedType::Surface), json!(null)), 300, 2).unwrap();
    assert_eq!(s.friend.len(), 12);
    assert!(s.boss.reach_rate > 0.0);
    // Combined formations are accepted per node; single formations are not.
    let mut ok = boss_sortie(combined(CombinedType::Carrier), json!(null));
    ok.policy.formations.insert("B".into(), Formation::CombinedForward);
    assert!(simulate_sortie(&ok, 10, 1).is_ok());
    ok.policy.formations.insert("B".into(), Formation::LineAhead);
    assert!(simulate_sortie(&ok, 10, 1).unwrap_err().contains("policy.formations.B"));
    // A heavily damaged escort flagship does not force a retreat (it cannot sink).
    let mut tough = boss_sortie(combined(CombinedType::Transport), json!(null));
    tough.policy.retreat.on_heavy = true;
    let es = tough.friend.escort.as_mut().unwrap();
    es[0].hp = Some(5);
    let s = simulate_sortie(&tough, 50, 1).unwrap();
    assert!(s.nodes["A"].retreat_rate < 1.0, "{}", s.nodes["A"].retreat_rate);
}

#[test]
fn validation_errors() {
    let err = |i: &BattleInput| run_battle(i, 1).unwrap_err();
    let mut b = battle(combined(CombinedType::Carrier), enemy_fleet(), BattleKind::Day);
    b.friend.combined = None;
    assert!(err(&b).contains("without combined"), "{}", err(&b));
    let mut b = battle(combined(CombinedType::Carrier), enemy_fleet(), BattleKind::Day);
    b.friend.escort = None;
    assert!(err(&b).contains("1..6 escort"), "{}", err(&b));
    let mut b = battle(combined(CombinedType::Carrier), enemy_fleet(), BattleKind::Day);
    b.friend.escort.as_mut().unwrap().push(friend_dd());
    assert!(err(&b).contains("friend escort fleet has 7 ships (max 6)"), "{}", err(&b));
    let mut b = battle(combined(CombinedType::Carrier), enemy_fleet(), BattleKind::Day);
    b.friend.formation = Some(Formation::LineAhead);
    assert!(err(&b).contains("combined formation"), "{}", err(&b));
    let mut b = battle(friend_fleet(), enemy_fleet(), BattleKind::Day);
    b.friend.formation = Some(Formation::CombinedBattle);
    assert!(err(&b).contains("combined formations need a combined fleet"), "{}", err(&b));
    let mut b = battle(friend_fleet(), enemy_fleet(), BattleKind::Day);
    b.enemy.escort = Some(vec![enemy_dd()]);
    b.enemy.combined = Some(CombinedType::Surface);
    assert!(err(&b).contains("friend fleet only"), "{}", err(&b));
    let mut b = battle(friend_fleet(), enemy_fleet(), BattleKind::Day);
    b.lbas = Some(vec![LandBaseWave { squadrons: vec![land_bomber(); 5] }]);
    assert!(err(&b).contains("5 squadrons (max 4)"), "{}", err(&b));
    b.lbas = Some(vec![bomber_wave(); 7]);
    assert!(err(&b).contains("7 waves (max 6)"), "{}", err(&b));

    let squadrons = json!([land_bomber()]);
    let e = simulate_sortie(&boss_sortie(friend_fleet(), json!(vec![json!({ "squadrons": squadrons, "targets": ["B"] }); 4])), 1, 1).unwrap_err();
    assert!(e.contains("4 land bases (max 3)"), "{e}");
    let e = simulate_sortie(&boss_sortie(friend_fleet(), json!([{ "squadrons": squadrons, "targets": ["A", "B", "B"] }])), 1, 1).unwrap_err();
    assert!(e.contains("3 targets (max 2)"), "{e}");
    // Enemy comps cannot be combined.
    let mut s = boss_sortie(friend_fleet(), json!(null));
    let comp = &mut s.map.nodes.get_mut("B").unwrap().comps.as_mut().unwrap()[0].fleet;
    comp.escort = Some(vec![enemy_dd()]);
    comp.combined = Some(CombinedType::Carrier);
    assert!(simulate_sortie(&s, 1, 1).unwrap_err().contains("friend fleet only"));
}
