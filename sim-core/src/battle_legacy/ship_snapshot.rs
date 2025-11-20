use crate::fleet::Ship;
use serde::{Deserialize, Serialize};

/// 戦闘中の艦船の状態を保持するスナップショット構造体。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShipSnapshot {
    hp: u16,
}

/// -- Baremetal ShipSnapshot methods --
impl ShipSnapshot {
    /// Create snapshot from current Ship status.
    pub fn from(ship: &Ship) -> Self {
        Self { hp: ship.hp() }
    }

    /// Apply `amount` damage to this snapshot.
    pub fn apply_damage(&mut self, amount: u16) {
        self.hp = self.hp.saturating_sub(amount);
    }

    /// Read-only access to HP.
    pub fn hp(&self) -> u16 {
        self.hp
    }
}
