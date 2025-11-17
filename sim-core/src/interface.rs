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

/// -- Immutable Ship methods --
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ship {
    eugen_id: u16,
    name: String,
    ship_type_id: u16,
    ship_type_name: String,
    status: ShipStatus,
    equips: Vec<Equipment>,
}

impl Ship {
    pub fn name(&self) -> String {
        self.name.clone()
    }

    pub fn hp(&self) -> u16 {
        self.status.hp
    }
    pub fn firepower(&self) -> u16 {
        self.status.firepower
    }
    pub fn armor(&self) -> u16 {
        self.status.armor
    }
    pub fn range(&self) -> Range {
        self.status.range.clone()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ShipStatus {
    pub hp: u16,
    #[serde(default)] // undefined/null -> 0
    pub firepower: u16,
    #[serde(default)] // undefined/null -> 0
    pub armor: u16,

    pub range: Range,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Range {
    None,
    Short,
    Medium,
    Long,
    VeryLong,
}

impl std::fmt::Display for Range {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Range::None => "None",
            Range::Short => "Short",
            Range::Medium => "Medium",
            Range::Long => "Long",
            Range::VeryLong => "Very Long",
        };
        write!(f, "{}", s)
    }
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
    #[serde(default)] // undefined/null -> 0
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

/// -- Baremetal ShipSnapshot methods --
impl ShipSnapshot {
    /// Create snapshot from current Ship status.
    pub fn from(ship: &Ship) -> Self {
        Self { hp: ship.status.hp }
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
