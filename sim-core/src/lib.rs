mod utils;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use web_sys::console::log_1;

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
    area: u8,
    map: u8,
    node: String,
    probability: f64,
    ships: Vec<Ship>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Ship {
    eugen_id: u16,
    ship_type_id: u8,
    status: ShipStatus,
    equips: Vec<Equip>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ShipStatus {
    hp: u16,
    firepower: u8,
    armor: u8,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Equip {
    eugen_id: u16,
    equip_type_id: u8,
    status: EquipStatus,
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct EquipStatus {
    firepower: u8,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct BattleResult {
    result: Option<u8>, // 0-5 D, C, B, A, S, SS
    friend_fleet_results: Vec<ShipResult>,
    enemy_index: usize,
    enemy_fleet_results: Vec<ShipResult>,
}

impl BattleResult {
    fn new() -> Self {
        Self {
            result: None,
            friend_fleet_results: Vec::new(),
            enemy_index: 0,
            enemy_fleet_results: Vec::new(),
        }
    }

    fn init(friend: &dyn FleetTrait, enemy_index: usize, enemy: &dyn FleetTrait) -> Self {
        let mut result = Self::new();
        for ship in friend.ships() {
            result.friend_fleet_results.push(ShipResult::from(ship));
        }
        result.enemy_index = enemy_index;
        for ship in enemy.ships() {
            result.enemy_fleet_results.push(ShipResult::from(ship));
        }
        result
    }

    // 砲撃戦1巡目
    fn fire_phase1(&mut self, friend: &dyn FleetTrait, enemy: &dyn FleetTrait) -> &mut Self {
        // 艦隊が空の場合は何もしない
        if friend.ships().is_empty() || enemy.ships().is_empty() {
            return self;
        }

        // 砲撃順決定
        // TODO: 火力順になってるから射程順に修正する
        let mut fire_order = friend
            .ships()
            .iter()
            .enumerate()
            .map(|(i, ship)| (true, i, ship)) // (is_friend, ship_index)
            .chain(
                enemy
                    .ships()
                    .iter()
                    .enumerate()
                    .map(|(i, ship)| (false, i, ship)),
            ) // (is_friend, ship_index)
            .collect::<Vec<_>>();
        fire_order.sort_by_key(|a| std::cmp::Reverse(a.2.status.firepower));

        let fire_order = fire_order
            .into_iter()
            .map(|(is_friend, i, _)| (is_friend, i))
            .collect::<Vec<_>>();

        // 攻撃処理
        for (actor_is_friend, idx_in_fleet) in fire_order {
            let (actor_fleet, target_fleet) = if actor_is_friend {
                (friend, enemy)
            } else {
                (enemy, friend)
            };
            let actor = &actor_fleet.ships()[idx_in_fleet];

            // ターゲット決定
            let r = rand::random::<f64>();
            let target_idx = (r * (target_fleet.ships().len() as f64)) as usize;
            let target: &Ship = &target_fleet.ships()[target_idx];

            // 火力計算
            let firepower = actor.status.firepower as f64;
            let firepower = firepower; // キャップ前補正
            let firepower =
                firepower.min(220.0) + f64::floor(f64::sqrt((firepower - 220.0).max(0.0))); // キャップ処理
            let firepower = firepower; // キャップ後補正

            // 防御力計算
            let r: f64 = rand::random();
            let armor = target.status.armor as f64;
            let armor = armor * 0.7 + f64::floor(armor * r) * 0.6;

            // ダメージ計算
            let damage = f64::floor(firepower - armor);

            // ターゲットの現在のHPを取得
            let hp_now = if actor_is_friend {
                &self.enemy_fleet_results[target_idx]
            } else {
                &self.friend_fleet_results[target_idx]
            }
            .hp_after as f64;

            let damage = if damage > 0.0 {
                damage
            } else {
                // カスダメ化
                let r = rand::random::<f64>();
                hp_now * 0.06 + f64::floor(hp_now * r) * 0.08
            };
            // HP減少処理
            let target_result = if actor_is_friend {
                &mut self.enemy_fleet_results[target_idx]
            } else {
                &mut self.friend_fleet_results[target_idx]
            };
            target_result.hp_after = target_result.hp_after.saturating_sub(damage as u16);
        }

        self
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ShipResult {
    hp_before: u16,
    hp_after: u16,
}

impl ShipResult {
    fn from(ship: &Ship) -> Self {
        Self {
            hp_before: ship.status.hp,
            hp_after: ship.status.hp,
        }
    }
}

#[wasm_bindgen]
pub fn simulate(friend_val: JsValue, enemy_val: JsValue, count: u32) -> JsValue {
    utils::set_panic_hook(); // パニック時の詳細なエラーをコンソールに出力

    log_1(&"Simulation started".into());

    let friend: Option<Fleet> = serde_wasm_bindgen::from_value(friend_val).unwrap();
    let enemy: Option<Vec<EnemyFleet>> = serde_wasm_bindgen::from_value(enemy_val).unwrap();
    let mut results = Vec::new();
    if friend.is_none() || enemy.is_none() {
        log_1(&"Invalid fleet data provided".into());
        log_1(&format!("Friend fleet: {:?}", friend).into());
        log_1(&format!("Enemy fleet: {:?}", enemy).into());
        return serde_wasm_bindgen::to_value(&results).unwrap();
    }

    let friend = friend.unwrap();
    let enemy = enemy.unwrap();

    log_1(&format!("Friend fleet: {:?}", friend).into());
    log_1(&format!("Enemy fleet: {:?}", enemy).into());

    for i in 0..count {
        if i % 100 == 0 {
            log_1(&format!("Simulating battle {}/{}", i, count).into());
        }
        let battle_result = battle_once(&friend, &enemy);
        results.push(battle_result);
    }
    log_1(&"Simulation completed".into());
    log_1(&format!("Simulation result: {:?}", results).into());
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

    let mut result = BattleResult::init(friend, selected_enemy_index, enemy);
    let result = result.fire_phase1(friend, enemy);

    result.clone()
}
