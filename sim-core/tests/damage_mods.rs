//! Installation / PT imp / special-target modifiers, smoke screens and barrage balloons
//! (`sim_core::install`, `battle::calc`). Expected values follow kcsim `installRevamp`
//! (kcships `Ship.loadEquips`) and the wikiwiki 発煙装置(煙幕) formulas.

mod common;

use common::*;
use sim_core::battle::calc::{self, Unit, CF_NONE};
use sim_core::equipment::Equip;
use sim_core::install::{self, pt_acc, pt_pow, smoke_rates, InstallMods};
use sim_core::model::*;
use sim_core::ship::{ShipClass, ShipCore};
use sim_core::sim::run_battle;

fn item(id: u32, cat: u32, level: u32) -> Equip {
    let mut e = eq(id, cat, 0, EquipmentStats::default()).unwrap();
    e.improvement = Some(level);
    Equip::from_input(&e)
}

fn mods(class: ShipClass, items: &[Equip]) -> InstallMods {
    InstallMods::derive(items.iter(), class, 0, 0)
}

const WG42: (u32, u32) = (126, 37);
const T3: (u32, u32) = (35, 18);
const DAIHATSU: (u32, u32) = (68, 24);
const TOKU_DAIHATSU: (u32, u32) = (193, 24);
const KAMISHA: (u32, u32) = (167, 46);
const SOUKOUTEI: (u32, u32) = (408, 24);
const ARMED_DAIHATSU: (u32, u32) = (409, 24);
const AP: (u32, u32) = (36, 19);

fn it(e: (u32, u32)) -> Equip {
    item(e.0, e.1, 0)
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn soft_skinned_multipliers() {
    let m = mods(ShipClass::BB, &[it(T3)]);
    assert!(close(m.soft, 2.5) && close(m.flat, 0.0));
    let m = mods(ShipClass::DD, &[it(WG42)]);
    assert!(close(m.soft, 1.3) && close(m.flat, 75.0));
    let m = mods(ShipClass::BB, &[it(T3), it(WG42), it(WG42)]);
    assert!(close(m.soft, 2.5 * 1.3 * 1.4) && close(m.flat, 110.0));
    // Toku Daihatsu: landing craft ×1.4, Toku ×1.15; amphibious tank ×1.5.
    let m = mods(ShipClass::DD, &[it(TOKU_DAIHATSU), it(KAMISHA)]);
    assert!(close(m.soft, 1.4 * 1.15 * 1.5), "{}", m.soft);
    // ★ of landing craft: × (1 + ★avg/50).
    let m = mods(ShipClass::DD, &[item(68, 24, 10)]);
    assert!(close(m.soft, 1.4 * 1.2), "{}", m.soft);
    // Supply depot post-cap: landing craft 1.7 (× ★ bonus).
    assert!(close(mods(ShipClass::DD, &[it(DAIHATSU)]).supply_post, 1.7));
}

#[test]
fn artillery_imp_multipliers() {
    // DD/CL ×1.4, landing craft ×1.8, amphibious tank ×2.4, AP shell ×1.85.
    let m = mods(ShipClass::DD, &[it(DAIHATSU), it(KAMISHA)]);
    assert!(close(m.pillbox, 1.4 * 1.8 * 2.4), "{}", m.pillbox);
    assert!(close(mods(ShipClass::BB, &[it(AP)]).pillbox, 1.85));
    // Isolated island: type 3 shell ×1.75, WG42 ×1.4.
    assert!(close(mods(ShipClass::BB, &[it(T3), it(WG42)]).iso, 1.4 * 1.75));
}

#[test]
fn armored_boat_synergy_and_day_multiplier() {
    // 装甲艇 + 武装大発 + 大発: ×1.3 / +15 on every table, day ×1.1 × 1.1 against soft-skinned.
    let m = mods(ShipClass::DD, &[it(SOUKOUTEI), it(ARMED_DAIHATSU), it(DAIHATSU)]);
    assert!(close(m.flat, 15.0), "{}", m.flat);
    assert!(close(m.soft_day, 1.1 * 1.1));
    assert!(close(m.pillbox_day, 1.3 * 1.2));
    assert!(close(m.supply_post, 1.7 * 1.5 * 1.1), "{}", m.supply_post);
}

fn enemy_install(kind: InstallationKind) -> ShipInput {
    let mut s = ship(10, 1.0, 600, 100.0, 0.0, 50.0, 100.0, 20.0, 0.0, 10.0, vec![]);
    s.id = Some(1653);
    s.installation_kind = Some(kind);
    s
}

#[test]
fn installation_flag_from_kind() {
    let core = ShipCore::new(&enemy_install(InstallationKind::SupplyDepot), false);
    assert!(core.is_installation && core.target.supply_depot);
    let mut off = enemy_install(InstallationKind::Artillery);
    off.is_installation = Some(false);
    assert!(!ShipCore::new(&off, false).is_installation);
    let mut plain = ship(10, 1.0, 600, 100.0, 0.0, 50.0, 100.0, 20.0, 0.0, 10.0, vec![]);
    plain.is_installation = Some(true);
    assert_eq!(ShipCore::new(&plain, false).target.kind, Some(InstallationKind::SoftSkinned));
}

#[test]
fn shelling_power_against_installation() {
    // DD FP 30 + 12.7cm (3) + WG42 against a soft-skinned installation: (33 + 5) × 1.3 + 75.
    let wg = eq(126, 37, 0, EquipmentStats::default());
    let dd = ShipCore::new(&ship(2, 80.0, 32, 30.0, 70.0, 40.0, 30.0, 80.0, 60.0, 15.0, vec![gun_127_dd(), wg]), true);
    let target = ShipCore::new(&enemy_install(InstallationKind::SoftSkinned), false);
    let p = calc::shell_basic_power(&dd, &target, 0.0);
    assert!(close(p, 38.0 * 1.3 + 75.0), "{p}");
    // Night: FP × multiplier + flat (no torpedo).
    let n = calc::night_basic_power(&dd, &target);
    assert!(close(n, 33.0 * 1.3 + 75.0), "{n}");
}

#[test]
fn installations_are_never_torpedoed() {
    let enemy = FleetInput { ships: vec![enemy_install(InstallationKind::Artillery)], ..Default::default() };
    let friend = FleetInput { ships: vec![friend_dd(), friend_dd(), friend_dd()], ..Default::default() };
    let mut input = battle(friend, enemy, BattleKind::Day);
    input.options.log = true;
    let mut shells = 0;
    for seed in 0..50 {
        for e in run_battle(&input, seed).unwrap().result.events.unwrap() {
            if e.attacker_side == Side::Friend {
                assert_ne!(e.kind, AttackKind::Torpedo, "torpedo on an installation");
                shells += (e.kind == AttackKind::Shelling) as u32;
            }
        }
    }
    assert!(shells > 0);
}

fn unit<'a>(core: &'a ShipCore, st: &'a sim_core::ship::ShipState) -> Unit<'a> {
    Unit { core, st, form: Formation::LineAhead, idx: 0, len: 6, cf: CF_NONE, smoke: 0, balloons: 0, bonus: None }
}

#[test]
fn pt_imp_modifiers() {
    let gun = || eq(2, 1, 1, EquipmentStats { firepower: Some(2.0), ..Default::default() });
    let two_guns: Vec<Equip> = [gun(), gun()].iter().map(|e| Equip::from_input(e.as_ref().unwrap())).collect();
    let (dmg, acc) = install::pt_mods(two_guns.iter(), ShipClass::DD);
    assert!(close(dmg, 1.5 * 1.4) && close(acc, 1.3 * 1.15));
    let (_, acc_bb) = install::pt_mods([].iter(), ShipClass::BB);
    assert!(close(acc_bb, 0.7));
    assert!(close(pt_pow(100.0), 30.0 + 10.0 + 10.0));
    assert!(close(pt_acc(0.81), (0.243 + 0.09 + 0.15) * 1.2));

    // Shelling power against a PT imp: transform × ptDmgMod.
    let attacker_in = ship(2, 80.0, 32, 30.0, 70.0, 40.0, 30.0, 80.0, 60.0, 15.0, vec![gun(), gun()]);
    let mut pt_in = ship(2, 1.0, 35, 5.0, 0.0, 0.0, 5.0, 90.0, 0.0, 30.0, vec![]);
    pt_in.pt_imp = Some(true);
    let (a, d) = (ShipCore::new(&attacker_in, true), ShipCore::new(&pt_in, false));
    let (sa, sd) = (a.initial_state(&attacker_in), d.initial_state(&pt_in));
    let mut plain = pt_in.clone();
    plain.pt_imp = None;
    let dp = ShipCore::new(&plain, false);
    let base = calc::shelling_power(&unit(&a, &sa), &unit(&dp, &sd), 1.0, None);
    let vs_pt = calc::shelling_power(&unit(&a, &sa), &unit(&d, &sd), 1.0, None);
    assert!(close(vs_pt, pt_pow(base) * 2.1), "{base} {vs_pt}");
}

#[test]
fn smoke_activation_matches_wiki_examples() {
    // 2 unimproved generators: certain (Pg0 = 0) from flagship luck 26, 20 % failure at luck 25.
    assert!(close(smoke_rates(2.0, 26.0, 0.0, 0.0)[0], 0.0));
    assert!((smoke_rates(2.0, 25.0, 0.0, 0.0)[0] - 0.2).abs() < 1e-9);
    // 3 × Kai ★0/2/3 (n = 6): triple smoke certain from luck 94.
    assert!(close(smoke_rates(6.0, 94.0, 0.0, 5.0)[3], 1.0));
    assert!(smoke_rates(6.0, 93.0, 0.0, 5.0)[3] < 1.0);
    // … plus one generator ★10 (n = 7): from luck 19.
    assert!(close(smoke_rates(7.0, 19.0, 10.0, 5.0)[3], 1.0));
    assert!(smoke_rates(7.0, 18.0, 10.0, 5.0)[3] < 1.0);
    // One generator: single layer only.
    let r = smoke_rates(1.0, 50.0, 0.0, 0.0);
    assert!(close(r[2] + r[3], 0.0) && close(r[0] + r[1], 1.0));
}

#[test]
fn smoke_screen_lowers_shelling_accuracy() {
    let gen = eq(500, 54, 0, EquipmentStats::default());
    let mut dd = friend_dd();
    dd.slots = vec![gun_127_dd(), gen.clone(), gen];
    // n = 2 with flagship luck ≥ 26: always deployed (wikiwiki).
    dd.stats.luck = Some(30.0);
    let friend = FleetInput { ships: vec![dd, friend_dd(), friend_dd(), friend_dd()], ..Default::default() };
    let mut input = battle(friend, enemy_fleet(), BattleKind::Day);
    input.options.log = true;
    input.options.smoke = true;
    let (mut smoked, mut hits, mut shots) = (0, 0, 0);
    for seed in 0..40 {
        let r = run_battle(&input, seed).unwrap().result;
        let Some(layers) = r.smoke else { continue };
        assert!((1..=3).contains(&layers));
        smoked += 1;
        for e in r.events.unwrap() {
            if e.attacker_side == Side::Friend && e.kind == AttackKind::Shelling {
                shots += 1;
                hits += (e.hit != HitResult::Miss) as u32;
                assert!(e.p_hit < 0.2, "friend shelling without radar under smoke: {}", e.p_hit);
            }
        }
    }
    assert!(smoked > 30, "{smoked}");
    assert!(shots > 0 && hits * 5 < shots, "{hits}/{shots}");
    // Once per sortie.
    input.friend.smoke_used = Some(true);
    assert!(run_battle(&input, 1).unwrap().result.smoke.is_none());
}

#[test]
fn balloons_raise_shelling_power() {
    let a_in = friend_bb();
    let a = ShipCore::new(&a_in, true);
    let d = ShipCore::new(&enemy_dd(), false);
    let (sa, sd) = (a.initial_state(&a_in), d.initial_state(&enemy_dd()));
    let mut u = unit(&a, &sa);
    let p0 = calc::shelling_power(&u, &unit(&d, &sd), 1.0, None);
    u.balloons = 2;
    let p2 = calc::shelling_power(&u, &unit(&d, &sd), 1.0, None);
    assert!(close(p2, p0 * 1.04), "{p0} {p2}");
}

#[test]
fn airstrike_target_bonuses() {
    // Dive bomber against a divebombWeak 2.1 target, PT imps and supply depots (random high/low).
    assert_eq!(install::airstrike_target_mod(1501, false, false, true, 2.1), (1.0, 2.1, 2.1));
    assert_eq!(install::airstrike_target_mod(1501, false, false, false, 2.1), (1.0, 1.0, 1.0));
    assert_eq!(install::airstrike_target_mod(1637, true, false, true, 1.0), (0.4, 0.8, 0.5));
    assert_eq!(install::airstrike_target_mod(1921, false, true, false, 1.0), (0.5, 2.4, 1.5));
}

#[test]
fn special_target_groups() {
    // 戦艦夏姫: AP shell ×1.2, seaplane bomber ×1.1.
    let items = [it(AP), item(26, 11, 0)];
    let m = InstallMods::derive(items.iter(), ShipClass::BB, 0, 0);
    assert!(close(m.group(TargetGroup::SummerBattleship), 1.2 * 1.1));
    // Torpedoes skip the anchorage table (kcsim `anchorageTorpNerf`).
    let a_in = friend_dd();
    let a = ShipCore::new(&a_in, true);
    let mut t = enemy_dd();
    t.target_group = Some(TargetGroup::Anchorage);
    assert!(close(calc::torpedo_target_power(&a, &ShipCore::new(&t, false), 100.0), 100.0));
}
