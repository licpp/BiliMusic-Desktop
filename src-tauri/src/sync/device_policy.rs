//! Informational device activity. Retirement/expiry never gates migration or deletes data.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const DORMANT_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub ready: bool,
    pub has_data: bool,
    pub retired: bool,
    /// Server time of a capability heartbeat or a changed source, not last local GET.
    pub last_activity: Option<u64>,
    pub sources: BTreeMap<String, String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Ready,
    Waiting,
    Retired,
    Dormant,
    Unknown,
    Empty,
}
impl Device {
    pub fn status(&self, now: u64) -> Status {
        if self.retired {
            return Status::Retired;
        }
        // Empty source sets are not proof of emptiness; has_data is an explicit checked claim.
        if !self.has_data {
            return Status::Empty;
        }
        match self.last_activity {
            Some(time) if time <= now && now - time >= DORMANT_SECONDS => Status::Dormant,
            Some(time) if time <= now => {
                if self.ready {
                    Status::Ready
                } else {
                    Status::Waiting
                }
            }
            _ => Status::Unknown,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn device(id: &str, time: Option<u64>, ready: bool) -> Device {
        Device {
            id: id.into(),
            name: id.into(),
            platform: "test".into(),
            ready,
            has_data: true,
            retired: false,
            last_activity: time,
            sources: BTreeMap::from([(format!("legacy:{id}"), format!("hash-{id}"))]),
        }
    }
    #[test]
    fn one_week_boundary_and_clock_anomalies_are_explicit() {
        let d = device("a", Some(100), false);
        assert_eq!(d.status(100 + DORMANT_SECONDS - 1), Status::Waiting);
        assert_eq!(d.status(100 + DORMANT_SECONDS), Status::Dormant);
        assert_eq!(d.status(99), Status::Unknown);
        assert_eq!(device("a", None, false).status(u64::MAX), Status::Unknown);
    }
    #[test]
    fn retirement_is_an_information_state_not_data_deletion() {
        let mut d = device("old", Some(100), false);
        d.retired = true;
        assert_eq!(d.status(101), Status::Retired);
        assert_eq!(d.sources.len(), 1);
    }
}
