use crate::battle::{battle_direction::BattleDirection, ActionLog, ShipSnapshot};
use crate::fleet::{EnemyFleet, Fleet, FleetLike, Ship};

pub struct BattleSetup {
    direction: BattleDirection,
    pub friend_fleet: Fleet,
    pub enemy_fleet: EnemyFleet,
}
impl BattleSetup {
    pub fn new(friend: &Fleet, enemy: &EnemyFleet) -> Self {
        Self {
            direction: BattleDirection::random(),
            friend_fleet: friend.clone(),
            enemy_fleet: enemy.clone(),
        }
    }
    pub fn includes_battleship_class(&self) -> bool {
        self.friend_fleet
            .ships()
            .iter()
            .any(|s| s.is_battleship_class())
            || self
                .enemy_fleet
                .ships()
                .iter()
                .any(|s| s.is_battleship_class())
    }
}
