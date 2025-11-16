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

// 戦闘の陣形タイプを表す列挙型
#[derive(Debug)]
enum BattleDirection {
    Same,
    Against,
    TAdvantage,
    TDisadvantage,
}
impl BattleDirection {
    fn correction_factor(&self) -> f64 {
        match self {
            BattleDirection::Same => 1.0,
            BattleDirection::Against => 0.8,
            BattleDirection::TAdvantage => 1.2,
            BattleDirection::TDisadvantage => 0.6,
        }
    }
}
impl std::fmt::Display for BattleDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            BattleDirection::Same => "同航戦",
            BattleDirection::Against => "反航戦",
            BattleDirection::TAdvantage => "Ｔ字有利",
            BattleDirection::TDisadvantage => "Ｔ字不利",
        };
        write!(f, "{}", s)
    }
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
    direction: BattleDirection,
    friend_fleet: Vec<FightingShip>,
    enemy_index: usize,
    enemy_fleet: Vec<FightingShip>,
}

impl Battle {
    fn new(friend: &dyn FleetTrait, enemy_index: usize, enemy: &dyn FleetTrait) -> Self {
        // -- 陣形決定 --
        let r = rand::random::<f64>();
        let direction = if r < 0.45 {
            BattleDirection::Same // 45%
        } else if r < 0.75 {
            BattleDirection::Against // 30%
        } else if r < 0.9 {
            BattleDirection::TAdvantage // 15%
        } else {
            BattleDirection::TDisadvantage // 10%
        };

        Self {
            direction,
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

    // -- 砲撃戦関連 --

    fn get_actor(&self, is_friend: bool, index_in_fleet: usize) -> Option<Ship> {
        if is_friend {
            self.friend_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
                .map(|s| s.ship.clone())
        } else {
            self.enemy_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
                .map(|s| s.ship.clone())
        }
    }

    fn get_target_mut(&mut self, actor_is_friend: bool) -> Option<&mut FightingShip> {
        let alive_count = if !actor_is_friend {
            self.friend_fleet.iter().filter(|s| s.is_alive()).count()
        } else {
            self.enemy_fleet.iter().filter(|s| s.is_alive()).count()
        };
        if alive_count == 0 {
            return None;
        }
        let index_in_fleet = random_range(0..alive_count);

        if !actor_is_friend {
            self.friend_fleet
                .iter_mut()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        } else {
            self.enemy_fleet
                .iter_mut()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        }
    }

    fn fp_precap_correction(&self, firepower: f64) -> f64 {
        let direction_factor = &self.direction.correction_factor();
        firepower * direction_factor
    }

    fn fp_capping(firepower: f64, cap: f64) -> f64 {
        firepower.min(cap) + f64::floor(f64::sqrt((firepower - cap).max(0.0)))
    }

    fn fp_postcap_correction(firepower: f64) -> f64 {
        firepower
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
            // --- 攻撃者の情報を取得 ---
            // actorの参照を保持し続けないように、必要な情報だけをコピーする
            let actor = {
                let actor = self.get_actor(actor_is_friend, actor_idx);
                if actor.is_none() {
                    debug!("Actor {actor_idx} is dead or does not exist, skipping turn");
                    continue;
                }
                actor.unwrap()
            };

            // 火力計算
            let firepower = actor.status.firepower as f64;
            let firepower = self.fp_precap_correction(firepower); // キャップ前補正
            let firepower = Self::fp_capping(firepower, 220.0); // キャップ処理
            let firepower = Self::fp_postcap_correction(firepower); // キャップ後補正

            // --- ターゲットを取得 ---
            let target = self.get_target_mut(actor_is_friend);

            if target.is_none() {
                debug!("No valid targets for actor {actor_idx} , skipping turn");
                continue;
            }
            let target = target.unwrap();

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

    debug!("Battle direction: {}", battle.direction);

    battle.fire_phase1();
    debug!("Fire phase 1 finished");

    battle.to_result()
}
