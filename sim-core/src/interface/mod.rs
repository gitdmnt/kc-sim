/// フロントエンドとシミュレーションコア間のインターフェースを定義する。
/// このモジュールで定義される構造体は、シリアライズ/デシリアライズ可能でなければならない。
/// また、それらのメソッドは単なるゲッターに限定し、原則的にロジックを含めてはならない。
use log::warn;
use serde::{Deserialize, Serialize};

/// 戦闘結果をフロントエンドに返すための構造体。
/// 戦闘の評価、敵編成の何番かを表すインデックス、各艦の戦闘後のスナップショットを持つ。
pub use crate::battle::{BattleReport, BattleResult, ShipSnapshot};
pub use crate::fleet::{EnemyFleet, Fleet, Formation, Range, Ship};
