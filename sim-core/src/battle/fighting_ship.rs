use crate::interface;

// 戦闘中の艦船の状態を管理する構造体
pub struct FightingShip {
    ship: interface::Ship,
    is_friend: bool,
    index_in_fleet: usize,
    snapshot: interface::ShipSnapshot,
}

impl FightingShip {
    pub fn new(ship: interface::Ship, is_friend: bool, index_in_fleet: usize) -> Self {
        let snapshot = interface::ShipSnapshot::from(&ship);
        Self {
            ship,
            is_friend,
            index_in_fleet,
            snapshot,
        }
    }

    pub fn ship(&self) -> interface::Ship {
        self.ship.clone()
    }
    pub fn index_in_fleet(&self) -> usize {
        self.index_in_fleet
    }
    pub fn snapshot(&self) -> interface::ShipSnapshot {
        self.snapshot.clone()
    }

    pub fn hp(&self) -> u16 {
        self.snapshot.hp()
    }
    pub fn firepower(&self) -> u16 {
        self.ship.firepower()
    }
    pub fn armor(&self) -> u16 {
        self.ship.armor()
    }
    pub fn range(&self) -> interface::Range {
        self.ship.range()
    }

    pub fn is_alive(&self) -> bool {
        self.snapshot.hp() > 0
    }

    /// Apply damage to the ship during battle.
    /// If the target ship is a friendly ship, damage will be reduced to avoid sinking.
    ///
    /// case: The target ship is
    ///
    /// - flagship
    /// - not 大破 nor red tired (normal fleet)
    /// - not 大破 (combined fleet)
    ///
    /// Then, damage is replaced to rational value.
    ///
    /// case: The target ship is
    ///
    /// - only not 大破 (normal fleet)
    ///
    /// Then, damage is reduced to leave 1 HP.
    ///
    /// case: else
    /// Then, damage is applied as is.
    pub fn apply_damage(&mut self, diff: u16) {
        // 友軍の場合は轟沈ストッパー適用
        let diff = if self.is_friend && diff >= self.snapshot.hp() {
            if self.index_in_fleet == 0 {
                let hp = self.hp() as f64;
                let r: f64 = rand::random();
                f64::floor(hp * 0.5 + f64::floor(hp * r) * 0.3) as u16
            } else {
                self.hp() - 1
            }
        } else {
            diff
        };

        self.snapshot.apply_damage(diff);
    }
}
