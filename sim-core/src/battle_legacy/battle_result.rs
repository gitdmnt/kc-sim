use serde::{Deserialize, Serialize};

/// 戦闘結果を表す列挙型。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum BattleResult {
    SS,
    S,
    A,
    B,
    C,
    D,
    E,
}
