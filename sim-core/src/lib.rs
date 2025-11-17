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

    let Ok(mut friend) = serde_wasm_bindgen::from_value::<interface::Fleet>(friend_val) else {
        error!("Failed to parse friend fleet");
        return serde_wasm_bindgen::to_value(&Vec::<interface::BattleReport>::new()).unwrap();
    };
    let Ok(mut enemy) = serde_wasm_bindgen::from_value::<Vec<interface::EnemyFleet>>(enemy_val)
    else {
        error!("Failed to parse enemy fleets");
        return serde_wasm_bindgen::to_value(&Vec::<interface::BattleReport>::new()).unwrap();
    };

    friend.validate();
    enemy.iter_mut().for_each(|e| {
        e.validate();
    });

    let mut results = Vec::new();

    debug!("Friend fleet: {:?}", friend);
    debug!("Enemy fleet: {:?}", enemy);

    for i in 0..count {
        let logging = if i < 10 || i % 100 == 0 {
            info!("Simulating battle {}/{}", i + 1, count);
            true
        } else {
            false
        };

        let selected_enemy = select_random_enemy(&enemy);
        let battle_result = battle_once(&friend, selected_enemy, logging);
        results.push(battle_result);
    }
    info!("Simulation completed");
    debug!("Simulation result: {:?}", results);
    serde_wasm_bindgen::to_value(&results).unwrap()
}

fn select_random_enemy(enemy_fleets: &[interface::EnemyFleet]) -> &interface::EnemyFleet {
    let r = rand::random::<f64>();
    let mut cumulative_probability = 0.0;
    for enemy_fleet in enemy_fleets {
        cumulative_probability += enemy_fleet.probability;
        if r <= cumulative_probability {
            return enemy_fleet;
        }
    }
    enemy_fleets.last().unwrap()
}

fn battle_once(
    friend: &interface::Fleet,
    enemy: &interface::EnemyFleet,
    logging: bool,
) -> interface::BattleReport {
    debug!("Selected enemy fleet: {:?}", enemy);

    let mut battle = battle::Battle::new(friend, 0, enemy);

    debug!("Battle direction: {}", battle.direction);

    battle.fire_phase1();
    debug!("Fire phase 1 finished");

    if logging {
        battle.flush_logs_debug();
    }

    battle.into()
}
