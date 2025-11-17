use log::{debug, error, info};
use wasm_bindgen::prelude::*;

mod battle;
mod interface;
mod utils;

use crate::interface::FleetLike;

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

    let mut friend = match serde_wasm_bindgen::from_value::<interface::Fleet>(friend_val) {
        Ok(f) => f,
        Err(err) => {
            error!("Failed to parse friend fleet: {:?}", err);
            return serde_wasm_bindgen::to_value(&Vec::<interface::BattleReport>::new()).unwrap();
        }
    };
    let mut enemy = match serde_wasm_bindgen::from_value::<Vec<interface::EnemyFleet>>(enemy_val) {
        Ok(e) => e,
        Err(err) => {
            error!("Failed to parse enemy fleets: {:?}", err);
            return serde_wasm_bindgen::to_value(&Vec::<interface::BattleReport>::new()).unwrap();
        }
    };

    friend.validate();
    enemy.iter_mut().for_each(|e| {
        e.validate();
    });

    let mut results = Vec::new();

    debug!("Friend fleet: {:?}", friend);
    debug!("Enemy fleet: {:?}", enemy);

    for i in 0..count {
        let logging = i < 10 || i % 100 == 0;
        let (idx, selected_enemy) = select_random_enemy(&enemy);
        let battle_result = battle_once(&friend, idx, selected_enemy, logging);
        results.push(battle_result);
    }
    serde_wasm_bindgen::to_value(&results).unwrap()
}

fn select_random_enemy(enemy_fleets: &[interface::EnemyFleet]) -> (usize, &interface::EnemyFleet) {
    let r = rand::random::<f64>();
    let mut cumulative_probability = 0.0;
    for (i, enemy_fleet) in enemy_fleets.iter().enumerate() {
        cumulative_probability += enemy_fleet.probability;
        if r <= cumulative_probability {
            return (i, enemy_fleet);
        }
    }
    enemy_fleets
        .last()
        .map(|ef| (enemy_fleets.len() - 1, ef))
        .unwrap()
}

fn battle_once(
    friend: &interface::Fleet,
    enemy_index: usize,
    enemy: &interface::EnemyFleet,
    logging: bool,
) -> interface::BattleReport {
    let mut battle = battle::Battle::new(friend, enemy_index, enemy);

    battle.fire_phase1();
    battle.fire_phase2();

    if logging {
        battle.flush_logs_debug();
    }

    battle.into()
}
