use serde::{Deserialize, Serialize};

/// 射程の種類を表す列挙型。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum Range {
    #[default]
    None,
    Short,
    Medium,
    Long,
    VeryLong,
    VeryVeryLong,
}

impl std::fmt::Display for Range {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Range::None => "None",
            Range::Short => "Short",
            Range::Medium => "Medium",
            Range::Long => "Long",
            Range::VeryLong => "Very Long",
            Range::VeryVeryLong => "Very Very Long",
        };
        write!(f, "{}", s)
    }
}
