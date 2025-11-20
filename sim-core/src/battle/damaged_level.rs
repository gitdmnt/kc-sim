#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub enum DamagedLevel {
    NoDamage,
    Minor,
    Moderate,
    Heavy,
    Sunk,
}

impl DamagedLevel {
    pub fn fp_factor(&self) -> f64 {
        match self {
            DamagedLevel::NoDamage => 1.0,
            DamagedLevel::Minor => 1.0,
            DamagedLevel::Moderate => 0.7,
            DamagedLevel::Heavy => 0.4,
            DamagedLevel::Sunk => 0.0,
        }
    }
}
