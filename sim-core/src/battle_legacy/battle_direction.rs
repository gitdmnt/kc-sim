// 戦闘の陣形タイプを表す列挙型
#[derive(Debug)]
pub enum BattleDirection {
    Same,
    Against,
    TAdvantage,
    TDisadvantage,
}
impl BattleDirection {
    pub fn fp_factor(&self) -> f64 {
        match self {
            BattleDirection::Same => 1.0,
            BattleDirection::Against => 0.8,
            BattleDirection::TAdvantage => 1.2,
            BattleDirection::TDisadvantage => 0.6,
        }
    }
}
impl std::fmt::Display for BattleDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            BattleDirection::Same => "同航戦",
            BattleDirection::Against => "反航戦",
            BattleDirection::TAdvantage => "Ｔ字有利",
            BattleDirection::TDisadvantage => "Ｔ字不利",
        };
        write!(f, "{}", s)
    }
}
