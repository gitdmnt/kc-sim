use log::{debug, error, info, warn};
use wasm_bindgen::prelude::*;

mod battle;
mod interface;
mod utils;

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

    let friend: Option<interface::Fleet> = serde_wasm_bindgen::from_value(friend_val).unwrap();
    let enemy: Option<Vec<interface::EnemyFleet>> =
        serde_wasm_bindgen::from_value(enemy_val).unwrap();
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

fn battle_once(
    friend: &interface::Fleet,
    enemy: &[interface::EnemyFleet],
) -> interface::BattleResult {
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

    let mut battle = battle::Battle::new(friend, selected_enemy_index, enemy);

    debug!("Battle direction: {}", battle.direction);

    battle.fire_phase1();
    debug!("Fire phase 1 finished");

    battle.into()
}
