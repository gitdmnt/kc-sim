use crate::battle::Battle;
use crate::battle::BattleLog;
use crate::fleet::FleetLike;

use serde::{Deserialize, Serialize};

/// 戦闘結果を表す列挙型。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum BattleResult {
    SS,
    S,
    A,
    B,
    C,
    D,
    E,
}

impl BattleResult {
    /// Create BattleResult from BattleLog and Battle.
    pub fn calculate(battle: &Battle) -> Self {
        let log = &battle.log;
        let setup = &battle.setup;

        let sunk_friend = log
            .friend_snapshots
            .iter()
            .filter(|fs| !fs.is_alive())
            .count();
        let sunk_enemy = log
            .enemy_snapshots
            .iter()
            .filter(|fs| !fs.is_alive())
            .count();

        let total_friend: usize = log.friend_snapshots.len();
        let friend_sunk_ratio: f64 = sunk_friend as f64 / total_friend as f64;

        let total_enemy: usize = log.enemy_snapshots.len();
        let alive_enemy: usize = log
            .enemy_snapshots
            .iter()
            .filter(|fs| fs.is_alive())
            .count();
        let enemy_sunk_ratio: f64 = sunk_enemy as f64 / total_enemy as f64;
        let is_enemy_flagship_sunk: bool = log
            .enemy_snapshots
            .first()
            .map(|fs| !fs.is_alive())
            .unwrap_or(false);

        let total_damage_to_friend: u32 = battle
            .setup
            .friend_fleet
            .ships()
            .iter()
            .enumerate()
            .map(|(i, fs)| (fs.hp() - log.friend_snapshots[i].hp()) as u32)
            .sum();

        let total_damage_to_enemy: u32 = battle
            .setup
            .enemy_fleet
            .ships()
            .iter()
            .enumerate()
            .map(|(i, fs)| (fs.hp() - log.enemy_snapshots[i].hp()) as u32)
            .sum();

        let total_friend_initial_hp: u32 = battle
            .setup
            .friend_fleet
            .ships()
            .iter()
            .map(|fs| fs.hp() as u32)
            .sum();
        let total_enemy_initial_hp: u32 = battle
            .setup
            .enemy_fleet
            .ships()
            .iter()
            .map(|fs| fs.hp() as u32)
            .sum();
        let friend_gauge = (total_damage_to_enemy as f64) / (total_enemy_initial_hp as f64) * 100.0;
        let enemy_gauge =
            (total_damage_to_friend as f64) / (total_friend_initial_hp as f64) * 100.0;
        let gauge_ratio = friend_gauge / (enemy_gauge + 1E-10); // ゼロ除算防止

        if sunk_friend > 0 {
            if gauge_ratio >= 2.5 || (is_enemy_flagship_sunk && sunk_enemy > sunk_friend) {
                Self::B
            } else if is_enemy_flagship_sunk || gauge_ratio >= 1.0 {
                Self::C
            } else if friend_sunk_ratio >= 0.5 {
                Self::E
            } else {
                Self::D
            }
        } else if alive_enemy == 0 {
            if total_damage_to_friend == 0 {
                Self::SS
            } else {
                Self::S
            }
        } else if enemy_sunk_ratio >= (2.0 / 3.0) {
            Self::A
        } else if is_enemy_flagship_sunk || gauge_ratio >= 2.5 {
            Self::B
        } else if gauge_ratio >= 1.0 || friend_gauge >= 50.0 {
            Self::C
        } else {
            Self::D
        }
    }
}
