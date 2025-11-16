use serde::{Deserialize, Serialize};

pub trait FleetTrait {
    fn ships(&self) -> &Vec<Ship>;
}

impl FleetTrait for Fleet {
    fn ships(&self) -> &Vec<Ship> {
        &self.ships
    }
}
impl FleetTrait for EnemyFleet {
    fn ships(&self) -> &Vec<Ship> {
        &self.ships
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
enum Formation {
    LineAhead,
    DoubleLine,
    Diamond,
    Echelon,
    LineAbreast,
    Vanguard,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fleet {
    ships: Vec<Ship>,
    formation: Formation,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EnemyFleet {
    area: u16,
    map: u16,
    node: String,
    pub probability: f64,
    ships: Vec<Ship>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ship {
    eugen_id: u16,
    ship_type_id: u16,
    status: ShipStatus,
    equips: Vec<Equip>,
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
struct Equip {
    eugen_id: u16,
    equip_type_id: u16,
    status: EquipStatus,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct EquipStatus {
    firepower: u16,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BattleResult {
    pub result: Option<u16>, // 0-6 SS, S, A, B, C, D, E
    pub friend_fleet_results: Vec<ShipResult>,
    pub enemy_index: usize,
    pub enemy_fleet_results: Vec<ShipResult>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShipResult {
    hp: u16,
}

impl ShipResult {
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
