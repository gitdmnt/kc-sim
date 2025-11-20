use serde::{Deserialize, Serialize};

use crate::battle::{BattleDirection, DamagedLevel, Phase, ShipSnapshot};

use crate::fleet::equipment::Equipment;
use crate::fleet::status::Range;

/// 艦娘や深海棲艦の情報を表す不変の構造体。
/// 子に艦船固有ID、名前、艦種ID、艦種名、ステータス、装備のリストを持つ。
/// 戦闘中に変化する情報は ShipSnapshot に分離されている。
///
/// 各種ステータスは、装備の補正を含む合計値として提供される。
/// これより下位の状態はデシリアライズ時にNoneで補完される可能性があるため陰蔽されており、ゲッターメソッドを通じてのみアクセス可能。  
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
    // status getters
    /// 艦の全回復時HPを取得する。
    pub fn max_hp(&self) -> u16 {
        self.status.max_hp
    }

    /// 戦闘突入時のHPを取得する。
    pub fn hp(&self) -> u16 {
        self.status.now_hp
    }

    /// 火力ステータスを取得する。
    /// この値には装備の火力が加算されているが、艦娘固有の装備ボーナスや改修ボーナスは含まれない。
    /// 以下のゲッターも同様。
    pub fn firepower(&self) -> u16 {
        self.status.firepower
    }

    /// 装甲ステータスを取得する。
    pub fn armor(&self) -> u16 {
        self.status.armor
    }

    /// 雷装ステータスを取得する。
    pub fn torpedo(&self) -> u16 {
        self.status.torpedo
    }

    /// 爆装ステータスを取得する。
    pub fn bombing(&self) -> u16 {
        self.equips.iter().map(|e| e.bombing()).sum()
    }

    /// 射程ステータスを取得する。
    pub fn range(&self) -> Range {
        let range = self.status.range.clone().unwrap_or_default();
        let equip_range = self
            .equips
            .iter()
            .map(|e| e.range().clone())
            .max()
            .unwrap_or(Range::None);
        std::cmp::max(range, equip_range)
    }

    // attributes getters
    /// 艦名 (日本語) を取得する。
    pub fn name(&self) -> String {
        self.name.clone()
    }
    /// 艦種IDを取得する。未設定の場合は0を返す。
    pub fn ship_type_id(&self) -> u16 {
        self.ship_type_id.unwrap_or(0)
    }

    /// 戦艦系 (低速戦艦、高速戦艦、航空戦艦、超弩級戦艦) かどうかを判定する。
    pub fn is_battleship_class(&self) -> bool {
        let id = self.ship_type_id();
        matches!(id, 8 | 9 | 10 | 12)
    }

    /// 攻撃可能な航空機を装備しているかどうかを判定する。
    /// 空母系の艦種であっても、攻撃可能な航空機を装備していなければ false を返す。
    /// 逆に、速吸改のような非空母系艦種であっても、攻撃可能な航空機を装備していれば true を返す。
    pub fn has_attack_aircraft(&self, _snapshot: &ShipSnapshot) -> bool {
        self.equips.iter().any(|e| e.is_attack_aircraft())
    }

    pub fn damaged_level(&self, snapshot: &ShipSnapshot) -> crate::battle::DamagedLevel {
        let max_hp = self.max_hp();
        let now_hp = snapshot.hp();
        let ratio = now_hp as f64 / max_hp as f64;
        if now_hp == 0 {
            crate::battle::DamagedLevel::Sunk
        } else if ratio <= 0.25 {
            crate::battle::DamagedLevel::Heavy
        } else if ratio <= 0.5 {
            crate::battle::DamagedLevel::Moderate
        } else if ratio <= 0.75 {
            crate::battle::DamagedLevel::Minor
        } else {
            crate::battle::DamagedLevel::NoDamage
        }
    }

    /// ShipSnapshot の情報を適用し、艦船の状態を更新する。
    pub fn apply_snapshot(&mut self, snapshot: &ShipSnapshot) {
        self.status.now_hp = snapshot.hp();
    }
}

/// 艦船の各種ステータスを表す構造体。
/// フロントエンドからデータを受けとるためのコンテナであり、戦闘ロジック内で直接使用されることはない。
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
