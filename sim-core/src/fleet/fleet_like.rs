use crate::fleet::ship::Ship;
use log::warn;
use serde::{Deserialize, Serialize};

use crate::battle::ShipSnapshot;

/// `FleetLike`トレイトは、敵艦隊と味方艦隊に共通するインターフェースを定義、実装する。
pub trait FleetLike {
    // --- Required methods ---
    /// 艦隊に所属する艦船のスライスを取得する。
    fn ships(&self) -> &[Ship];

    /// 艦隊に所属する艦船のベクタを設定する。
    fn set_ships(&mut self, ships: Vec<Ship>);

    /// 艦隊の陣形を取得する。
    fn formation(&self) -> Option<Formation>;

    /// 艦隊の陣形が未設定の場合にデフォルトの陣形を設定する。 (これ必要？)
    fn set_formation_default(&mut self);

    fn is_empty(&self) -> bool {
        self.ships().is_empty()
    }

    /// フロントエンドから受けとったデータの妥当性を検証し、必要に応じて修正する。
    /// 修正可能な例外
    /// - 陣形が未設定
    ///
    /// 修正不能な例外
    /// - 艦隊が空
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

    fn apply_snapshot(&self, snapshots: &[ShipSnapshot]) -> Self
    where
        Self: Sized + Clone,
    {
        let new_ships = self
            .clone()
            .ships()
            .iter()
            .zip(snapshots.iter())
            .map(|(ship, snapshot)| {
                let mut new_ship = ship.clone();
                new_ship.apply_snapshot(snapshot);
                new_ship
            })
            .collect::<Vec<Ship>>();
        let mut new_fleet = self.clone();
        new_fleet.set_ships(new_ships);
        new_fleet
    }
}

impl FleetLike for Fleet {
    fn ships(&self) -> &[Ship] {
        &self.ships
    }
    fn set_ships(&mut self, ships: Vec<Ship>) {
        self.ships = ships;
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
    fn set_ships(&mut self, ships: Vec<Ship>) {
        self.ships = ships;
    }
    fn formation(&self) -> Option<Formation> {
        self.formation.clone()
    }
    fn set_formation_default(&mut self) {
        self.formation = Some(Formation::LineAhead);
    }
}

/// 自分の艦隊を受け取る構造体。
/// 子に艦娘のリストと陣形を持つ。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fleet {
    ships: Vec<Ship>,
    formation: Option<Formation>,
}

/// 敵艦隊を表す構造体。
/// 子に深海棲艦のリスト、陣形、出現エリア情報、出現確率を持つ。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnemyFleet {
    area: u16,
    map: u16,
    node: String,
    pub probability: f64,
    ships: Vec<Ship>,
    formation: Option<Formation>,
}

/// 陣形の種類を表す列挙型。
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
