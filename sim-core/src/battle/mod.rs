use crate::fleet::{EnemyFleet, Fleet, FleetLike, Ship};
use rand::Rng;
use serde::{Deserialize, Serialize};

mod battle_log;
pub use battle_log::{ActionLog, BattleLog, Phase, ShipSnapshot};

mod battle_setup;
use battle_setup::BattleSetup;

mod battle_direction;
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

    /// 射程順に行動順を決定します。
    /// reference: [戦闘について - 艦隊これくしょん -艦これ- 攻略 Wiki*](https://wikiwiki.jp/kancolle/%E6%88%A6%E9%97%98%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6#b7dbae4f)
    /// 艦これの砲撃戦一巡目は次のルールで行動順が決定されます:
    /// 1. 味方・敵双方の生存艦をそれぞれ抽出し、射程順にソートします。
    /// 2. それぞれの艦隊の最も射程の長い艦を比較し、射程の長い方の艦隊の艦をキューの最初に追加します。
    /// 3. 以降、両艦隊の艦を交互に行動させるよう、艦をキューに追加します。
    ///    味方艦の射程がそれぞれ`[長, 短]`, 敵艦が`[中, 中]`の場合、行動順は`[味方長, 敵中, 味方短, 敵中]`となります。
    /// 4. どちらかの艦隊の生存艦が尽きた場合、残った艦隊の艦をそのままキューに追加します。
    /// 5. 一巡目中に艦が撃沈されても、行動順は再計算されず、撃沈された艦は単にスキップされます。
    fn ordered_by_range(&self) -> Vec<(bool, usize)> {
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

        // 味方と敵の生存艦をそれぞれ取得し、射程順にソート
        let mut friend = filter_alive(self.setup.friend_fleet.ships(), &self.log.friend_snapshots);
        friend.sort_by_key(|(_, s)| std::cmp::Reverse(s.range()));
        let mut enemy = filter_alive(self.setup.enemy_fleet.ships(), &self.log.enemy_snapshots);
        enemy.sort_by_key(|(_, s)| std::cmp::Reverse(s.range()));

        // 先に動き始める艦隊を決定
        let (first, second) = if friend
            .first()
            .map_or(crate::fleet::Range::None, |(_, s)| s.range())
            >= enemy
                .first()
                .map_or(crate::fleet::Range::None, |(_, s)| s.range())
        {
            (friend, enemy)
        } else {
            (enemy, friend)
        };
        let mut order = Vec::new();
        let mut i = 0;
        let mut j = 0;
        while i < first.len() || j < second.len() {
            if i < first.len() {
                order.push((true, first[i].0));
                i += 1;
            }
            if j < second.len() {
                order.push((false, second[j].0));
                j += 1;
            }
        }
        order
    }

    fn ordered_by_index(&self) -> Vec<(bool, usize)> {
        let mut order = Vec::new();
        for (idx, _) in self
            .log
            .friend_snapshots
            .iter()
            .enumerate()
            .filter(|(_, snap)| snap.is_alive())
        {
            order.push((true, idx));
        }
        for (idx, _) in self
            .log
            .enemy_snapshots
            .iter()
            .enumerate()
            .filter(|(_, snap)| snap.is_alive())
        {
            order.push((false, idx));
        }

        order
    }

    fn get_actor(&self, is_friend: bool, actor_idx: usize) -> &Ship {
        if is_friend {
            &self.setup.friend_fleet.ships()[actor_idx]
        } else {
            &self.setup.enemy_fleet.ships()[actor_idx]
        }
    }

    fn get_target(&mut self, is_friend: bool) -> (&Ship, &mut ShipSnapshot) {
        let (ships, snapshots) = if is_friend {
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
            .filter(|(_, snap)| snap.is_alive())
            .map(|(idx, _)| idx)
            .collect::<Vec<usize>>();
        if alive_indices.is_empty() {
            panic!("No alive targets to choose from");
        }
        let mut rng = rand::rng();
        let target_idx = alive_indices[rng.random_range(0..alive_indices.len())];

        (&ships[target_idx], &mut snapshots[target_idx])
    }

    pub fn artillery_phase_helper(&mut self, fire_order: Vec<(bool, usize)>) {
        for (is_friend, actor_idx) in fire_order {
            let (actor_snapshots, target_snapshots) = if is_friend {
                (&self.log.enemy_snapshots, &mut self.log.friend_snapshots)
            } else {
                (&self.log.friend_snapshots, &mut self.log.enemy_snapshots)
            };

            if !actor_snapshots[actor_idx].is_alive() {
                self.log.push(ActionLog::TurnSkip {
                    is_friend,
                    ship_idx: actor_idx,
                    reason: "Sunk".to_string(),
                });
                continue;
            }

            let actor = self.get_actor(is_friend, actor_idx);
            let actor_snapshot = &actor_snapshots[actor_idx];

            if actor.has_attack_aircraft(actor_snapshot)
                && actor.damaged_level(actor_snapshot) >= DamagedLevel::Moderate
            {
                self.log.push(ActionLog::TurnSkip {
                    is_friend,
                    ship_idx: actor_idx,
                    reason: "Flight Deck is too Damaged".to_string(),
                });
                continue;
            }

            let (target, target_snapshot) = self.get_target(is_friend);
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
