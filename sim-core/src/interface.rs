use log::warn;
use serde::{Deserialize, Serialize};

pub trait FleetLike {
    fn ships(&self) -> &[Ship];
    fn formation(&self) -> Option<Formation>;
    fn set_formation_default(&mut self);

    fn is_empty(&self) -> bool {
        self.ships().is_empty()
    }
    fn validate(&mut self) -> bool {
        if self.is_empty() {
            warn!("Fleet is empty:  {:?}", self.ships());
            return false;
        }
        if self.formation().is_none() {
            warn!("Fleet formation is not set:  {:?}", self.ships());
            self.set_formation_default();
        }
        true
    }
}

impl FleetLike for Fleet {
    fn ships(&self) -> &[Ship] {
        &self.ships
    }
    fn formation(&self) -> Option<Formation> {
        self.formation.clone()
    }
    fn set_formation_default(&mut self) {
        self.formation = Some(Formation::LineAhead);
    }
}
impl FleetLike for EnemyFleet {
    fn ships(&self) -> &[Ship] {
        &self.ships
    }
    fn formation(&self) -> Option<Formation> {
        self.formation.clone()
    }
    fn set_formation_default(&mut self) {
        self.formation = Some(Formation::LineAhead);
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fleet {
    ships: Vec<Ship>,
    formation: Option<Formation>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EnemyFleet {
    area: u16,
    map: u16,
    node: String,
    pub probability: f64,
    ships: Vec<Ship>,
    formation: Option<Formation>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub enum Formation {
    LineAhead,
    DoubleLine,
    Diamond,
    Echelon,
    LineAbreast,
    Vanguard,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ship {
    eugen_id: u16,
    ship_type_id: u16,
    status: ShipStatus,
    equips: Vec<Equipment>,
}

impl Ship {
    pub fn firepower(&self) -> u16 {
        self.status.firepower
    }
    pub fn armor(&self) -> u16 {
        self.status.armor
    }
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
struct Equipment {
    eugen_id: u16,
    equip_type_id: u16,
    status: EquipmentStatus,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct EquipmentStatus {
    firepower: u16,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BattleReport {
    pub result: Option<BattleResult>,
    pub friend_fleet_results: Vec<ShipSnapshot>,
    pub enemy_index: usize,
    pub enemy_fleet_results: Vec<ShipSnapshot>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum BattleResult {
    SS,
    S,
    A,
    B,
    C,
    D,
    E,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShipSnapshot {
    hp: u16,
}

impl ShipSnapshot {
    pub fn from(ship: &Ship) -> Self {
        Self { hp: ship.status.hp }
    }

    pub fn damage(&mut self, diff: u16) {
        self.hp = self.hp.saturating_sub(diff);
    }

    pub fn hp(&self) -> u16 {
        self.hp
    }
}
