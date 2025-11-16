mod utils;

use log::{debug, error, info, warn};
use rand::random_range;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

trait FleetTrait {
    fn ships(&self) -> &Vec<Ship>;
}

impl FleetTrait for Fleet {
    fn ships(&self) -> &Vec<Ship> {
        &self.ships
    }
}
impl FleetTrait for EnemyFleet {
    fn ships(&self) -> &Vec<Ship> {
        &self.ships
    }
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Fleet {
    ships: Vec<Ship>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct EnemyFleet {
    area: u16,
    map: u16,
    node: String,
    probability: f64,
    ships: Vec<Ship>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct Ship {
    eugen_id: u16,
    ship_type_id: u16,
    status: ShipStatus,
    equips: Vec<Equip>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ShipStatus {
    hp: u16,
    firepower: u16,
    armor: u16,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct Equip {
    eugen_id: u16,
    equip_type_id: u16,
    status: EquipStatus,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct EquipStatus {
    firepower: u16,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct BattleResult {
    result: Option<u16>, // 0-6 SS, S, A, B, C, D, E
    friend_fleet_results: Vec<ShipResult>,
    enemy_index: usize,
    enemy_fleet_results: Vec<ShipResult>,
}

// 戦闘中の艦船の状態を管理する構造体
struct FightingShip {
    ship: Ship,
    is_friend: bool,
    index_in_fleet: usize,
    result: ShipResult,
}

impl FightingShip {
    fn new(ship: Ship, is_friend: bool, index_in_fleet: usize) -> Self {
        let result = ShipResult::from(&ship);
        Self {
            ship,
            is_friend,
            index_in_fleet,
            result,
        }
    }

    fn is_alive(&self) -> bool {
        self.result.hp > 0
    }
}

// 戦闘の進行を管理する構造体
struct Battle {
    friend_fleet: Vec<FightingShip>,
    enemy_fleet: Vec<FightingShip>,
    enemy_index: usize,
}

impl Battle {
    fn new(friend: &dyn FleetTrait, enemy_index: usize, enemy: &dyn FleetTrait) -> Self {
        Self {
            friend_fleet: friend
                .ships()
                .iter()
                .enumerate()
                .map(|(i, ship)| FightingShip::new(ship.clone(), true, i))
                .collect(),
            enemy_fleet: enemy
                .ships()
                .iter()
                .enumerate()
                .map(|(i, ship)| FightingShip::new(ship.clone(), false, i))
                .collect(),
            enemy_index,
        }
    }

    fn fire_order(&self) -> Vec<(bool, usize)> {
        let mut order = self
            .friend_fleet
            .iter()
            .enumerate()
            .map(|(i, fs)| (true, i, fs.ship.status.firepower))
            .chain(
                self.enemy_fleet
                    .iter()
                    .enumerate()
                    .map(|(i, fs)| (false, i, fs.ship.status.firepower)),
            )
            .collect::<Vec<_>>();

        order.sort_by_key(|a| std::cmp::Reverse(a.2));
        let order = order
            .iter()
            .map(|(is_friend, i, _)| (*is_friend, *i))
            .collect::<Vec<_>>();
        order
    }

    // 砲撃戦1巡目
    fn fire_phase1(&mut self) {
        if self.friend_fleet.is_empty() || self.enemy_fleet.is_empty() {
            debug!("One of the fleets is empty, skipping fire phase 1");
            return;
        }

        // 砲撃順決定 (is_friend, index_in_fleet, key_for_sort)
        // TODO: 火力順になってるから射程順に修正する
        let fire_order = self.fire_order();
        debug!("Fire order: {:?}", fire_order);

        for (actor_is_friend, actor_idx) in fire_order.into_iter() {
            let (actor_fleet, target_fleet) = if actor_is_friend {
                (&self.friend_fleet, &mut self.enemy_fleet)
            } else {
                (&self.enemy_fleet, &mut self.friend_fleet)
            };

            // 攻撃者が行動不能ならスキップ
            if !actor_fleet[actor_idx].is_alive() {
                continue;
            }

            let actor = &actor_fleet[actor_idx].ship;

            // ターゲット決定
            let alive_targets_count = target_fleet.iter().filter(|t| t.is_alive()).count();
            if alive_targets_count == 0 {
                debug!("All targets are sunk, skipping attack");
                continue;
            }
            let random_index =
                random_range(0..target_fleet.iter().filter(|t| t.is_alive()).count());
            let target = target_fleet
                .iter_mut()
                .filter(|t| t.is_alive())
                .nth(random_index)
                .unwrap();

            // 火力計算
            let firepower = actor.status.firepower as f64;
            let firepower = firepower; // キャップ前補正
            let firepower =
                firepower.min(220.0) + f64::floor(f64::sqrt((firepower - 220.0).max(0.0))); // キャップ処理
            let firepower = firepower; // キャップ後補正

            // 防御力計算
            let r: f64 = rand::random();
            let armor = target.ship.status.armor as f64;
            let armor = armor * 0.7 + f64::floor(armor * r) * 0.6;

            // ダメージ計算
            let damage = f64::floor(firepower - armor);

            let hp_now = target.result.hp as f64;

            let damage = if damage > 0.0 {
                damage
            } else {
                // カスダメ化
                let r = rand::random::<f64>();
                hp_now * 0.06 + f64::floor(hp_now * r) * 0.08
            };

            // HP減少処理
            let hp_before = target.result.hp;
            target.result.hp = target.result.hp.saturating_sub(damage as u16);

            debug!(
                "\n{}-{} --fired-> {}-{}\nfp: {}, armor: {}, damage {}\ntarget HP {} -> {}",
                if actor_is_friend { "Friend" } else { "Enemy" },
                actor_idx,
                if actor_is_friend { "Enemy" } else { "Friend" },
                target.index_in_fleet,
                firepower,
                armor,
                damage,
                hp_before,
                target.result.hp
            );
        }
    }

    fn to_result(&self) -> BattleResult {
        BattleResult {
            result: None,
            friend_fleet_results: self
                .friend_fleet
                .iter()
                .map(|fs| ShipResult { hp: fs.result.hp })
                .collect(),
            enemy_index: self.enemy_index,
            enemy_fleet_results: self
                .enemy_fleet
                .iter()
                .map(|fs| ShipResult { hp: fs.result.hp })
                .collect(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ShipResult {
    hp: u16,
}

impl ShipResult {
    fn from(ship: &Ship) -> Self {
        Self { hp: ship.status.hp }
    }
}

static INIT: std::sync::Once = std::sync::Once::new();

fn initialize() {
    INIT.call_once(|| {
        utils::set_panic_hook();
        wasm_logger::init(wasm_logger::Config::default()); // ロガー初期化
        info!("Logger initialized");
    });
}

#[wasm_bindgen]
pub fn simulate(friend_val: JsValue, enemy_val: JsValue, count: u32) -> JsValue {
    initialize();

    info!("Simulation started");

    let friend: Option<Fleet> = serde_wasm_bindgen::from_value(friend_val).unwrap();
    let enemy: Option<Vec<EnemyFleet>> = serde_wasm_bindgen::from_value(enemy_val).unwrap();
    let mut results = Vec::new();
    if friend.is_none() || enemy.is_none() {
        error!("Invalid fleet data provided");
        debug!("Friend fleet: {:?}", friend);
        debug!("Enemy fleet: {:?}", enemy);
        return serde_wasm_bindgen::to_value(&results).unwrap();
    }

    let friend = friend.unwrap();
    let enemy = enemy.unwrap();

    debug!("Friend fleet: {:?}", friend);
    debug!("Enemy fleet: {:?}", enemy);

    for i in 0..count {
        if i < 10 || i % 100 == 0 {
            info!("Simulating battle {}/{}", i + 1, count);
        }
        let battle_result = battle_once(&friend, &enemy);
        results.push(battle_result);
    }
    info!("Simulation completed");
    debug!("Simulation result: {:?}", results);
    serde_wasm_bindgen::to_value(&results).unwrap()
}

fn battle_once(friend: &Fleet, enemy: &[EnemyFleet]) -> BattleResult {
    let r = rand::random::<f64>();
    let mut cumulative_probability = 0.0;
    let mut selected_enemy_index = 0;
    for (index, enemy_fleet) in enemy.iter().enumerate() {
        cumulative_probability += enemy_fleet.probability;
        if r <= cumulative_probability {
            selected_enemy_index = index;
            break;
        }
    }
    let enemy = &enemy[selected_enemy_index];
    debug!(
        "Selected enemy fleet index: {:?}, fleet: {:?}",
        selected_enemy_index, enemy
    );

    let mut battle = Battle::new(friend, selected_enemy_index, enemy);

    battle.fire_phase1();
    debug!("Fire phase 1 finished");

    battle.to_result()
}
