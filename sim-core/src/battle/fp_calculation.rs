pub(super) fn fp_precap_correction(firepower: f64, direction_factor: f64) -> f64 {
    firepower * direction_factor
}

pub(super) fn fp_capping(firepower: f64, cap: f64) -> f64 {
    firepower.min(cap) + f64::floor(f64::sqrt((firepower - cap).max(0.0)))
}

pub(super) fn fp_postcap_correction(firepower: f64) -> f64 {
    // 今後の調整をここで行える
    firepower
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fp_capping() {
        assert_eq!(fp_capping(200.0, 220.0), 200.0);
        assert!(fp_capping(230.0, 220.0) > 220.0);
    }
}
