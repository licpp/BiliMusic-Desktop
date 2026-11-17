/// Disabled resume also disables automatic collection checkpoints; explicit positions bypass this policy.
pub fn should_resume_video(
    duration: f64,
    enabled: bool,
    threshold: f64,
    _collection: bool,
) -> bool {
    enabled && (threshold <= 0.0 || duration.is_finite() && duration >= threshold)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_policy_matches_shared_cross_platform_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/resume-policy.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let threshold = &case["threshold"];
            assert_eq!(
                should_resume_video(
                    case["duration"].as_f64().unwrap(),
                    !threshold.is_null(),
                    threshold.as_f64().unwrap_or_default(),
                    case["collection"].as_bool().unwrap_or_default(),
                ),
                case["resume"].as_bool().unwrap(),
                "{case}",
            );
        }
    }
}
