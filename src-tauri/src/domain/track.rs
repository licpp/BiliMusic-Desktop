use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceIdentity {
    pub provider: String,
    pub bvid: String,
    pub cid: i64,
    pub page: i32,
}

impl SourceIdentity {
    pub fn stable_key(&self) -> String {
        format!("{}:{}:{}", self.provider, self.bvid, self.cid)
    }
}

#[cfg(test)]
mod tests {
    use super::SourceIdentity;

    #[test]
    fn stable_key_distinguishes_video_parts() {
        let p1 = SourceIdentity {
            provider: "bilibili".into(),
            bvid: "BV1".into(),
            cid: 10,
            page: 1,
        };
        let p2 = SourceIdentity {
            cid: 11,
            page: 2,
            ..p1.clone()
        };
        assert_ne!(p1.stable_key(), p2.stable_key());
    }
}
