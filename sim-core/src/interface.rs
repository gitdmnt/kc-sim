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
    id: u16,
    name: String,
    ship_type_id: Option<u16>,
    ship_type_name: Option<String>,
    status: ShipStatus,
    equips: Vec<Equipment>,
}

impl Ship {
    pub fn name(&self) -> String {
        self.name.clone()
    }

    pub fn hp(&self) -> u16 {
        self.status.now_hp
    }
    pub fn firepower(&self) -> u16 {
        self.status.firepower
    }
    pub fn armor(&self) -> u16 {
        self.status.armor
    }
    pub fn range(&self) -> Range {
        self.status.range.clone().unwrap_or_default()
    }
    pub fn ship_type_id(&self) -> u16 {
        self.ship_type_id.unwrap_or(0)
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ShipStatus {
    pub max_hp: u16,
    pub now_hp: u16,
    pub firepower: u16,
    pub armor: u16,
    pub torpedo: u16,
    pub anti_aircraft: u16,
    pub condition: u16,

    pub evasion: Option<u16>,
    pub airplane_slots: Option<Vec<u16>>,
    pub anti_submarine_warfare: Option<u16>,
    pub speed: Option<u16>,
    pub scouting: Option<u16>,
    pub range: Option<Range>,
    pub luck: Option<u16>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum Range {
    #[default]
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

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct Equipment {
    id: u16,
    name: Option<String>,
    equip_type_id: Option<Vec<u16>>,
    status: Option<EquipmentStatus>,
}
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct EquipmentStatus {
    firepower: u16,
    armor: u16,
    torpedo: u16,
    anti_aircraft: Option<u16>,
    anti_submarine_warfare: Option<u16>,
    evasion: u16,
    aiming: u16,
    range: Range,
    scouting: u16,
    speed: u16,
    bombing: u16,
    aircraft_range: u16,
    aircraft_cost: u16,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BattleReport {
    pub result: Option<BattleResult>,
    pub friend_fleet_results: Vec<ShipSnapshot>,
    pub enemy_index: usize,
    pub enemy_fleet_results: Vec<ShipSnapshot>,
}

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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShipSnapshot {
    hp: u16,
}

/// -- Baremetal ShipSnapshot methods --
impl ShipSnapshot {
    /// Create snapshot from current Ship status.
    pub fn from(ship: &Ship) -> Self {
        Self {
            hp: ship.status.now_hp,
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_JSON: &str = r#"
    [
      {
        "area": 61,
        "map": 4,
        "node": "Z",
        "probability": 0.5,
        "ships": [
          {
            "id": 2150,
            "name": "戦標船改装棲姫-壊",
            "status": {
              "maxHp": 930,
              "nowHp": 930,
              "firepower": 269,
              "armor": 272,
              "torpedo": 139,
              "antiAircraft": 159,
              "condition": 49
            },
            "equips": [
              {
                "id": 1617,
                "name": "夜猫深海艦戦II",
                "status": { "firepower": 3, "armor": 0 }
              }
            ]
          }
        ]
      },
      {
        "area": 61,
        "map": 4,
        "node": "Z",
        "probability": 0.5,
        "ships": [
          {
            "id": 2147,
            "name": "戦標船改装棲姫",
            "status": {
              "maxHp": 930,
              "nowHp": 930,
              "firepower": 199,
              "armor": 202,
              "torpedo": 89,
              "antiAircraft": 139,
              "condition": 49
            },
            "equips": [
              {
                "id": 1617,
                "name": "夜猫深海艦戦II",
                "status": { "firepower": 3 }
              }
            ]
          }
        ]
      }
    ]
    "#;

    #[test]
    fn enemy_fleets_deserialize_from_sample() {
        let v: Vec<EnemyFleet> = serde_json::from_str(SAMPLE_JSON).expect("parse sample json");

        // 基本数チェック
        assert!(v.len() >= 2);

        // 最初の要素のプロパティ確認
        let first = &v[0];
        assert_eq!(first.area, 61);
        assert_eq!(first.map, 4);
        assert_eq!(&first.node, "Z");
        assert!((first.probability - 0.5).abs() < 1e-9);

        // ship と equip のパース確認
        assert!(!first.ships.is_empty());
        let ship = &first.ships[0];
        assert_eq!(ship.id, 2150);
        assert_eq!(ship.name, "戦標船改装棲姫-壊");

        // status の値
        assert_eq!(ship.status.max_hp, 930);
        assert_eq!(ship.status.now_hp, 930);
        assert_eq!(ship.status.firepower, 269);

        // equip の status -> firepower
        assert!(!ship.equips.is_empty());
        let equip = &ship.equips[0];
        assert_eq!(equip.id, 1617);
        assert_eq!(equip.name, Some("夜猫深海艦戦II".to_string()));
        assert_eq!(equip.status.as_ref().unwrap().firepower, 3);
    }

    #[test]
    fn ship_status_defaults_when_missing_fields() {
        let json = "{
            \"maxHp\": 0,
            \"nowHp\": 0,
            \"firepower\": 0,
            \"armor\": 0,
            \"torpedo\": 0,
            \"antiAircraft\": 0,
            \"condition\": 49
            }";
        let s: ShipStatus = serde_json::from_str(json).unwrap();

        assert_eq!(s.max_hp, 0);
        assert_eq!(s.now_hp, 0);
        assert_eq!(s.firepower, 0);
        assert_eq!(s.armor, 0);
        assert_eq!(s.torpedo, 0);
        assert_eq!(s.anti_aircraft, 0);
        assert_eq!(s.condition, 49);
        assert_eq!(s.evasion, None);
        assert_eq!(s.airplane_slots, None);
        assert_eq!(s.anti_submarine_warfare, None);
        assert_eq!(s.speed, None);
        assert_eq!(s.scouting, None);
        assert_eq!(s.range, None);
        assert_eq!(s.luck, None);
    }

    #[test]
    fn equipment_status_defaults_when_missing_fields() {
        let json = "{}";
        let e: EquipmentStatus = serde_json::from_str(json).unwrap();

        assert_eq!(e.firepower, 0);
        assert_eq!(e.armor, 0);
        assert_eq!(e.torpedo, 0);
        assert_eq!(e.anti_aircraft, Some(0));
        assert_eq!(e.anti_submarine_warfare, Some(0));
        assert_eq!(e.evasion, 0);
        assert_eq!(e.aiming, 0);
        assert_eq!(e.range, Range::None);
        assert_eq!(e.scouting, 0);
        assert_eq!(e.speed, 0);
        assert_eq!(e.bombing, 0);
        assert_eq!(e.aircraft_range, 0);
        assert_eq!(e.aircraft_cost, 0);
    }

    #[test]
    fn ship_deserialize_uses_default_status_and_equips() {
        let json = r#"{
            "id": 100,
            "name": "Akagi",
            "shipTypeId": 1,
            "shipTypeName": "Carrier"
        }"#;
        let ship: Ship = serde_json::from_str(json).unwrap();

        assert_eq!(ship.id, 100);
        assert_eq!(ship.name(), "Akagi".to_string());
        // default status is used when missing
        assert_eq!(ship.status.max_hp, 0);
        assert_eq!(ship.status.now_hp, 0);
        // equips default to empty vec
        assert!(ship.equips.is_empty());
    }

    #[test]
    fn range_deserialize_and_default() {
        // explicit string -> proper variant
        let r: Range = serde_json::from_str(r#""short""#).unwrap();
        assert_eq!(r, Range::Short);

        // missing in a container should be Range::None (default)
        let json = r#"{"nowHp": 5}"#;
        let s: ShipStatus = serde_json::from_str(json).unwrap();
        assert_eq!(s.range, None);
    }

    #[test]
    fn battle_report_result_null_and_values() {
        // null -> None
        let j_null = r#"{
            "result": null,
            "friendFleetResults": [],
            "enemyIndex": 0,
            "enemyFleetResults": []
        }"#;
        let br: BattleReport = serde_json::from_str(j_null).unwrap();
        assert_eq!(br.result, None);

        // "SS" -> Some(BattleResult::SS)
        let j_ss = r#"{
            "result": "SS",
            "friendFleetResults": [],
            "enemyIndex": 0,
            "enemyFleetResults": []
        }"#;
        let br2: BattleReport = serde_json::from_str(j_ss).unwrap();
        assert_eq!(br2.result, Some(BattleResult::SS));

        // unknown string should fail deserialization (left as error to force explicit handling)
        let j_unknown = r#"{
            "result": "X",
            "friendFleetResults": [],
            "enemyIndex": 0,
            "enemyFleetResults": []
        }"#;
        assert!(serde_json::from_str::<BattleReport>(j_unknown).is_err());
    }

    #[test]
    fn ship_snapshot_from_and_apply_damage() {
        let json = r#"{
            "id": 1,
            "name": "Test",
            "shipTypeId": 1,
            "shipTypeName": "Type",
            "status": { "nowHp": 12 }
        }"#;
        let ship: Ship = serde_json::from_str(json).unwrap();
        let mut snap = ShipSnapshot::from(&ship);
        assert_eq!(snap.hp(), 12);

        snap.apply_damage(5);
        assert_eq!(snap.hp(), 7);

        snap.apply_damage(10); // saturating to 0
        assert_eq!(snap.hp(), 0);
    }
}
