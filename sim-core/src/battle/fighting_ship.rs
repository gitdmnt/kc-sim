use crate::interface;

// 戦闘中の艦船の状態を管理する構造体
pub struct FightingShip {
    ship: interface::Ship,
    is_friend: bool,
    index_in_fleet: usize,
    result: interface::ShipSnapshot,
}

impl FightingShip {
    pub fn new(ship: interface::Ship, is_friend: bool, index_in_fleet: usize) -> Self {
        let result = interface::ShipSnapshot::from(&ship);
        Self {
            ship,
            is_friend,
            index_in_fleet,
            result,
        }
    }

    pub fn ship(&self) -> interface::Ship {
        self.ship.clone()
    }
    pub fn index_in_fleet(&self) -> usize {
        self.index_in_fleet
    }
    pub fn result(&self) -> interface::ShipSnapshot {
        self.result.clone()
    }

    pub fn hp(&self) -> u16 {
        self.result.hp()
    }
    pub fn firepower(&self) -> u16 {
        self.ship.firepower()
    }
    pub fn armor(&self) -> u16 {
        self.ship.armor()
    }

    pub fn is_alive(&self) -> bool {
        self.result.hp() > 0
    }
    pub fn apply_damage(&mut self, diff: u16) {
        self.result.apply_damage(self.is_friend, diff);
    }
}
