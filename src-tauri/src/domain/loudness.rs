//! Content-level metadata and the shared, attenuation-only playback policy.
use serde::{Deserialize, Serialize};

pub const DESCRIPTOR_VERSION: u32 = 1;
pub const TARGET_LUFS: f64 = -18.0;
pub const PEAK_CEILING_DBTP: f64 = -1.5;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessDescriptor {
    pub bvid: String,
    pub cid: i64,
    pub integrated_lufs: f64,
    pub true_peak_dbtp: Option<f64>,
    pub measured_at: u64,
    pub version: u32,
}
impl LoudnessDescriptor {
    pub fn from_volume(bvid: &str, cid: i64, volume: &serde_json::Value) -> Option<Self> {
        let descriptor = Self {
            bvid: bvid.into(),
            cid,
            integrated_lufs: volume["measured_i"].as_f64()?,
            true_peak_dbtp: volume["measured_tp"]
                .as_f64()
                .filter(|v| v.is_finite() && (-120.0..=20.0).contains(v)),
            measured_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            version: DESCRIPTOR_VERSION,
        };
        descriptor.valid_for(bvid, cid).then_some(descriptor)
    }
    pub fn valid_for(&self, bvid: &str, cid: i64) -> bool {
        self.version == DESCRIPTOR_VERSION
            && self.bvid == bvid
            && self.cid == cid
            && cid > 0
            && self.integrated_lufs.is_finite()
            && (-70.0..=0.0).contains(&self.integrated_lufs)
    }
    /// No amplification: ordinary system volume is not a digital gain processor.
    pub fn gain_db(&self) -> f64 {
        let peak = self
            .true_peak_dbtp
            .filter(|v| v.is_finite() && (-120.0..=20.0).contains(v));
        (TARGET_LUFS - self.integrated_lufs)
            .min(peak.map(|v| PEAK_CEILING_DBTP - v).unwrap_or(0.0))
            .min(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gain_policy_matches_shared_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/loudness.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let descriptor = LoudnessDescriptor::from_volume("BVtest", 1, &case["volume"]);
            let actual = descriptor.as_ref().map(|v| v.gain_db()).unwrap_or(0.0);
            assert!(
                (actual - case["gainDb"].as_f64().unwrap()).abs() < 1e-9,
                "{case}: {actual}"
            );
        }
    }
    #[test]
    fn nonfinite_unknown_versions_and_wrong_content_cannot_apply_gain() {
        let mut d =
            LoudnessDescriptor::from_volume("BVtest", 1, &serde_json::json!({"measured_i":-9.0}))
                .unwrap();
        assert!(!d.valid_for("BVtest", 2));
        assert!(!d.valid_for("BVother", 1));
        d.version += 1;
        assert!(!d.valid_for("BVtest", 1));
        d.version = DESCRIPTOR_VERSION;
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1.0, -71.0] {
            d.integrated_lufs = invalid;
            assert!(!d.valid_for("BVtest", 1));
        }
    }
}
