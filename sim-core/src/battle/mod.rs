use crate::fleet::{EnemyFleet, Fleet, FleetLike, Ship};
use itertools::Itertools;
use rand::Rng;
use serde::{Deserialize, Serialize};

mod battle_log;
pub use battle_log::{ActionLog, BattleLog, Phase, ShipSnapshot};

mod battle_setup;
use battle_setup::BattleSetup;

mod battle_direction;
pub use battle_direction::BattleDirection;
mod battle_result;
pub use battle_result::BattleResult;

mod damaged_level;
pub use damaged_level::DamagedLevel;

/// バトルを制御するための構造体。
/// `setup`フィールドはバトルの初期設定を保持し、戦闘を通して不変です。
/// `log`フィールドはバトルの進行状況を記録します。可変です。
pub struct Battle {
    setup: BattleSetup,
    log: BattleLog,
}

impl Battle {
    /// 新しいBattleインスタンスを作成します。
    /// 与えられた艦隊の情報をCloneし、`BattleSetup`と`BattleLog`をそれぞれ初期化します。
    pub fn new(friend: &Fleet, enemy: &EnemyFleet) -> Self {
        let setup = BattleSetup::new(friend, enemy);
        let log = BattleLog::new(friend, enemy);
        Self { setup, log }
    }

    /// reference: [戦闘について - 艦隊これくしょん -艦これ- 攻略 Wiki*](https://wikiwiki.jp/kancolle/%E6%88%A6%E9%97%98%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6#b7dbae4f)
    /// 艦これの砲撃戦1巡目は次のルールで行動順が決定されます:
    /// 1. 味方・敵双方の生存艦をそれぞれ抽出し、射程順にソートします。
    /// 2. それぞれの艦隊の最も射程の長い艦を比較し、射程の長い方の艦隊の艦をキューの最初に追加します。
    /// 3. 以降、両艦隊の艦を交互に行動させるよう、艦をキューに追加します。
    ///    味方艦の射程がそれぞれ`[長, 短]`, 敵艦が`[中, 中]`の場合、行動順は`[味方長, 敵中, 味方短, 敵中]`となります。
    /// 4. どちらかの艦隊の生存艦が尽きた場合、残った艦隊の艦をそのままキューに追加します。
    /// 5. 1巡目中に艦が撃沈されても、行動順は再計算されず、撃沈された艦は単にスキップされます。
    fn ordered_by_range(&self) -> Vec<(bool, usize)> {
        // 味方と敵の生存艦をそれぞれ取得し、射程順にソート
        let mut friend =
            Self::filter_alive(self.setup.friend_fleet.ships(), &self.log.friend_snapshots);
        friend.sort_by_key(|(_, s)| std::cmp::Reverse(s.range()));
        let mut enemy =
            Self::filter_alive(self.setup.enemy_fleet.ships(), &self.log.enemy_snapshots);
        enemy.sort_by_key(|(_, s)| std::cmp::Reverse(s.range()));

        // 先に動き始める艦隊を決定
        let (first, second) =
            if friend.first().map(|(_, s)| s.range()) >= enemy.first().map(|(_, s)| s.range()) {
                (friend, enemy)
            } else {
                (enemy, friend)
            };

        // 交互にキューに追加; (艦隊識別子, 艦インデックス)
        let order = first
            .iter()
            .map(|(idx, _)| (true, *idx))
            .interleave(second.iter().map(|(idx, _)| (false, *idx)))
            .collect::<Vec<_>>();
        order
    }

    /// 2巡目の行動順決定はより単純で、艦隊内の艦をインデックス順に並べたものになります。
    fn ordered_by_index(&self) -> Vec<(bool, usize)> {
        let friend =
            Self::filter_alive(self.setup.friend_fleet.ships(), &self.log.friend_snapshots);
        let enemy = Self::filter_alive(self.setup.enemy_fleet.ships(), &self.log.enemy_snapshots);

        let order = friend
            .iter()
            .map(|(idx, _)| (true, *idx))
            .interleave(enemy.iter().map(|(idx, _)| (false, *idx)))
            .collect::<Vec<_>>();
        order
    }

    /// 生存している艦の所属フラグとインデックスを抽出します。
    fn filter_alive<'a>(
        ships: &'a [Ship],
        snapshots: &'a [ShipSnapshot],
    ) -> Vec<(usize, &'a Ship)> {
        ships
            .iter()
            .enumerate()
            .filter(|(idx, _)| snapshots[*idx].is_alive())
            .collect::<Vec<_>>()
    }

    /// 指定された艦隊とインデックスに対応する艦への参照を取得します。
    fn actor(&self, is_friend: bool, actor_idx: usize) -> &Ship {
        if is_friend {
            &self.setup.friend_fleet.ships()[actor_idx]
        } else {
            &self.setup.enemy_fleet.ships()[actor_idx]
        }
    }

    /// 指定された艦隊のランダムな艦への参照とそのスナップショットの可変参照を取得します。
    fn get_target(&mut self, actor_is_friend: bool) -> (usize, &Ship, &mut ShipSnapshot) {
        let (ships, snapshots) = if actor_is_friend {
            (
                &self.setup.enemy_fleet.ships(),
                &mut self.log.enemy_snapshots,
            )
        } else {
            (
                &self.setup.friend_fleet.ships(),
                &mut self.log.friend_snapshots,
            )
        };
        let alive_indices = snapshots
            .iter()
            .enumerate()
            .filter_map(|(idx, snap)| snap.is_alive().then_some(idx))
            .collect::<Vec<usize>>();
        if alive_indices.is_empty() {
            panic!("No alive targets to choose from");
        }
        let mut rng = rand::rng();
        let target_idx = alive_indices[rng.random_range(0..alive_indices.len())];

        (target_idx, &ships[target_idx], &mut snapshots[target_idx])
    }

    pub fn artillery_phase_helper(&mut self, fire_order: Vec<(bool, usize)>) {
        for (actor_is_friend, actor_idx) in fire_order {
            // -- 行動者の火力を計算 --
            let actor_snapshots = if actor_is_friend {
                &self.log.enemy_snapshots
            } else {
                &self.log.friend_snapshots
            };

            if !actor_snapshots[actor_idx].is_alive() {
                self.log.push(ActionLog::TurnSkip {
                    is_friend: actor_is_friend,
                    ship_idx: actor_idx,
                    reason: "Sunk".to_string(),
                });
                continue;
            }

            let actor = self.actor(actor_is_friend, actor_idx);
            let actor_snapshot = &actor_snapshots[actor_idx];

            if actor.has_attack_aircraft(actor_snapshot)
                && actor.damaged_level(actor_snapshot) >= DamagedLevel::Moderate
            {
                self.log.push(ActionLog::TurnSkip {
                    is_friend: actor_is_friend,
                    ship_idx: actor_idx,
                    reason: "Flight Deck is too Damaged".to_string(),
                });
                continue;
            }

            let firepower = {
                let cap = 220.0;

                // TODO: 装備改修ボーナス
                // TODO: 航空機を搭載していない空母系の場合の分岐が変
                let basic_fp = if actor.has_attack_aircraft(actor_snapshot) {
                    // TODO: 航空要員ボーナス
                    let fp = actor.firepower() as f64;
                    let torpedo_fp = actor.torpedo() as f64;
                    let bomb_fp = actor.bombing() as f64;
                    ((fp + torpedo_fp + bomb_fp) * 1.5).floor() + 55.0
                } else {
                    actor.firepower() as f64 + 5.0
                };

                let precap_fp = basic_fp
                    * self.setup.direction().fp_factor()
                    * actor.damaged_level(actor_snapshot).fp_factor();
                let capped_fp = precap_fp.min(cap) + (precap_fp - cap).max(0.0).sqrt().floor();
                let postcap_fp = capped_fp * 1.0; // 今後の調整をここで行える

                capped_fp
            };

            // -- 攻撃対象の選定と防御力計算 --

            let (target_idx, target, target_snapshot) = self.get_target(actor_is_friend);

            let armor = {
                let armor = target.armor() as f64;
                let r: f64 = rand::random();
                armor * 0.7 + (armor * r).floor() * 0.6
            };

            // -- ダメージ計算と適用 --

            let damage = {
                let diff = (firepower - armor).floor();
                let hp_now = target_snapshot.hp() as f64;
                let calculated_damage = if diff > 0.0 {
                    diff
                } else {
                    // カスダメ化
                    let r = rand::random::<f64>();
                    hp_now * 0.06 + f64::floor(hp_now * r) * 0.08
                };

                let adjusted_damage = if !actor_is_friend && calculated_damage >= hp_now {
                    if target_idx == 0 {
                        let r: f64 = rand::random();
                        f64::floor(hp_now * 0.5 + f64::floor(hp_now * r) * 0.3) as u16
                    } else {
                        hp_now as u16 - 1
                    }
                } else {
                    calculated_damage as u16
                };

                adjusted_damage
            };

            target_snapshot.apply_damage(damage);
        }
    }

    pub fn artillery_phase(&mut self) {
        self.log.push(ActionLog::PhaseStart(Phase::Artillery));

        let fire_order = self.ordered_by_range();
        self.artillery_phase_helper(fire_order);

        if self.setup.includes_battleship_class() {
            self.log.push(ActionLog::PhaseStart(Phase::Artillery));
            let fire_order = self.ordered_by_index();
            self.artillery_phase_helper(fire_order);
        }
    }

    pub fn to_battle_report(self) -> BattleReport {
        // Use this battle's setup and snapshot to build the report.
        // call calculate using the final state twice to keep the original signature expectations; adjust if calculate expects other types
        let result = battle_result::BattleResult::calculate(&self);
        let friend_fleet = self
            .setup
            .friend_fleet
            .apply_snapshot(&self.log.friend_snapshots);
        let enemy_fleet = self
            .setup
            .enemy_fleet
            .apply_snapshot(&self.log.enemy_snapshots);

        BattleReport {
            result,
            friend_fleet,
            enemy_fleet,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BattleReport {
    result: battle_result::BattleResult,
    friend_fleet: Fleet,
    enemy_fleet: EnemyFleet,
}
