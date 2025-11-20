pub mod battle_direction;
pub mod battle_result;
mod fighting_ship;
pub mod ship_snapshot;

use crate::{fleet::FleetLike, interface};
use battle_direction::BattleDirection;
use fighting_ship::FightingShip;

use log::debug;
use rand::random_range;

// 戦闘の進行を管理する構造体
pub struct Battle {
    pub direction: BattleDirection,
    pub friend_fleet: Vec<FightingShip>,
    pub enemy_index: usize,
    pub enemy_fleet: Vec<FightingShip>,
    pub logs: Vec<String>, // 追加：イベントを貯めるバッファ
}

impl Battle {
    pub fn new(friend: &dyn FleetLike, enemy_index: usize, enemy: &dyn FleetLike) -> Self {
        let mut logs = Vec::new();
        logs.push("=== Battle start ===".to_owned());

        // -- 編成情報ログ出力 -- うるさい
        // let friend_fleet = friend.ships();
        // let enemy_fleet = enemy.ships();
        // logs.push(format!("Friend fleet ships: {friend_fleet:?}"));
        // logs.push(format!("Enemy fleet ships: {enemy_fleet:?}"));

        // -- 陣形決定 --
        let r = rand::random::<f64>();
        let direction = if r < 0.45 {
            BattleDirection::Same // 45%
        } else if r < 0.75 {
            BattleDirection::Against // 30%
        } else if r < 0.9 {
            BattleDirection::TAdvantage // 15%
        } else {
            BattleDirection::TDisadvantage // 10%
        };
        logs.push(format!("-- Battle direction: {:?} --", direction));

        Self {
            direction,
            friend_fleet: friend
                .ships()
                .iter()
                .enumerate()
                .map(|(i, ship)| FightingShip::new(ship.clone(), true, i))
                .collect(),
            enemy_fleet: enemy
                .ships()
                .iter()
                .enumerate()
                .map(|(i, ship)| FightingShip::new(ship.clone(), false, i))
                .collect(),
            enemy_index,
            logs,
        }
    }

    // -- API --
    fn calculate_firepower(&self, ship: &FightingShip) -> f64 {
        let cap = 220.0;
        ship.calculate_firepower(&self.direction, cap)
    }
    fn calculate_armor(&self, ship: &FightingShip) -> f64 {
        let armor = ship.armor() as f64;
        let r: f64 = rand::random();
        armor * 0.7 + (armor * r).floor() * 0.6
    }

    fn apply_damage(&mut self, target_is_friend: bool, target_index: usize, damage: u16) {
        let target_fleet = if target_is_friend {
            &mut self.friend_fleet
        } else {
            &mut self.enemy_fleet
        };
        if let Some(target) = target_fleet.get_mut(target_index) {
            target.apply_damage(damage);
        }
    }

    // -- ログ管理 --
    // バッファへイベント追加
    pub fn push_log<T: ToString>(&mut self, log: T) {
        self.logs.push(log.to_string());
    }

    // 砲撃ログをフォーマットしてバッファに追加
    fn push_fire_log(
        &mut self,
        actor_is_friend: bool,
        actor_index: usize,
        target_index: usize,
        damage: f64,
    ) {
        let (actor, target) = if actor_is_friend {
            (
                &self.friend_fleet[actor_index],
                &self.enemy_fleet[target_index],
            )
        } else {
            (
                &self.enemy_fleet[actor_index],
                &self.friend_fleet[target_index],
            )
        };

        let actor_range = actor.range();
        let actor_name = actor.name();
        let target_name = target.name();
        let fp = actor.firepower() as f64;
        let armor = target.armor() as f64;
        let hp_before = target.hp_before();
        let hp_after = target.hp_now();

        let s = format!(
            "Range: {actor_range} \t| {actor_name} -> {target_name} \t| fp={fp:.1} armor={armor:.1} dmg={damage:} hp {hp_before} -> {hp_after}",
        );
        self.logs.push(s);
    }

    // ログをまとめてdebug出力してバッファをクリア
    pub fn flush_logs_debug(&mut self) {
        if !self.logs.is_empty() {
            debug!("\n{}", self.logs.join("\n"));
            self.logs.clear();
        }
    }

    // -- 砲撃戦関連 --
    // 砲撃順を決定（射程順）
    fn ordered_by_range(&self) -> Vec<(bool, usize)> {
        let mut fleet1 = self
            .friend_fleet
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_alive())
            .collect::<Vec<_>>();
        fleet1.sort_by_key(|(_, s)| std::cmp::Reverse(s.range()));
        let mut fleet2 = self
            .enemy_fleet
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_alive())
            .collect::<Vec<_>>();
        fleet2.sort_by_key(|(_, s)| std::cmp::Reverse(s.range()));

        let (first, second) =
            if fleet1.first().unwrap().1.range() > fleet2.first().unwrap().1.range() {
                (
                    fleet1.into_iter().map(|e| e.0).collect::<Vec<_>>(),
                    fleet2.into_iter().map(|e| e.0).collect::<Vec<_>>(),
                )
            } else {
                (
                    fleet2.into_iter().map(|e| e.0).collect::<Vec<_>>(),
                    fleet1.into_iter().map(|e| e.0).collect::<Vec<_>>(),
                )
            };

        let mut result = Vec::new();
        let mut i = 0;
        let mut j = 0;
        while i < first.len() || j < second.len() {
            if i < first.len() {
                result.push((true, first[i]));
                i += 1;
            }
            if j < second.len() {
                result.push((false, second[j]));
                j += 1;
            }
        }
        result
    }

    fn ordered_by_index(&self) -> Vec<(bool, usize)> {
        let friend = self
            .friend_fleet
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_alive())
            .map(|e| e.0)
            .collect::<Vec<_>>();
        let enemy = self
            .enemy_fleet
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_alive())
            .map(|e| e.0)
            .collect::<Vec<_>>();

        let mut result = Vec::new();
        let length = friend.len().max(enemy.len());
        for i in 0..length {
            if i < friend.len() {
                result.push((true, friend[i]));
            }
            if i < enemy.len() {
                result.push((false, enemy[i]));
            }
        }
        result
    }

    // 攻撃者の情報を取得
    fn get_actor(&self, is_friend: bool, index_in_fleet: usize) -> Result<&FightingShip, String> {
        let actor = if is_friend {
            &self.friend_fleet[index_in_fleet]
        } else {
            &self.enemy_fleet[index_in_fleet]
        };

        // 攻撃順決定後に轟沈した場合はスキップ
        if !actor.is_alive() {
            return Err(format!(
                "Actor at index {} is not alive, skipping turn",
                index_in_fleet
            ));
        }

        // 空母系で中破以上の場合はスキップ
        if actor.has_attack_aircraft()
            && actor.damaged_level() >= fighting_ship::DamagedLevel::Moderate
        {
            return Err(format!(
                "Actor at index {} is too damaged, skipping turn",
                index_in_fleet
            ));
        }

        Ok(actor)
    }

    // ランダムにターゲットを取得
    fn get_target(&self, actor_is_friend: bool) -> Option<&FightingShip> {
        // どちらの艦隊を狙うか（攻撃者の反対側）
        let target_fleet = if actor_is_friend {
            &self.enemy_fleet
        } else {
            &self.friend_fleet
        };

        self.choose_random_alive(target_fleet)
    }

    // 生存している艦の中からランダムに1隻返す（内部で count と nth を使う）
    fn choose_random_alive<'a>(&'a self, fleet: &'a [FightingShip]) -> Option<&'a FightingShip> {
        let alive_count = fleet.iter().filter(|s| s.is_alive()).count();
        if alive_count == 0 {
            return None;
        }
        let idx = random_range(0..alive_count);
        fleet.iter().filter(|s| s.is_alive()).nth(idx)
    }

    fn includes_battleship_class(&self) -> bool {
        self.friend_fleet.iter().any(|fs| fs.is_battleship_class())
            || self.enemy_fleet.iter().any(|fs| fs.is_battleship_class())
    }

    // 砲撃戦
    pub fn fire_phase(&mut self) {
        let fire_order = self.ordered_by_range();
        self.fire_phase_helper(fire_order);

        if self.includes_battleship_class() {
            let fire_order = self.ordered_by_index();
            self.fire_phase_helper(fire_order);
        }
    }

    fn fire_phase_helper(&mut self, fire_order: Vec<(bool, usize)>) {
        for (actor_is_friend, actor_index) in fire_order.into_iter() {
            // --- 攻撃者の情報を取得 ---
            let actor = match self.get_actor(actor_is_friend, actor_index) {
                Ok(a) => a,

                Err(e) => {
                    self.push_log(e);
                    continue;
                }
            };

            // --- ターゲットを取得 ---
            let target = {
                let target = self.get_target(actor_is_friend);
                if target.is_none() {
                    self.push_log(format!(
                        "No valid targets for {} , skipping turn",
                        actor.name()
                    ));
                    continue;
                }
                target.unwrap()
            };

            // 火力計算
            let firepower = self.calculate_firepower(actor);

            // 防御力計算
            let armor = self.calculate_armor(target);

            // ダメージ計算
            let damage = {
                let damage = f64::floor(firepower - armor);
                let hp_now = target.hp_now() as f64;
                if damage > 0.0 {
                    damage
                } else {
                    // カスダメ化
                    let r = rand::random::<f64>();
                    hp_now * 0.06 + f64::floor(hp_now * r) * 0.08
                }
            };

            let (actor_is_friend, actor_idx, target_idx) = (
                actor.is_friend(),
                actor.index_in_fleet(),
                target.index_in_fleet(),
            );

            self.apply_damage(!actor_is_friend, target_idx, damage as u16);

            // ログはバッファに追加（mutable borrow は既に解放済み）
            self.push_fire_log(actor_is_friend, actor_idx, target_idx, damage);
        }
    }

    pub fn calculate_result(&mut self) -> Option<interface::BattleResult> {
        let friend_sunk = self.friend_fleet.iter().filter(|fs| !fs.is_alive()).count();
        let enemy_sunk = self.enemy_fleet.iter().filter(|fs| !fs.is_alive()).count();

        let total_friend_ships: usize = self.friend_fleet.len();
        let friend_sunk_ratio: f64 = friend_sunk as f64 / total_friend_ships as f64;

        let total_enemy_ships: usize = self.enemy_fleet.len();
        let alive_enemy_ships: usize = self.enemy_fleet.iter().filter(|fs| fs.is_alive()).count();
        let enemy_sunk_ratio: f64 = enemy_sunk as f64 / total_enemy_ships as f64;
        let enemy_flagship_sunk: bool = self
            .enemy_fleet
            .first()
            .map(|fs| !fs.is_alive())
            .unwrap_or(false);

        let total_damage_to_friend: u32 = self
            .friend_fleet
            .iter()
            .map(|fs| (fs.hp_before() - fs.hp_now()) as u32)
            .sum();

        let total_damage_to_enemy: u32 = self
            .enemy_fleet
            .iter()
            .map(|fs| (fs.hp_before() - fs.hp_now()) as u32)
            .sum();
        let total_friend_initial_hp: u32 = self
            .friend_fleet
            .iter()
            .map(|fs| fs.ship().hp() as u32)
            .sum();
        let total_enemy_initial_hp: u32 = self
            .enemy_fleet
            .iter()
            .map(|fs| fs.ship().hp() as u32)
            .sum();
        let friend_gauge = (total_damage_to_enemy as f64) / (total_enemy_initial_hp as f64) * 100.0;
        let enemy_gauge =
            (total_damage_to_friend as f64) / (total_friend_initial_hp as f64) * 100.0;
        let gauge_ratio = friend_gauge / (enemy_gauge + 1E-10); // ゼロ除算防止
        if friend_sunk > 0 {
            if gauge_ratio >= 2.5 || (enemy_flagship_sunk && enemy_sunk > friend_sunk) {
                Some(interface::BattleResult::B)
            } else if enemy_flagship_sunk || gauge_ratio >= 1.0 {
                Some(interface::BattleResult::C)
            } else if friend_sunk_ratio >= 0.5 {
                Some(interface::BattleResult::E)
            } else {
                Some(interface::BattleResult::D)
            }
        } else if alive_enemy_ships == 0 {
            if total_damage_to_friend == 0 {
                Some(interface::BattleResult::SS)
            } else {
                Some(interface::BattleResult::S)
            }
        } else if enemy_sunk_ratio >= (2.0 / 3.0) {
            Some(interface::BattleResult::A)
        } else if enemy_flagship_sunk || gauge_ratio >= 2.5 {
            Some(interface::BattleResult::B)
        } else if gauge_ratio >= 1.0 || friend_gauge >= 50.0 {
            Some(interface::BattleResult::C)
        } else {
            Some(interface::BattleResult::D)
        }
    }
}

impl From<Battle> for interface::BattleReport {
    fn from(mut battle: Battle) -> Self {
        let result = battle.calculate_result();
        Self {
            result,
            friend_fleet_results: battle
                .friend_fleet
                .into_iter()
                .map(|fs| fs.snapshot())
                .collect(),
            enemy_index: battle.enemy_index,
            enemy_fleet_results: battle
                .enemy_fleet
                .into_iter()
                .map(|fs| fs.snapshot())
                .collect(),
        }
    }
}
