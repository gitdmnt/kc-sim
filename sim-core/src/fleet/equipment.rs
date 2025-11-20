use serde::{Deserialize, Serialize};

use crate::fleet::status::Range;

/// 艦娘が装備している各装備品を表す構造体。
/// 外部には公開されない。
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Equipment {
    id: u16,
    name: Option<String>,
    equip_type_id: Option<Vec<u16>>,
    status: Option<EquipmentStatus>,
}
impl Equipment {
    /// 火力ステータスを取得する。
    pub fn firepower(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.firepower)
    }
    /// 装甲ステータスを取得する。
    pub fn armor(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.armor)
    }
    /// 雷装ステータスを取得する。
    pub fn torpedo(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.torpedo)
    }
    /// 対空ステータスを取得する。
    pub fn anti_aircraft(&self) -> u16 {
        self.status
            .as_ref()
            .and_then(|s| s.anti_aircraft)
            .unwrap_or(0)
    }
    /// 対潜ステータスを取得する。
    pub fn anti_submarine_warfare(&self) -> u16 {
        self.status
            .as_ref()
            .and_then(|s| s.anti_submarine_warfare)
            .unwrap_or(0)
    }
    /// 回避ステータスを取得する。
    pub fn evasion(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.evasion)
    }
    /// 命中ステータスを取得する。
    pub fn aiming(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.aiming)
    }
    /// 射程ステータスを取得する。
    pub fn range(&self) -> Range {
        self.status
            .as_ref()
            .map_or(Range::default(), |s| s.range.clone())
    }
    /// 偵察ステータスを取得する。
    pub fn scouting(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.scouting)
    }
    /// 爆装ステータスを取得する。
    pub fn bombing(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.bombing)
    }
    /// 航空機の射程ステータスを取得する。
    pub fn aircraft_range(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.aircraft_range)
    }
    /// 航空機の搭載コストを取得する。
    pub fn aircraft_cost(&self) -> u16 {
        self.status.as_ref().map_or(0, |s| s.aircraft_cost)
    }

    /// この装備が攻撃可能な航空機かどうかを判定する。
    pub fn is_attack_aircraft(&self) -> bool {
        let Some(id) = &self.equip_type_id else {
            return false;
        };
        matches!(id[2], 7 | 8)
    }
}

/// 装備品の各種ステータスを表す構造体。
/// 外部には公開されない。
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
