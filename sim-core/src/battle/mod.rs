mod battle_direction;
mod fighting_ship;

use crate::interface;
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
    pub fn new(
        friend: &dyn interface::FleetLike,
        enemy_index: usize,
        enemy: &dyn interface::FleetLike,
    ) -> Self {
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
        let mut order = self
            .friend_fleet
            .iter()
            .enumerate()
            .map(|(i, fs)| (true, i, fs.range()))
            .chain(
                self.enemy_fleet
                    .iter()
                    .enumerate()
                    .map(|(i, fs)| (false, i, fs.range())),
            )
            .collect::<Vec<_>>();

        order.sort_by_key(|a| std::cmp::Reverse(a.2.clone()));
        let order = order
            .iter()
            .map(|(is_friend, i, _)| (*is_friend, *i))
            .collect::<Vec<_>>();
        order
    }

    // 攻撃者の情報を取得
    fn get_actor(&self, is_friend: bool, index_in_fleet: usize) -> Option<&FightingShip> {
        if is_friend {
            self.friend_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        } else {
            self.enemy_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        }
    }

    // ランダムにターゲットを取得
    fn get_target(&self, actor_is_friend: bool) -> Option<&FightingShip> {
        let alive_count = if !actor_is_friend {
            self.friend_fleet.iter().filter(|s| s.is_alive()).count()
        } else {
            self.enemy_fleet.iter().filter(|s| s.is_alive()).count()
        };
        if alive_count == 0 {
            return None;
        }
        let index_in_fleet = random_range(0..alive_count);

        if !actor_is_friend {
            self.friend_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        } else {
            self.enemy_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        }
    }

    fn includes_battleship_class(&self) -> bool {
        for fs in self.friend_fleet.iter() {
            if fs.is_battleship_class() {
                return true;
            }
        }
        for fs in self.enemy_fleet.iter() {
            if fs.is_battleship_class() {
                return true;
            }
        }
        false
    }

    // 砲撃戦の共通処理
    pub fn fire_phase(&mut self, fire_order: Vec<(bool, usize)>) {
        for (actor_is_friend, actor_idx) in fire_order.into_iter() {
            // --- 攻撃者の情報を取得 ---
            // actorの参照を保持し続けないように、必要な情報だけをコピーする
            let actor = {
                let actor = self.get_actor(actor_is_friend, actor_idx);
                if actor.is_none() {
                    self.push_log(format!(
                        "Actor {actor_idx} is dead or does not exist, skipping turn"
                    ));
                    continue;
                }
                actor.unwrap()
            };

            // --- ターゲットを取得 ---
            let target = {
                let target = self.get_target(actor_is_friend);
                if target.is_none() {
                    self.push_log(format!(
                        "No valid targets for actor {actor_idx} , skipping turn"
                    ));
                    continue;
                }
                target.unwrap()
            };

            // 火力計算
            let firepower = self.calculate_firepower(actor);

            // 防御力計算
            let armor = {
                let armor = target.armor() as f64;
                let r: f64 = rand::random();
                armor * 0.7 + f64::floor(armor * r) * 0.6
            };

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

            let (actor_is_friend, actor_idx, target_idx) =
                (actor_is_friend, actor_idx, target.index_in_fleet());

            self.apply_damage(!actor_is_friend, target_idx, damage as u16);

            // ログはバッファに追加（mutable borrow は既に解放済み）
            self.push_fire_log(actor_is_friend, actor_idx, target_idx, damage);
        }
    }

    // 砲撃戦1巡目
    pub fn fire_phase1(&mut self) {
        self.push_log("=== Fire Phase 1 Start ===");

        // 砲撃順決定 (is_friend, index_in_fleet)
        let fire_order = self.ordered_by_range();
        self.push_log(format!(
            "Fire order: {:?}",
            fire_order
                .iter()
                .map(|(b, i)| if *b {
                    self.friend_fleet[*i].ship().name()
                } else {
                    self.enemy_fleet[*i].ship().name()
                })
                .collect::<Vec<_>>()
        ));
        self.fire_phase(fire_order);
    }

    // 砲撃戦2巡目
    pub fn fire_phase2(&mut self) {
        if !self.includes_battleship_class() {
            self.push_log("Battleship is not included, skipping Fire Phase 2");
            return;
        }

        self.push_log("=== Fire Phase 2 Start ===");
        let mut fire_order = Vec::new();
        let length = self.friend_fleet.len().max(self.enemy_fleet.len());
        for i in 0..length {
            if i < self.friend_fleet.len() {
                fire_order.push((true, i));
            }
            if i < self.enemy_fleet.len() {
                fire_order.push((false, i));
            }
        }
        self.push_log(format!(
            "Fire order: {:?}",
            fire_order
                .iter()
                .map(|(b, i)| if *b {
                    self.friend_fleet[*i].ship().name()
                } else {
                    self.enemy_fleet[*i].ship().name()
                })
                .collect::<Vec<_>>()
        ));
        self.fire_phase(fire_order);
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
