use crate::fleet::{EnemyFleet, Fleet, FleetLike, Ship};

pub struct BattleLog {
    action_logs: Vec<ActionLog>,
    pub friend_snapshots: Vec<ShipSnapshot>,
    pub enemy_snapshots: Vec<ShipSnapshot>,
}

impl BattleLog {
    pub fn new(friend: &Fleet, enemy: &EnemyFleet) -> Self {
        let friend_snapshots = friend.ships().iter().map(|ship| ship.into()).collect();
        let enemy_snapshots = enemy.ships().iter().map(|ship| ship.into()).collect();
        Self {
            action_logs: Vec::new(),
            friend_snapshots,
            enemy_snapshots,
        }
    }

    pub fn push(&mut self, log: ActionLog) {
        self.action_logs.push(log);
    }
}

pub enum ActionLog {
    PhaseStart(Phase),
    Attack(AttackLog),
    TurnSkip {
        is_friend: bool,
        ship_idx: usize,
        reason: String,
    },
    Sunk {
        is_friend: bool,
        ship_idx: usize,
    },
}

pub enum Phase {
    AirCombat,
    Artillery,
    Torpedo,
}

pub struct AttackLog {
    pub to_enemy: bool,
    pub actor_idx: usize,
    pub target_idx: usize,
    pub attack_type: AttackType,
    pub firepower: u16,
    pub armor: u16,
    pub calculated_damage: u16,
    pub applied_damage: u16,
    pub is_critical: bool,
    pub is_miss: bool,
}

pub enum AttackType {
    Artillery,
    Torpedo,
    AirStrike,
}

pub struct ShipSnapshot {
    hp: u16,
}

impl ShipSnapshot {
    pub fn hp(&self) -> u16 {
        self.hp
    }
    pub fn is_alive(&self) -> bool {
        self.hp > 0
    }
    pub fn apply_damage(&mut self, damage: u16) {
        if damage >= self.hp {
            self.hp = 0;
        } else {
            self.hp -= damage;
        }
    }
}

impl From<&Ship> for ShipSnapshot {
    fn from(ship: &Ship) -> Self {
        Self { hp: ship.hp() }
    }
}
