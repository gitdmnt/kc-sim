mod battle_direction;
mod fighting_ship;
mod fp_calculation; // 追加

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
            logs: Vec::new(), // 初期化
        }
    }

    // -- ログ管理 --
    // バッファへイベント追加
    #[allow(clippy::too_many_arguments)]
    fn push_fire_log(
        &mut self,
        actor_is_friend: bool,
        actor_idx: usize,
        target_is_friend: bool,
        target_idx: usize,
        firepower: f64,
        armor: f64,
        damage: f64,
        hp_before: u16,
        hp_after: u16,
    ) {
        let s = format!(
            "{}-{} -> {}-{} | fp={:.1} armor={:.1} dmg={:.1} hp {} -> {}",
            if actor_is_friend { "Friend" } else { "Enemy" },
            actor_idx,
            if target_is_friend { "Friend" } else { "Enemy" },
            target_idx,
            firepower,
            armor,
            damage,
            hp_before,
            hp_after
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
    fn fire_order(&self) -> Vec<(bool, usize)> {
        let mut order = self
            .friend_fleet
            .iter()
            .enumerate()
            .map(|(i, fs)| (true, i, fs.firepower()))
            .chain(
                self.enemy_fleet
                    .iter()
                    .enumerate()
                    .map(|(i, fs)| (false, i, fs.firepower())),
            )
            .collect::<Vec<_>>();

        order.sort_by_key(|a| std::cmp::Reverse(a.2));
        let order = order
            .iter()
            .map(|(is_friend, i, _)| (*is_friend, *i))
            .collect::<Vec<_>>();
        order
    }

    fn get_actor(&self, is_friend: bool, index_in_fleet: usize) -> Option<interface::Ship> {
        if is_friend {
            self.friend_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
                .map(|s| s.ship())
        } else {
            self.enemy_fleet
                .iter()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
                .map(|s| s.ship())
        }
    }

    fn get_target_mut(&mut self, actor_is_friend: bool) -> Option<&mut FightingShip> {
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
                .iter_mut()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        } else {
            self.enemy_fleet
                .iter_mut()
                .filter(|s| s.is_alive())
                .nth(index_in_fleet)
        }
    }

    // 砲撃戦1巡目
    pub fn fire_phase1(&mut self) {
        if self.friend_fleet.is_empty() || self.enemy_fleet.is_empty() {
            debug!("One of the fleets is empty, skipping fire phase 1");
            return;
        }

        // 砲撃順決定 (is_friend, index_in_fleet, key_for_sort)
        // TODO: 火力順になってるから射程順に修正する
        let fire_order = self.fire_order();
        debug!("Fire order: {:?}", fire_order);

        for (actor_is_friend, actor_idx) in fire_order.into_iter() {
            // --- 攻撃者の情報を取得 ---
            // actorの参照を保持し続けないように、必要な情報だけをコピーする
            let actor = {
                let actor = self.get_actor(actor_is_friend, actor_idx);
                if actor.is_none() {
                    debug!("Actor {actor_idx} is dead or does not exist, skipping turn");
                    continue;
                }
                actor.unwrap()
            };

            // 火力計算
            let firepower = {
                let fp = actor.firepower() as f64;
                let fp =
                    fp_calculation::fp_precap_correction(fp, self.direction.correction_factor());
                let fp = fp_calculation::fp_capping(fp, 220.0);
                fp_calculation::fp_postcap_correction(fp)
            };

            // --- ターゲットを取得 ---
            let target = {
                let target = self.get_target_mut(actor_is_friend);
                if target.is_none() {
                    debug!("No valid targets for actor {actor_idx} , skipping turn");
                    continue;
                }
                target.unwrap()
            };

            // 防御力計算
            let armor = {
                let armor = target.armor() as f64;
                let r: f64 = rand::random();
                armor * 0.7 + f64::floor(armor * r) * 0.6
            };

            // ダメージ計算
            let damage = {
                let damage = f64::floor(firepower - armor);
                let hp_now = target.hp() as f64;
                if damage > 0.0 {
                    damage
                } else {
                    // カスダメ化
                    let r = rand::random::<f64>();
                    hp_now * 0.06 + f64::floor(hp_now * r) * 0.08
                }
            };

            // ダメージ処理
            // キャプチャしてから mutable borrow をドロップするためにスコープ内で処理
            let (target_idx, hp_before, hp_after) = {
                let hp_before = target.hp();
                target.apply_damage(damage as u16);
                let hp_after = target.hp();
                (target.index_in_fleet(), hp_before, hp_after)
            };

            // ログはバッファに追加（mutable borrow は既に解放済み）
            self.push_fire_log(
                actor_is_friend,
                actor_idx,
                !actor_is_friend,
                target_idx,
                firepower,
                armor,
                damage,
                hp_before,
                hp_after,
            );
        }
    }

    pub fn calculate_result(&mut self) -> Option<interface::BattleResult> {
        None
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
                .map(|fs| fs.result())
                .collect(),
            enemy_index: battle.enemy_index,
            enemy_fleet_results: battle
                .enemy_fleet
                .into_iter()
                .map(|fs| fs.result())
                .collect(),
        }
    }
}
