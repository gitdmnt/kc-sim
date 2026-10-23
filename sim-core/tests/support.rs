//! Support expeditions (支援艦隊) and friend fleets (友軍艦隊).
mod common;

use common::*;
use serde_json::json;
use sim_core::model::*;
use sim_core::sim::{run_battle, simulate};
use sim_core::sortie::model::*;
use sim_core::sortie::simulate_sortie;

fn fleet(ships: Vec<ShipInput>) -> FleetInput {
    FleetInput { ships, ..Default::default() }
}

fn support(ships: Vec<ShipInput>, chance: Option<f64>) -> SupportInput {
    SupportInput { fleet: fleet(ships), kind: None, chance, boss: None }
}

fn with_support(kind: BattleKind, enemy: FleetInput, s: SupportInput) -> BattleInput {
    let mut b = battle(friend_fleet(), enemy, kind);
    b.support = Some(s);
    b.options.log = true;
    b
}

fn cvl_asw() -> ShipInput {
    let autogyro = plane(69, 25, 21, EquipmentStats { asw: Some(9.0), ..Default::default() }, 8, 0);
    ship(7, 80.0, 50, 30.0, 0.0, 30.0, 30.0, 40.0, 30.0, 10.0, vec![autogyro.clone(), autogyro.clone(), autogyro])
}

fn sub_fleet() -> FleetInput {
    fleet(vec![enemy_ss(), enemy_ss(), enemy_ss()])
}

/// Support events of a logged battle; every one indexes the support fleet.
fn support_events(r: &BattleResult, n: usize) -> Vec<AttackEvent> {
    let ev: Vec<AttackEvent> = r.events.as_ref().unwrap().iter().filter(|e| e.phase == Phase::Support).cloned().collect();
    for e in &ev {
        assert_eq!(e.attacker_side, Side::Friend);
        assert!(e.attacker < n, "{e:?}");
    }
    ev
}

#[test]
fn support_type_from_composition() {
    let kind = |ships: Vec<ShipInput>, enemy: FleetInput| {
        run_battle(&with_support(BattleKind::Day, enemy, support(ships, Some(1.0))), 1).unwrap().result.support.unwrap()
    };
    let arrived = |k: SupportType| SupportResult { arrived: true, kind: Some(k) };
    assert_eq!(kind(vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()], enemy_fleet()), arrived(SupportType::Shelling));
    assert_eq!(kind(vec![friend_ca(), friend_ca(), friend_ca(), friend_ca(), friend_dd(), friend_dd()], enemy_fleet()), arrived(SupportType::Shelling));
    assert_eq!(kind(vec![friend_cl(), friend_cl(), friend_dd(), friend_dd()], enemy_fleet()), arrived(SupportType::Torpedo));
    assert_eq!(kind(vec![friend_cv(), friend_dd(), friend_dd()], enemy_fleet()), arrived(SupportType::Air));
    // A light carrier with ASW planes turns air support into ASW support against submarines.
    assert_eq!(kind(vec![cvl_asw(), friend_cv(), friend_dd(), friend_dd()], sub_fleet()), arrived(SupportType::Asw));
    assert_eq!(kind(vec![cvl_asw(), friend_cv(), friend_dd(), friend_dd()], enemy_fleet()), arrived(SupportType::Air));
    // Fewer than two destroyers: no support.
    assert_eq!(kind(vec![friend_bb(), friend_bb(), friend_dd()], enemy_fleet()), SupportResult { arrived: false, kind: None });
    // Explicit type.
    let mut s = support(vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()], Some(1.0));
    s.kind = Some(SupportType::Torpedo);
    let r = run_battle(&with_support(BattleKind::Day, enemy_fleet(), s), 1).unwrap().result;
    assert_eq!(r.support.unwrap().kind, Some(SupportType::Torpedo));
}

#[test]
fn arrival_chance_from_sparkle_and_override() {
    let rate = |ships: Vec<ShipInput>, chance: Option<f64>, boss: bool| {
        let mut s = support(ships, chance);
        s.boss = Some(boss);
        simulate(&with_support(BattleKind::Day, enemy_fleet(), s), 4000, 5).unwrap().support_rate.unwrap()
    };
    let ships = || vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()];
    assert!((rate(ships(), None, false) - 0.5).abs() < 0.03);
    assert!((rate(ships(), None, true) - 0.85).abs() < 0.03);
    let mut sparkled = ships();
    sparkled[0].morale = Some(50);
    sparkled[1].morale = Some(53);
    // 50% + 15% flagship + 5% per other sparkled ship.
    assert!((rate(sparkled, None, false) - 0.7).abs() < 0.03);
    assert_eq!(rate(ships(), Some(0.0), false), 0.0);
    assert_eq!(rate(ships(), Some(1.0), false), 1.0);
}

#[test]
fn shelling_support_hits_with_support_indexes_and_no_credit() {
    let ships = vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()];
    let mut total = 0;
    for seed in 0..20 {
        let r = run_battle(&with_support(BattleKind::Day, enemy_fleet(), support(ships.clone(), Some(1.0))), seed).unwrap().result;
        let ev = support_events(&r, 4);
        assert!(!ev.is_empty() && ev.iter().all(|e| e.kind == AttackKind::Shelling));
        // Support comes before the opening ASW / torpedo phases.
        let all = r.events.as_ref().unwrap();
        let last_support = all.iter().rposition(|e| e.phase == Phase::Support).unwrap();
        assert!(all[..last_support].iter().all(|e| matches!(e.phase, Phase::Support | Phase::AirStrike | Phase::LandBase)));
        // Support damage is not credited to the friend ships.
        let friend_dealt: i32 = r.friend.iter().map(|s| s.damage_dealt).sum();
        let logged: i32 = all.iter().filter(|e| e.attacker_side == Side::Friend && e.phase != Phase::Support).map(|e| e.damage).sum();
        assert_eq!(friend_dealt, logged);
        total += ev.iter().map(|e| e.damage).sum::<i32>();
    }
    assert!(total > 500, "{total}");
}

#[test]
fn torpedo_support_is_scratch_damage() {
    let ships = vec![friend_cl(), friend_cl(), friend_dd(), friend_dd()];
    let mut hits = 0;
    for seed in 0..30 {
        let r = run_battle(&with_support(BattleKind::Day, enemy_fleet(), support(ships.clone(), Some(1.0))), seed).unwrap().result;
        for e in support_events(&r, 4) {
            assert_eq!(e.kind, AttackKind::Torpedo);
            if e.hit != HitResult::Miss {
                hits += 1;
                let hp = e.defender_hp_before as f64;
                assert!((e.damage as f64) <= (hp * 0.06 + 0.08 * (hp - 1.0)).floor(), "{e:?}");
            }
        }
    }
    assert!(hits > 10);
}

#[test]
fn air_support_strikes_surface_ships() {
    let ships = vec![friend_cv(), friend_cv(), friend_dd(), friend_dd()];
    let mut total = 0;
    for seed in 0..20 {
        let r = run_battle(&with_support(BattleKind::Day, enemy_fleet(), support(ships.clone(), Some(1.0))), seed).unwrap().result;
        for e in support_events(&r, 4) {
            assert_eq!(e.kind, AttackKind::Air);
            assert!(e.slot.is_some());
            total += e.damage;
        }
    }
    assert!(total > 500, "{total}");
}

#[test]
fn asw_support_attacks_submarines() {
    let ships = vec![cvl_asw(), cvl_asw(), friend_dd(), friend_dd()];
    let mut total = 0;
    for seed in 0..20 {
        let r = run_battle(&with_support(BattleKind::Day, sub_fleet(), support(ships.clone(), Some(1.0))), seed).unwrap().result;
        let ev = support_events(&r, 4);
        assert!(!ev.is_empty());
        for e in ev {
            assert_eq!(e.kind, AttackKind::Asw);
            assert!(e.defender < 3);
            total += e.damage;
        }
    }
    assert!(total > 100, "{total}");
}

#[test]
fn support_node_kinds() {
    let shell = || support(vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()], Some(1.0));
    let air = || support(vec![friend_cv(), friend_cv(), friend_dd(), friend_dd()], Some(1.0));
    let res = |kind: BattleKind, s: SupportInput| run_battle(&with_support(kind, enemy_fleet(), s), 3).unwrap().result.support;
    // Night-only nodes: shelling / torpedo support before the night battle, no air support.
    let r = run_battle(&with_support(BattleKind::NightOnly, enemy_fleet(), shell()), 3).unwrap().result;
    assert_eq!(r.support.unwrap().kind, Some(SupportType::Shelling));
    assert_eq!(r.events.as_ref().unwrap()[0].phase, Phase::Support);
    assert_eq!(res(BattleKind::NightOnly, air()), None);
    // Air raid nodes: no support. Aerial battle nodes: air support only, between the two air phases.
    assert_eq!(res(BattleKind::AirBattle, shell()), None);
    assert_eq!(res(BattleKind::AirRaid, air()), None);
    let r = run_battle(&with_support(BattleKind::AirBattle, enemy_fleet(), air()), 3).unwrap().result;
    assert_eq!(r.support, Some(SupportResult { arrived: true, kind: Some(SupportType::Air) }));
    let ev = r.events.as_ref().unwrap();
    let first = ev.iter().position(|e| e.phase == Phase::Support).unwrap();
    assert!(ev[..first].iter().all(|e| e.phase == Phase::AirStrike));
}

fn support_results(s: SupportInput, kind: BattleKind, seeds: u64) -> Vec<BattleResult> {
    (0..seeds).map(|seed| run_battle(&with_support(kind, enemy_fleet(), s.clone()), seed).unwrap().result).collect()
}

#[test]
fn support_shelling_ignores_improvement_and_bonus_accuracy() {
    let bb = |improve: u32, bonus: EquipmentStats| {
        let mut s = friend_bb();
        for e in s.slots.iter_mut().flatten() {
            e.improvement = Some(improve);
        }
        s.equip_bonus = Some(bonus);
        s
    };
    let fleet = |improve: u32, bonus: EquipmentStats| support(vec![bb(improve, bonus.clone()), bb(improve, bonus), friend_dd(), friend_dd()], Some(1.0));
    let plain = support_results(fleet(0, EquipmentStats::default()), BattleKind::Day, 20);
    let acc = EquipmentStats { accuracy: Some(6.0), ..Default::default() };
    assert_eq!(support_results(fleet(10, acc), BattleKind::Day, 20), plain);
    // Equipment-bonus firepower does count.
    let fp = EquipmentStats { firepower: Some(10.0), ..Default::default() };
    let dmg = |rs: &[BattleResult]| rs.iter().flat_map(|r| support_events(r, 4)).map(|e| e.damage).sum::<i32>();
    assert!(dmg(&support_results(fleet(0, fp), BattleKind::Day, 20)) > dmg(&plain));
}

#[test]
fn air_support_fighter_power_ignores_proficiency_and_improvement() {
    // Proficiency on every plane; improvement on the fighters (fighter-power bonus only — bomber
    // improvement raises airstrike power, kcsim `airstrikePowerImprove`).
    let cv = |prof: u32, improve: u32| {
        let mut s = friend_cv();
        for e in s.slots.iter_mut().flatten() {
            e.proficiency = Some(prof);
            if e.types[2] == 6 {
                e.improvement = Some(improve);
            }
        }
        s
    };
    let fleet = |prof, improve| support(vec![cv(prof, improve), cv(prof, improve), friend_dd(), friend_dd()], Some(1.0));
    // An enemy carrier makes the support air state depend on fighter power.
    let mut enemy_cv = ship(11, 1.0, 90, 30.0, 0.0, 40.0, 50.0, 30.0, 0.0, 10.0, vec![]);
    enemy_cv.slots = vec![plane(1525, 6, 6, EquipmentStats { anti_air: Some(9.0), ..Default::default() }, 40, 0); 3];
    let enemy = fleet_of(vec![enemy_cv, enemy_ca(), enemy_dd()]);
    let run = |s: SupportInput| (0..20).map(|seed| run_battle(&with_support(BattleKind::Day, enemy.clone(), s.clone()), seed).unwrap().result).collect::<Vec<_>>();
    let base = run(fleet(0, 0));
    assert_eq!(run(fleet(7, 0)), base);
    assert_eq!(run(fleet(0, 10)), base);
}

fn fleet_of(ships: Vec<ShipInput>) -> FleetInput {
    FleetInput { ships, ..Default::default() }
}

#[test]
fn air_support_shoots_down_enemy_planes() {
    let mut enemy_cv = ship(11, 1.0, 300, 30.0, 0.0, 40.0, 150.0, 30.0, 0.0, 10.0, vec![]);
    enemy_cv.slots = vec![plane(1525, 6, 6, EquipmentStats { anti_air: Some(5.0), ..Default::default() }, 40, 0); 3];
    let enemy = fleet_of(vec![enemy_cv]);
    let fighters = |chance: f64| {
        // Air support needs a bomber to take place at all (wikiwiki 支援艦隊).
        let mut cv = friend_cv();
        cv.slots = vec![fighter_reppu(30), fighter_reppu(30), fighter_reppu(30), tb_ryuusei(30)];
        support(vec![cv.clone(), cv, friend_dd(), friend_dd()], Some(chance))
    };
    let left = |chance: f64| -> f64 {
        let mut b = with_support(BattleKind::Day, enemy.clone(), fighters(chance));
        b.friend = fleet_of(vec![friend_bb()]);
        (0..200)
            .map(|seed| {
                let st = run_battle(&b, seed).unwrap().state;
                st.enemy.ships[0].slots.iter().flatten().map(|e| e.planes.unwrap_or(0)).sum::<i32>() as f64
            })
            .sum::<f64>()
            / 200.0
    };
    let (with, without) = (left(1.0), left(0.0));
    // Support at air supremacy: enemy stage 1 losses of up to 10 × (0.35 + 0.65) / 10 per plane.
    assert!(with < without - 10.0, "{with} {without}");
}

#[test]
fn outputs_only_with_inputs_and_plain_stream_unchanged() {
    let plain = battle(friend_fleet(), enemy_fleet(), BattleKind::DayNight);
    let r = run_battle(&plain, 9).unwrap().result;
    assert!(r.support.is_none() && r.friend_fleet.is_none());
    let s = simulate(&plain, 200, 9).unwrap();
    assert!(s.support_rate.is_none() && s.friend_fleet_rate.is_none());
    let js = serde_json::to_value(&s).unwrap();
    assert!(js.get("supportRate").is_none() && js.get("friendFleetRate").is_none());
    // A friend fleet that never fights (day-only battle) consumes no random numbers.
    let mut ff = battle(friend_fleet(), enemy_fleet(), BattleKind::Day);
    let base = simulate(&ff, 300, 4).unwrap();
    ff.friend_fleet = Some(FriendFleetInput { fleet: fleet(vec![friend_bb()]), chance: None, nodes: None });
    let with = simulate(&ff, 300, 4).unwrap();
    assert_eq!(with.friend_fleet_rate, Some(0.0));
    assert_eq!((with.friend, with.enemy, with.rank_rates), (base.friend, base.enemy, base.rank_rates));
}

#[test]
fn invalid_inputs() {
    let mut b = with_support(BattleKind::Day, enemy_fleet(), support(vec![friend_dd(), friend_dd()], Some(1.5)));
    assert!(run_battle(&b, 1).is_err());
    b.support = Some(support(vec![friend_dd(); 7], None));
    assert!(run_battle(&b, 1).is_err());
    b.support = None;
    b.friend_fleet = Some(FriendFleetInput { fleet: fleet(vec![friend_dd()]), chance: Some(-0.1), nodes: None });
    assert!(run_battle(&b, 1).is_err());
}

fn sortie(support: serde_json::Value, ff: serde_json::Value) -> SortieInput {
    let routing = json!({
        "map": "9-9", "sources": [{ "id": "t", "note": "test" }],
        "nodes": { "Start": { "rules": [{ "to": "A" }] }, "A": { "rules": [{ "to": "B" }] }, "B": { "end": true } }
    });
    let mut weak = enemy_fleet();
    weak.ships.truncate(2);
    let mut v = json!({
        "friend": friend_fleet(), "hqLevel": 100,
        "map": { "routing": routing, "nodes": {
            "A": { "kind": "battle", "comps": [{ "weight": 1.0, "fleet": weak }] },
            "B": { "kind": "boss", "comps": [{ "weight": 1.0, "fleet": enemy_fleet() }] }
        } },
        "policy": { "retreat": { "onHeavy": false } }
    });
    if !support.is_null() {
        v["support"] = support;
    }
    if !ff.is_null() {
        v["friendFleet"] = ff;
    }
    serde_json::from_value(v).unwrap()
}

#[test]
fn sortie_node_and_boss_support() {
    let sup = support(vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()], Some(1.0));
    let s = simulate_sortie(&sortie(json!({ "node": sup }), json!(null)), 200, 1).unwrap();
    assert_eq!(s.nodes["A"].support_rate, Some(1.0));
    assert_eq!(s.nodes["B"].support_rate, Some(0.0));
    let s = simulate_sortie(&sortie(json!({ "boss": sup }), json!(null)), 200, 1).unwrap();
    assert_eq!(s.nodes["A"].support_rate, Some(0.0));
    assert_eq!(s.nodes["B"].support_rate, Some(1.0));
    assert!(s.nodes["A"].friend_fleet_rate.is_none());
    let s = simulate_sortie(&sortie(json!(null), json!(null)), 50, 1).unwrap();
    assert!(s.nodes["B"].support_rate.is_none());
}

#[test]
fn sortie_support_costs() {
    let amounts = |f: f64, a: f64, b: f64| ResourceAmounts { fuel: f, ammo: a, steel: 0.0, bauxite: b };
    // Shelling support (BB fuel 100 / ammo 130, DD 100 / 100): ⌈50%⌉ fuel, ⌈80%⌉ ammo (< 3 CV/CVL/AV),
    // paid every sortie even when it never arrives; node and boss each.
    let shell = support(vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()], Some(0.0));
    let s = simulate_sortie(&sortie(json!({ "node": shell }), json!(null)), 50, 1).unwrap();
    assert_eq!(s.nodes["A"].support_rate, Some(0.0));
    assert_eq!(s.support_cost_mean, Some(amounts(200.0, 104.0 * 2.0 + 80.0 * 2.0, 0.0)));
    let s = simulate_sortie(&sortie(json!({ "node": shell, "boss": shell }), json!(null)), 50, 1).unwrap();
    assert_eq!(s.support_cost_mean, Some(amounts(400.0, 736.0, 0.0)));
    // Marriage discount on the refill: Lv 100 → ⌊0.85 × 50⌋ = 42, ⌊0.85 × 104⌋ = 88.
    let mut married = friend_bb();
    married.level = Some(100.0);
    let wed = support(vec![married, friend_bb(), friend_dd(), friend_dd()], Some(0.0));
    let s = simulate_sortie(&sortie(json!({ "node": wed }), json!(null)), 50, 1).unwrap();
    assert_eq!(s.support_cost_mean, Some(amounts(192.0, 88.0 + 104.0 + 160.0, 0.0)));
    // Three carriers: ⌈40%⌉ ammo; planes lost to enemy AA cost 5 bauxite each, inside the totals.
    let air = support(vec![friend_cv(), friend_cv(), friend_cv(), friend_dd(), friend_dd()], Some(1.0));
    let s = simulate_sortie(&sortie(json!({ "node": air }), json!(null)), 200, 1).unwrap();
    let c = s.support_cost_mean.unwrap();
    assert_eq!((c.fuel, c.ammo), (250.0, 200.0));
    assert!(c.bauxite > 0.0, "{c:?}");
    assert!(s.resources_per_sortie.bauxite.mean >= c.bauxite && s.resources_per_sortie.fuel.mean >= c.fuel);
    assert!(simulate_sortie(&sortie(json!(null), json!(null)), 10, 1).unwrap().support_cost_mean.is_none());
}

#[test]
fn sortie_friend_fleet_nodes() {
    let ff = FriendFleetInput { fleet: fleet(vec![friend_bb(), friend_ca()]), chance: None, nodes: None };
    // Default: the goal node only; the boss night battle happens whenever the enemy survives.
    let s = simulate_sortie(&sortie(json!(null), json!(ff)), 300, 2).unwrap();
    let b = &s.nodes["B"];
    assert_eq!(b.friend_fleet_rate, Some(b.night_rate));
    assert!(b.night_rate > 0.2, "{b:?}");
    assert_eq!(s.nodes["A"].friend_fleet_rate, Some(0.0));
    let mut ff2 = ff.clone();
    ff2.nodes = Some(vec!["A".into(), "Z".into()]);
    let s = simulate_sortie(&sortie(json!(null), json!(ff2)), 50, 2).unwrap();
    assert_eq!(s.nodes["B"].friend_fleet_rate, Some(0.0));
    assert!(s.warnings.iter().any(|w| w.contains("friendFleet: node Z")));
}

fn strong_ff() -> FriendFleetInput {
    FriendFleetInput { fleet: fleet(vec![friend_bb(), friend_bb(), friend_ca(), friend_ca(), friend_cl(), friend_dd()]), chance: None, nodes: None }
}

#[test]
fn friend_fleet_fights_only_at_night() {
    let mut b = battle(fleet(vec![friend_dd()]), enemy_fleet(), BattleKind::DayNight);
    b.friend_fleet = Some(strong_ff());
    b.options.log = true;
    let (mut fought, mut quiet) = (0, 0);
    for seed in 0..40 {
        let r = run_battle(&b, seed).unwrap().result;
        let ev = r.events.as_ref().unwrap();
        let ff: Vec<&AttackEvent> = ev.iter().filter(|e| e.phase == Phase::FriendFleet).collect();
        assert_eq!(r.friend_fleet, Some(r.night_battle));
        if r.night_battle {
            fought += 1;
            assert!(!ff.is_empty());
            // Before the player's night battle.
            let first_night = ev.iter().position(|e| e.phase == Phase::Night).unwrap_or(ev.len());
            assert!(ev[first_night..].iter().all(|e| e.phase == Phase::Night));
            for e in ff {
                assert!(if e.attacker_side == Side::Friend { e.attacker < 6 } else { e.defender < 6 }, "{e:?}");
            }
        } else {
            quiet += 1;
            assert!(ff.is_empty());
        }
    }
    assert!(fought > 0, "{fought} {quiet}");
    let mut day = b.clone();
    day.options.kind = BattleKind::Day;
    assert_eq!(run_battle(&day, 1).unwrap().result.friend_fleet, Some(false));
    let mut never = b.clone();
    never.friend_fleet.as_mut().unwrap().chance = Some(0.0);
    assert_eq!(simulate(&never, 100, 1).unwrap().friend_fleet_rate, Some(0.0));
}

#[test]
fn friend_fleet_cannot_sink_the_last_enemy() {
    // The player's carrier cannot attack at night: only the friend fleet damages the enemy.
    let mut b = battle(fleet(vec![friend_cv()]), enemy_fleet(), BattleKind::NightOnly);
    b.friend_fleet = Some(strong_ff());
    b.options.log = true;
    let mut big_wins = 0;
    for seed in 0..200 {
        let r = run_battle(&b, seed).unwrap().result;
        assert_eq!(r.friend_fleet, Some(true));
        let afloat = r.enemy.iter().filter(|s| s.hp_end > 0).count();
        assert!(afloat >= 1, "seed {seed}");
        big_wins += (afloat == 1) as u32;
    }
    assert!(big_wins > 0, "{big_wins}");
}

#[test]
fn friend_fleet_rerolls_the_enemy_flagship() {
    // Durable targets: compare how often the flagship is hit by the friend fleet and by the player.
    let mut tank = enemy_bb();
    tank.max_hp = 2000;
    tank.stats.armor = 300.0;
    let enemy = fleet(vec![tank.clone(), tank.clone(), tank.clone(), tank.clone(), tank.clone(), tank]);
    let mut b = battle(friend_fleet(), enemy, BattleKind::NightOnly);
    b.friend_fleet = Some(strong_ff());
    b.options.log = true;
    let (mut ff, mut ff_flag, mut pl, mut pl_flag) = (0, 0, 0, 0);
    for seed in 0..400 {
        let r = run_battle(&b, seed).unwrap().result;
        for e in r.events.as_ref().unwrap().iter().filter(|e| e.attacker_side == Side::Friend) {
            let flag = (e.defender == 0) as u32;
            if e.phase == Phase::FriendFleet {
                ff += 1;
                ff_flag += flag;
            } else {
                pl += 1;
                pl_flag += flag;
            }
        }
    }
    let (ff_rate, pl_rate) = (ff_flag as f64 / ff as f64, pl_flag as f64 / pl as f64);
    // 1/6 × 1/6 × (1 − 45% line-ahead protection) ≈ 1.5% vs 1/6 × 55% ≈ 9%.
    assert!(ff_rate < 0.03 && pl_rate > 0.06, "{ff_rate} {pl_rate}");
}

#[test]
fn friend_fleet_ships_are_never_sunk() {
    // Battleships against a destroyer friend fleet: lethal hits are replaced (player sinking protection).
    let enemy = fleet(vec![enemy_bb(), enemy_bb(), enemy_bb(), enemy_bb(), enemy_bb(), enemy_bb()]);
    let mut b = battle(fleet(vec![friend_cv()]), enemy, BattleKind::NightOnly);
    let dd = |hp: i32| ShipInput { hp: Some(hp), ..friend_dd() };
    // The 4th ship starts heavily damaged: unprotected.
    b.friend_fleet = Some(FriendFleetInput { fleet: fleet(vec![dd(32), dd(32), dd(32), dd(7), dd(32), dd(32)]), chance: None, nodes: None });
    b.options.log = true;
    let (mut hits, mut sunk_taiha) = (0, 0);
    for seed in 0..300 {
        let r = run_battle(&b, seed).unwrap().result;
        for e in r.events.as_ref().unwrap().iter().filter(|e| e.phase == Phase::FriendFleet && e.attacker_side == Side::Enemy && e.damage > 0) {
            hits += 1;
            if e.defender == 3 {
                sunk_taiha += (e.defender_hp_after == 0) as u32;
            } else {
                assert!(e.defender_hp_after > 0, "seed {seed}: {e:?}");
            }
        }
    }
    assert!(hits > 50 && sunk_taiha > 0, "{hits} {sunk_taiha}");
}

#[test]
fn friend_fleet_event_bonuses() {
    let mut b = battle(fleet(vec![friend_cv()]), enemy_fleet(), BattleKind::NightOnly);
    b.friend_fleet = Some(strong_ff());
    b.options.log = true;
    let ff_damage = |b: &BattleInput| -> i64 {
        (0..200)
            .flat_map(|seed| run_battle(b, seed).unwrap().result.events.unwrap())
            .filter(|e| e.phase == Phase::FriendFleet && e.attacker_side == Side::Friend)
            .map(|e| e.damage as i64)
            .sum()
    };
    let plain = ff_damage(&b);
    let set = serde_json::from_value::<ShipBonusSet>(json!({ "dmg": 2.0 })).unwrap();
    b.friend_fleet_bonuses = Some(vec![Some(set.clone()); 6]);
    let boosted = ff_damage(&b);
    assert!(boosted as f64 > 1.3 * plain as f64, "{plain} {boosted}");
    // More entries than friend fleet ships: an error, in battles and at sortie nodes.
    b.friend_fleet_bonuses = Some(vec![Some(set); 7]);
    assert!(run_battle(&b, 1).unwrap_err().contains("friendFleetBonuses"));
    let mut s = sortie(json!(null), json!(strong_ff()));
    s.map.nodes.get_mut("B").unwrap().friend_fleet_bonuses = Some(vec![None; 7]);
    assert!(simulate_sortie(&s, 10, 1).unwrap_err().contains("node B friendFleetBonuses"));
}

#[test]
fn friend_fleet_night_zuiun_cut_in() {
    let night_zuiun = || plane(490, 11, 10, EquipmentStats { firepower: Some(3.0), bombing: Some(11.0), ..Default::default() }, 4, 0);
    let cav = ship(6, 99.0, 70, 70.0, 20.0, 60.0, 70.0, 50.0, 0.0, 40.0, vec![gun_203(), gun_203(), night_zuiun(), night_zuiun(), radar_22()]);
    let mut b = battle(fleet(vec![friend_cv()]), enemy_fleet(), BattleKind::NightOnly);
    b.friend_fleet = Some(FriendFleetInput { fleet: fleet(vec![cav]), chance: None, nodes: None });
    b.options.log = true;
    let nz: usize = (0..200)
        .map(|seed| run_battle(&b, seed).unwrap().result.events.unwrap())
        .map(|ev| ev.iter().filter(|e| e.phase == Phase::FriendFleet && e.special == SpecialAttack::NightZuiunZzr).count())
        .sum();
    assert!(nz > 0);
}

fn enemy_with_escort() -> FleetInput {
    let tough = |mut s: ShipInput| {
        s.max_hp = 400;
        s
    };
    FleetInput {
        ships: [enemy_bb(), enemy_ca(), enemy_ca(), enemy_cl(), enemy_dd(), enemy_dd()].into_iter().map(tough).collect(),
        escort: Some([enemy_cl(), enemy_dd(), enemy_dd(), enemy_dd(), enemy_dd(), enemy_dd()].into_iter().map(tough).collect()),
        ..Default::default()
    }
}

#[test]
fn shelling_support_vs_enemy_escort() {
    let s = support(vec![friend_bb(), friend_bb(), friend_ca(), friend_ca(), friend_dd(), friend_dd()], Some(1.0));
    let b = with_support(BattleKind::Day, enemy_with_escort(), s);
    let (mut escort, mut total) = (0, 0);
    for seed in 0..300 {
        let r = run_battle(&b, seed).unwrap().result;
        for e in support_events(&r, 6) {
            total += 1;
            escort += (e.defender >= 6) as u32;
            // By day only main-fleet ships cover the main flagship (kcsim `includeEscort` unset).
            if e.covered {
                assert!(e.defender < 6, "{e:?}");
            }
        }
    }
    // kcsim `supportPhase`: main 40% / escort 60% per ship.
    let rate = escort as f64 / total as f64;
    assert!((rate - 0.6).abs() < 0.04, "{rate}");
}

#[test]
fn night_to_day_support_and_friend_fleet() {
    let phases = |r: &BattleResult| r.events.as_ref().unwrap().iter().map(|e| e.phase).collect::<Vec<_>>();
    let pos = |p: &[Phase], x: Phase| p.iter().position(|&q| q == x);
    let shell = support(vec![friend_bb(), friend_bb(), friend_dd(), friend_dd()], Some(1.0));
    let air = support(vec![friend_cv(), friend_cv(), friend_dd(), friend_dd()], Some(1.0));
    for enemy in [enemy_fleet(), enemy_with_escort()] {
        // Shelling support and the friend fleet come first, before the night battle.
        let mut b = with_support(BattleKind::NightToDay, enemy.clone(), shell.clone());
        b.friend_fleet = Some(strong_ff());
        let r = run_battle(&b, 2).unwrap().result;
        assert_eq!(r.support.unwrap().kind, Some(SupportType::Shelling));
        assert_eq!(r.friend_fleet, Some(true));
        let p = phases(&r);
        assert_eq!(p[0], Phase::Support);
        let (ff, night) = (pos(&p, Phase::FriendFleet).unwrap(), pos(&p, Phase::Night).unwrap());
        assert!(p[..ff].iter().all(|&q| q == Phase::Support) && ff < night, "{p:?}");
        // Air support only once the day part starts, before the air phase.
        for seed in 0..20 {
            let r = run_battle(&with_support(BattleKind::NightToDay, enemy.clone(), air.clone()), seed).unwrap().result;
            let p = phases(&r);
            match pos(&p, Phase::Support) {
                Some(first) => {
                    assert_eq!(r.support.unwrap().kind, Some(SupportType::Air));
                    assert!(p[..first].iter().all(|&q| q == Phase::Night), "{p:?}");
                    assert!(p[first..].iter().all(|&q| q != Phase::Night));
                }
                // No day part (the enemy escort stayed strong or a side was wiped out).
                None => assert!(r.support.is_none() && !p.contains(&Phase::AirStrike), "{p:?}"),
            }
        }
    }
}
