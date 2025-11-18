use crate::battle::battle_direction;
use crate::interface;

// 戦闘中の艦船の状態を管理する構造体
#[derive(Clone)]
pub struct FightingShip {
    ship: interface::Ship, // 元の艦船データ
    is_friend: bool,
    index_in_fleet: usize,
    snapshot: interface::ShipSnapshot, // 戦闘中の状態を保持するスナップショット
}

impl FightingShip {
    // 新しい FightingShip を作成する
    pub fn new(ship: interface::Ship, is_friend: bool, index_in_fleet: usize) -> Self {
        let snapshot = interface::ShipSnapshot::from(&ship);
        Self {
            ship,
            is_friend,
            index_in_fleet,
            snapshot,
        }
    }

    //
    // 各フィールドのゲッター
    //
    pub fn ship(&self) -> interface::Ship {
        self.ship.clone()
    }
    pub fn index_in_fleet(&self) -> usize {
        self.index_in_fleet
    }
    pub fn snapshot(&self) -> interface::ShipSnapshot {
        self.snapshot.clone()
    }
    pub fn name(&self) -> String {
        self.ship.name()
    }
    //
    // 各種ステータス取得
    //
    pub fn hp_before(&self) -> u16 {
        self.ship.hp()
    }
    pub fn hp_now(&self) -> u16 {
        self.snapshot.hp()
    }
    pub fn firepower(&self) -> u16 {
        self.ship.firepower()
    }
    pub fn armor(&self) -> u16 {
        self.ship.armor()
    }
    pub fn torpedo(&self) -> u16 {
        self.ship.torpedo()
    }
    pub fn bombing(&self) -> u16 {
        self.ship.bombing()
    }
    pub fn range(&self) -> interface::Range {
        self.ship.range()
    }

    //
    // 状態判定
    //
    pub fn is_friend(&self) -> bool {
        self.is_friend
    }
    pub fn is_alive(&self) -> bool {
        self.snapshot.hp() > 0
    }
    pub fn damaged_level(&self) -> DamagedLevel {
        let max_hp = self.ship.max_hp();
        let now_hp = self.snapshot.hp();
        let ratio = now_hp as f64 / max_hp as f64;
        if now_hp == 0 {
            DamagedLevel::Sunk
        } else if ratio <= 0.25 {
            DamagedLevel::Heavy
        } else if ratio <= 0.5 {
            DamagedLevel::Moderate
        } else if ratio <= 0.75 {
            DamagedLevel::Minor
        } else {
            DamagedLevel::NoDamage
        }
    }
    pub fn is_battleship_class(&self) -> bool {
        self.ship.is_battleship_class()
    }
    pub fn has_attack_aircraft(&self) -> bool {
        self.ship.has_attack_aircraft()
    }

    ///
    /// 火力計算
    ///
    pub fn calculate_firepower(
        &self,
        direction: &battle_direction::BattleDirection,
        cap: f64,
    ) -> f64 {
        let basic_fp = self.basic_fp();
        let precap_fp = self.fp_precap_correction(basic_fp, direction.fp_factor());
        let capped_fp = self.fp_capping(precap_fp, cap);
        self.fp_postcap_correction(capped_fp)
    }

    fn basic_fp(&self) -> f64 {
        // TODO: 装備改修ボーナス
        if self.has_attack_aircraft() {
            // TODO: 航空要員ボーナス
            let fp = self.firepower() as f64;
            let torpedo_fp = self.torpedo() as f64;
            let bomb_fp = self.bombing() as f64;
            ((fp + torpedo_fp + bomb_fp) * 1.5).floor() + 55.0
        } else {
            self.firepower() as f64 + 5.0
        }
    }

    fn fp_precap_correction(&self, firepower: f64, direction_factor: f64) -> f64 {
        firepower * direction_factor * self.damaged_level().fp_factor()
    }

    fn fp_capping(&self, firepower: f64, cap: f64) -> f64 {
        firepower.min(cap) + (firepower - cap).max(0.0).sqrt().floor()
    }

    fn fp_postcap_correction(&self, firepower: f64) -> f64 {
        // 今後の調整をここで行える
        firepower
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
                let hp = self.hp_now() as f64;
                let r: f64 = rand::random();
                f64::floor(hp * 0.5 + f64::floor(hp * r) * 0.3) as u16
            } else {
                self.hp_now() - 1
            }
        } else {
            diff
        };

        self.snapshot.apply_damage(diff);
    }
}

#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub enum DamagedLevel {
    NoDamage,
    Minor,
    Moderate,
    Heavy,
    Sunk,
}

impl DamagedLevel {
    fn fp_factor(&self) -> f64 {
        match self {
            DamagedLevel::NoDamage => 1.0,
            DamagedLevel::Minor => 1.0,
            DamagedLevel::Moderate => 0.7,
            DamagedLevel::Heavy => 0.4,
            DamagedLevel::Sunk => 0.0,
        }
    }
}
