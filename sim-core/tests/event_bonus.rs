//! Event historical bonuses (kcsim `getBonusDmg` / `getBonusAcc` / `bonusSpecialEv` /
//! `getBonusSpecialPlane`) and armor debuffs (kancolle-replay `applyAutoDebuff`).

mod common;

use common::*;
use sim_core::bonus::apply_debuffs;
use sim_core::model::*;
use sim_core::query::{damage_distribution, hit_probability};
use sim_core::sim::run_battle;
use sim_core::sortie::model::NodeKind;
use sim_core::sortie::simulate_sortie;

fn query(kind: &str, attacker: &ShipInput, defender: &ShipInput) -> AttackQuery {
    serde_json::from_value(serde_json::json!({ "kind": kind, "attacker": attacker, "defender": defender, "attackerSide": "friend", "engagement": "sameCourse" })).unwrap()
}

fn bonus(json: serde_json::Value) -> ShipBonusSet {
    serde_json::from_value(json).unwrap()
}

/// Plain ship without equipment: shelling power ⌊FP + 5⌋.
fn gunner(fp: f64) -> ShipInput {
    ship(2, 99.0, 40, fp, 0.0, 0.0, 30.0, 50.0, 0.0, 10.0, vec![])
}

/// Armor-1 dummy: damage ⌊power − 0.7⌋.
fn dummy() -> ShipInput {
    ship(2, 1.0, 999, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, vec![])
}

/// Worked example from kancolle-replay `js/data/bonus/57-5.json` (Summer 2023 E5): a destroyer
/// (`shipType: [2]`) gets `dmg 1.03, acc 1.03, eva 1.05` at every node. Power 100 (FP 95 + 5) →
/// post-cap ×1.03 = 103 → vs armor 1: 102 instead of 99.
#[test]
fn shelling_damage_bonus_57_5_destroyer() {
    let dd = gunner(95.0);
    let mut q = query("shelling", &dd, &dummy());
    assert_eq!(damage_distribution(&q).unwrap().mean_hit, 99.0);
    q.attacker_bonus = Some(bonus(serde_json::json!({ "dmg": 1.03, "acc": 1.03, "eva": 1.05 })));
    assert_eq!(damage_distribution(&q).unwrap().mean_hit, 102.0);
    // The bonus is post-cap: power 250 (capped to 220 + √30 = 225.48 → 225) × 1.03 = 231.75.
    let mut q = query("shelling", &gunner(245.0), &dummy());
    q.attacker_bonus = Some(bonus(serde_json::json!({ "dmg": 1.03 })));
    assert_eq!(damage_distribution(&q).unwrap().mean_hit, (225.0f64 * 1.03 - 0.7).floor());
}

#[test]
fn torpedo_night_and_asw_damage_bonus() {
    let mut torp = ship(2, 99.0, 40, 0.0, 95.0, 0.0, 30.0, 50.0, 0.0, 10.0, vec![]);
    torp.range = Some(1.0);
    let plain = |kind: &str, s: &ShipInput| damage_distribution(&query(kind, s, &dummy())).unwrap().mean_hit;
    let boosted = |kind: &str, s: &ShipInput| {
        let mut q = query(kind, s, &dummy());
        q.attacker_bonus = Some(bonus(serde_json::json!({ "dmg": 2.0 })));
        damage_distribution(&q).unwrap().mean_hit
    };
    // Torpedo: power 95 + 5 = 100 → 200.
    assert_eq!(plain("torpedo", &torp), 99.0);
    assert_eq!(boosted("torpedo", &torp), 199.0);
    // Night: FP + TP = 95 → 190.
    assert_eq!(plain("night", &torp), 94.0);
    assert_eq!(boosted("night", &torp), 189.0);
    // ASW against a submarine: the post-cap ASW power doubles.
    let asw = ship(2, 99.0, 40, 0.0, 0.0, 0.0, 30.0, 50.0, 80.0, 10.0, vec![sonar_93(), dc_type3()]);
    let mut sub = enemy_ss();
    sub.stats.armor = 1.0;
    sub.max_hp = 999;
    let asw_mean = |b: Option<ShipBonusSet>| {
        let mut q = query("asw", &asw, &sub);
        q.attacker_bonus = b;
        damage_distribution(&q).unwrap().mean_hit
    };
    let (p, b) = (asw_mean(None), asw_mean(Some(bonus(serde_json::json!({ "dmg": 2.0 })))));
    assert!(b > 1.9 * p && b < 2.1 * p + 2.0, "{p} {b}");
}

/// `acc` multiplies the hit fraction (hit term ⌊100·h⌋), `eva` the target's dodge fraction.
#[test]
fn accuracy_and_evasion_bonus() {
    let dd = gunner(50.0);
    let target = ship(2, 1.0, 999, 0.0, 0.0, 0.0, 1.0, 60.0, 0.0, 30.0, vec![]);
    let q = query("shelling", &dd, &target);
    let base = hit_probability(&q).unwrap();
    let mut acc = q.clone();
    acc.attacker_bonus = Some(bonus(serde_json::json!({ "acc": 2.0 })));
    let a = hit_probability(&acc).unwrap();
    assert!(a.accuracy == 2.0 * base.accuracy || a.accuracy == 2.0 * base.accuracy + 1.0, "{} {}", base.accuracy, a.accuracy);
    assert_eq!(a.evasion, base.evasion);
    // The defender's evasion bonus (a friend ship under fire).
    let mut ev = query("shelling", &target, &dd);
    ev.attacker_side = Some(Side::Enemy);
    let e0 = hit_probability(&ev).unwrap();
    ev.defender_bonus = Some(bonus(serde_json::json!({ "eva": 1.5 })));
    let e1 = hit_probability(&ev).unwrap();
    assert!(e1.evasion >= (1.5 * e0.evasion).floor() && e1.evasion <= (1.5 * (e0.evasion + 1.0)).floor(), "{} {}", e0.evasion, e1.evasion);
    assert_eq!(e1.accuracy, e0.accuracy);
    // Airstrikes take the ship's accuracy bonus too (event-62 packets; kcsim skips untyped entries).
    let cv = friend_cv();
    let mut air = query("air", &cv, &target);
    air.slot = Some(2);
    let a0 = hit_probability(&air).unwrap();
    air.attacker_bonus = Some(bonus(serde_json::json!({ "acc": 2.0 })));
    let a1 = hit_probability(&air).unwrap();
    assert!(a1.accuracy == 2.0 * a0.accuracy || a1.accuracy == 2.0 * a0.accuracy + 1.0, "{} {}", a0.accuracy, a1.accuracy);
}

/// Plane groups apply while one of their slots has planes; for attacks without planes only
/// `notAirOnly` groups count.
#[test]
fn plane_groups() {
    let cv = friend_cv();
    let mean = |q: &AttackQuery| damage_distribution(q).unwrap().mean_hit;
    let mut q = query("air", &cv, &dummy());
    q.slot = Some(2);
    let plain = mean(&q);
    q.attacker_bonus = Some(bonus(serde_json::json!({ "planes": [{ "slots": [2], "dmg": 2.0 }] })));
    let grouped = mean(&q);
    assert!(grouped > 1.9 * plain, "{plain} {grouped}");
    // The group's slot is empty: no bonus.
    let mut empty = cv.clone();
    empty.slots[2].as_mut().unwrap().planes = Some(0);
    let mut q2 = query("air", &empty, &dummy());
    q2.slot = Some(1);
    let p2 = mean(&q2);
    q2.attacker_bonus = q.attacker_bonus.clone();
    assert_eq!(mean(&q2), p2);

    // A cruiser with a seaplane: shelling does not use planes.
    let mut ca = ship(5, 99.0, 50, 95.0, 0.0, 0.0, 40.0, 50.0, 0.0, 10.0, vec![zero_recon(2)]);
    ca.range = Some(2.0);
    let mut s = query("shelling", &ca, &dummy());
    let p = mean(&s);
    s.attacker_bonus = Some(bonus(serde_json::json!({ "planes": [{ "slots": [0], "dmg": 2.0 }] })));
    assert_eq!(mean(&s), p);
    s.attacker_bonus = Some(bonus(serde_json::json!({ "planes": [{ "slots": [0], "dmg": 2.0, "notAirOnly": true }] })));
    assert!(mean(&s) > 1.9 * p);
}

/// kancolle-replay `57-5.json` `listDebuff` at Y: 2182–2187 −44, 1524… −39, 1509… −13; base armor,
/// floor 1, the last matching entry wins.
#[test]
fn debuff_application_57_5_y() {
    let debuffs: Vec<ArmorDebuff> = serde_json::from_value(serde_json::json!([
        { "shipId": [2182, 2183, 2184, 2185, 2186, 2187], "amount": 44 },
        { "shipId": [1524, 1529, 1557, 1594, 1595, 1779, 1862, 1953, 1954], "amount": 39 },
        { "shipId": [1509, 1591, 1592, 1762, 1764], "amount": 13 }
    ]))
    .unwrap();
    let with_id = |id: u32, ar: f64| {
        let mut s = enemy_ca();
        s.id = Some(id);
        s.stats.armor = ar;
        s
    };
    let mut ships = vec![with_id(2182, 200.0), with_id(1557, 150.0), with_id(1509, 10.0), with_id(1501, 80.0), with_id(1592, 5.0)];
    apply_debuffs(&mut ships, &debuffs);
    assert_eq!(ships.iter().map(|s| s.stats.armor).collect::<Vec<_>>(), vec![156.0, 111.0, 1.0, 80.0, 1.0]);
    // Absent shipId = every ship; the last matching entry wins.
    let mut ships = vec![with_id(1501, 80.0)];
    apply_debuffs(&mut ships, &[ArmorDebuff { ship_id: None, amount: 10.0 }, ArmorDebuff { ship_id: Some(vec![1501]), amount: 30.0 }]);
    assert_eq!(ships[0].stats.armor, 50.0);
}

fn friend_hits(input: &BattleInput, seeds: std::ops::Range<u64>, phase: Option<Phase>) -> Vec<(u64, usize, i32, HitResult)> {
    let mut out = Vec::new();
    for seed in seeds {
        for e in run_battle(input, seed).unwrap().result.events.unwrap() {
            if e.attacker_side == Side::Friend && e.hit != HitResult::Miss && phase.is_none_or(|p| p == e.phase) {
                out.push((seed, e.defender, e.damage, e.hit));
            }
        }
    }
    out
}

#[test]
fn battle_input_bonuses_and_debuffs() {
    // Damage bonus ×2 against armor 0: every normal shelling hit is exactly ⌊55 × 2⌋ = 110.
    let mut dd = gunner(50.0);
    dd.range = Some(1.0);
    let mut target = ship(9, 1.0, 999, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, vec![]);
    target.id = Some(1501);
    let mut input = battle(FleetInput { ships: vec![dd], ..Default::default() }, FleetInput { ships: vec![target.clone()], ..Default::default() }, BattleKind::Day);
    input.options.log = true;
    input.options.engagement = Some(Engagement::SameCourse);
    input.bonuses = Some(vec![Some(bonus(serde_json::json!({ "dmg": 2.0 })))]);
    let hits = friend_hits(&input, 0..20, Some(Phase::Shelling1));
    assert!(!hits.is_empty());
    for (_, _, dmg, hit) in &hits {
        if *hit == HitResult::Hit {
            assert_eq!(*dmg, 110);
        }
    }
    // Debuff: armor 200 → scratch only (≤ 6 % + 8 % of 100 HP); −190 → real damage.
    target.max_hp = 100;
    target.stats.armor = 200.0;
    let mut other = target.clone();
    other.id = Some(1502);
    input.enemy.ships = vec![target, other];
    input.bonuses = None;
    let plain = friend_hits(&input, 0..30, None);
    assert!(plain.iter().all(|h| h.2 <= 14), "{plain:?}");
    input.debuffs = Some(vec![ArmorDebuff { ship_id: Some(vec![1501]), amount: 190.0 }]);
    let debuffed = friend_hits(&input, 0..30, None);
    assert!(debuffed.iter().any(|h| h.1 == 0 && h.2 >= 40), "{debuffed:?}");
    assert!(debuffed.iter().filter(|h| h.1 == 1).all(|h| h.2 <= 14));

    // Validation.
    input.bonuses = Some(vec![None, None]);
    assert!(run_battle(&input, 1).unwrap_err().contains("bonuses"));
    input.bonuses = None;
    input.escort_bonuses = Some(vec![Some(ShipBonusSet::default())]);
    assert!(run_battle(&input, 1).unwrap_err().contains("escortBonuses"));
    input.escort_bonuses = None;
    input.bonuses = Some(vec![Some(bonus(serde_json::json!({ "dmg": -1.0 })))]);
    assert!(run_battle(&input, 1).is_err());
}

/// Escort bonuses address the escort ships (after the main fleet).
#[test]
fn escort_bonuses() {
    let mut dd = gunner(50.0);
    dd.range = Some(1.0);
    let friend = FleetInput {
        ships: vec![dd.clone(), dd.clone()],
        escort: Some(vec![dd.clone(), dd]),
        combined: Some(CombinedType::Surface),
        ..Default::default()
    };
    let target = ship(9, 1.0, 9999, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, vec![]);
    let mut input = battle(friend, FleetInput { ships: vec![target; 6], ..Default::default() }, BattleKind::Day);
    input.options.log = true;
    input.options.engagement = Some(Engagement::SameCourse);
    let run = |input: &BattleInput| {
        let mut by_attacker = [0i64; 4];
        for seed in 0..20 {
            for e in run_battle(input, seed).unwrap().result.events.unwrap() {
                if e.attacker_side == Side::Friend && e.kind == AttackKind::Shelling && e.hit == HitResult::Hit {
                    by_attacker[e.attacker] = by_attacker[e.attacker].max(e.damage as i64);
                }
            }
        }
        by_attacker
    };
    let plain = run(&input);
    input.escort_bonuses = Some(vec![None, Some(bonus(serde_json::json!({ "dmg": 3.0 })))]);
    let boosted = run(&input);
    assert_eq!(boosted[..3], plain[..3]);
    assert!(boosted[3] > 2 * plain[3], "{plain:?} {boosted:?}");
}

/// Land-base squadron damage multiplier: same rolls, damage doubles (armor 0).
#[test]
fn lbas_bonus() {
    let target = ship(9, 1.0, 9999, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, vec![]);
    let mut input = battle(FleetInput { ships: vec![gunner(10.0)], ..Default::default() }, FleetInput { ships: vec![target], ..Default::default() }, BattleKind::Day);
    input.options.log = true;
    input.lbas = Some(vec![LandBaseWave { squadrons: vec![tb_ryuusei(18).unwrap()] }]);
    let plain = friend_hits(&input, 0..30, Some(Phase::LandBase));
    let sets: Vec<Option<BaseBonusSet>> = serde_json::from_value(serde_json::json!([{ "squadrons": [{ "dmg": 2.0 }] }])).unwrap();
    input.lbas_bonuses = Some(sets);
    let boosted = friend_hits(&input, 0..30, Some(Phase::LandBase));
    assert!(!plain.is_empty());
    assert_eq!(plain.len(), boosted.len());
    for (p, b) in plain.iter().zip(&boosted) {
        assert!(b.2 == 2 * p.2 || b.2 == 2 * p.2 + 1, "{p:?} {b:?}");
    }
    input.lbas_bonuses = Some(vec![None, None]);
    assert!(run_battle(&input, 1).is_err());
}

/// Per-node sortie bonuses: a damage penalty (dmg 0.2) at the boss node lowers the boss S rate (the
/// plain fleet already scores ~98 % S); a misplaced escort bonus is rejected.
#[test]
fn sortie_node_bonuses() {
    let mut input = sortie_1_5(fleet_1_5());
    let boss = input.map.nodes.iter().find(|(_, n)| n.boss == Some(true) || n.kind == Some(NodeKind::Boss)).map(|(l, _)| l.clone()).unwrap();
    let plain = simulate_sortie(&input, 2000, 7).unwrap();
    let n = input.friend.ships.len();
    input.map.nodes.get_mut(&boss).unwrap().bonuses = Some(vec![Some(bonus(serde_json::json!({ "dmg": 0.2 }))); n]);
    let weakened = simulate_sortie(&input, 2000, 7).unwrap();
    let s = |x: &sim_core::sortie::model::SortieSummary| x.boss.rank_rates.s + x.boss.rank_rates.ss;
    assert!(s(&weakened) < s(&plain) - 0.1, "{} {}", s(&plain), s(&weakened));
    input.map.nodes.get_mut(&boss).unwrap().escort_bonuses = Some(vec![Some(ShipBonusSet::default())]);
    assert!(simulate_sortie(&input, 10, 7).unwrap_err().contains("escortBonuses"));
}
