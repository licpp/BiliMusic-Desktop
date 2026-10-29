use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_BYTES: usize = 3 * 1024 * 1024;
pub const HISTORY_LIMIT: usize = 200;
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub kind: String,
    pub fields: BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub schema: u32,
    pub uid: String,
    pub records: BTreeMap<String, Record>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub key: String,
    pub field: String,
    pub local: Value,
    pub remote: Value,
}
impl Snapshot {
    pub fn empty(uid: &str) -> Self {
        Self {
            schema: 1,
            uid: uid.into(),
            records: BTreeMap::new(),
        }
    }
    pub fn compact(&mut self, history: bool) {
        if !history {
            self.records.retain(|_, r| r.kind != "history");
        }
        let mut recent: Vec<_> = self
            .records
            .iter()
            .filter(|(_, r)| r.kind == "history")
            .map(|(k, r)| (k.clone(), text(r, "playedAt").to_owned()))
            .collect();
        recent.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        for (key, _) in recent.into_iter().skip(HISTORY_LIMIT) {
            self.records.remove(&key);
        }
        let lists: BTreeSet<_> = self
            .records
            .iter()
            .filter(|(_, r)| r.kind == "playlist")
            .map(|(k, _)| k.clone())
            .collect();
        self.records.retain(|_, r| {
            r.kind != "item" || lists.contains(&format!("playlist:{}", text(r, "playlistId")))
        });
        let referenced: BTreeSet<_> = self
            .records
            .values()
            .filter(|r| matches!(r.kind.as_str(), "favorite" | "item" | "history"))
            .map(|r| text(r, "trackId").to_owned())
            .collect();
        self.records.retain(|_, r| {
            !matches!(r.kind.as_str(), "track" | "lyric") || referenced.contains(text(r, "id"))
        });
    }
    pub fn validate(&self, uid: &str) -> Result<(), String> {
        if self.schema != 1
            || self.uid != uid
            || uid.is_empty()
            || !uid.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("同步资料库账号或版本不匹配".into());
        }
        if self.records.len() > 22_000
            || serde_json::to_vec(self)
                .map_err(|_| "同步数据编码失败")?
                .len()
                > MAX_BYTES
        {
            return Err("同步数据超过3MB或记录数上限".into());
        }
        let mut counts = BTreeMap::<&str, usize>::new();
        for (key, r) in &self.records {
            let allowed: &[&str] = match r.kind.as_str() {
                "track" => &[
                    "id",
                    "bvid",
                    "cid",
                    "overrideTitle",
                    "overrideArtist",
                    "overrideAlbum",
                    "overrideCover",
                ],
                "playlist" => &["id", "name", "description", "coverUrl"],
                "item" => &["playlistId", "trackId", "position"],
                "favorite" => &["trackId"],
                "history" => &["trackId", "playedAt"],
                "lyric" => &["id", "provider", "providerLyricId", "biasMs", "manual"],
                _ => return Err("不支持的同步记录".into()),
            };
            if r.fields.keys().any(|k| !allowed.contains(&k.as_str())) {
                return Err("同步包包含不应上传的原始信息".into());
            }
            *counts.entry(&r.kind).or_default() += 1;
            if key.len() > 240
                || r.fields.len() > 24
                || r.fields.values().any(|v| {
                    !matches!(
                        v,
                        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
                    ) || v.as_str().is_some_and(|s| s.len() > 4096)
                })
            {
                return Err("同步记录格式或字段长度无效".into());
            }
            let id = text(r, "id");
            let track = text(r, "trackId");
            let valid = match r.kind.as_str() {
                "track" => {
                    key == &format!("track:{id}")
                        && id == format!("bilibili:{}:{}", text(r, "bvid"), number(r, "cid"))
                        && text(r, "bvid").starts_with("BV")
                        && text(r, "bvid").bytes().all(|c| c.is_ascii_alphanumeric())
                        && number(r, "cid") > 0
                }
                "playlist" => {
                    key == &format!("playlist:{id}")
                        && uuid::Uuid::parse_str(id).is_ok()
                        && !text(r, "name").trim().is_empty()
                }
                "favorite" => key == &format!("favorite:{track}"),
                "history" => {
                    key == &format!("history:{track}")
                        && text(r, "playedAt").len() == 19
                        && text(r, "playedAt")
                            .bytes()
                            .all(|b| b.is_ascii_digit() || b"- :".contains(&b))
                }
                "item" => {
                    key == &format!("item:{}|{track}", text(r, "playlistId"))
                        && uuid::Uuid::parse_str(text(r, "playlistId")).is_ok()
                        && number(r, "position") >= 0
                }
                "lyric" => {
                    key == &format!("lyric:{id}")
                        && matches!(text(r, "provider"), "lrclib" | "netease" | "local")
                        && number(r, "biasMs").unsigned_abs() <= 30_000
                }
                _ => false,
            };
            if !valid {
                return Err("同步记录身份无效".into());
            }
            if matches!(r.kind.as_str(), "favorite" | "history" | "item")
                && !self.records.contains_key(&format!("track:{track}"))
            {
                return Err("同步记录缺少歌曲".into());
            }
            for name in ["coverUrl", "overrideCover"] {
                if let Some(value) = r.fields.get(name).and_then(Value::as_str) {
                    if !value.is_empty() && !safe_cover(value) {
                        return Err("封面必须是可跨设备访问的 HTTPS 地址".into());
                    }
                }
            }
        }
        for (kind, limit) in [
            ("playlist", 500),
            ("track", 5000),
            ("item", 10000),
            ("history", HISTORY_LIMIT),
        ] {
            if counts.get(kind).copied().unwrap_or(0) > limit {
                return Err(format!("{kind}超过同步数量上限{limit}"));
            }
        }
        Ok(())
    }
}
pub fn safe_cover(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str()
                .is_some_and(|h| h != "localhost" && h != "127.0.0.1" && h != "[::1]")
    })
}
pub fn text<'a>(r: &'a Record, k: &str) -> &'a str {
    r.fields.get(k).and_then(Value::as_str).unwrap_or("")
}
pub fn number(r: &Record, k: &str) -> i64 {
    r.fields.get(k).and_then(Value::as_i64).unwrap_or(0)
}
pub fn merge(
    base: &Snapshot,
    local: &Snapshot,
    remote: &Snapshot,
    resolution: Option<&str>,
) -> (Snapshot, Vec<Conflict>) {
    let mut result = Snapshot::empty(&local.uid);
    let mut conflicts = vec![];
    let keys: BTreeSet<_> = base
        .records
        .keys()
        .chain(local.records.keys())
        .chain(remote.records.keys())
        .cloned()
        .collect();
    for key in keys {
        let b = base.records.get(&key);
        let l = local.records.get(&key);
        let r = remote.records.get(&key);
        let value = if l == r || r == b {
            l.cloned()
        } else if l == b {
            r.cloned()
        } else if let (Some(l), Some(r)) = (l, r) {
            if l.kind == "history" {
                Some(
                    if text(l, "playedAt") >= text(r, "playedAt") {
                        l
                    } else {
                        r
                    }
                    .clone(),
                )
            } else {
                let mut rec = l.clone();
                let fields: BTreeSet<_> = l
                    .fields
                    .keys()
                    .chain(r.fields.keys())
                    .chain(b.into_iter().flat_map(|b| b.fields.keys()))
                    .cloned()
                    .collect();
                for field in fields {
                    let bv = b.and_then(|b| b.fields.get(&field));
                    let lv = l.fields.get(&field);
                    let rv = r.fields.get(&field);
                    let v = if lv == rv || rv == bv {
                        lv
                    } else if lv == bv {
                        rv
                    } else {
                        conflicts.push(Conflict {
                            key: key.clone(),
                            field: field.clone(),
                            local: lv.cloned().unwrap_or(Value::Null),
                            remote: rv.cloned().unwrap_or(Value::Null),
                        });
                        if resolution == Some("remote") { rv } else { lv }
                    };
                    if let Some(v) = v {
                        rec.fields.insert(field, v.clone());
                    } else {
                        rec.fields.remove(&field);
                    }
                }
                Some(rec)
            }
        } else {
            conflicts.push(Conflict {
                key: key.clone(),
                field: "record".into(),
                local: serde_json::to_value(l).unwrap(),
                remote: serde_json::to_value(r).unwrap(),
            });
            if resolution == Some("local") {
                l.cloned()
            } else if resolution == Some("remote") {
                r.cloned()
            } else {
                None
            }
        };
        if let Some(v) = value {
            result.records.insert(key, v);
        }
    }
    (result, conflicts)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn track() -> Record {
        Record{kind:"track".into(),fields:serde_json::from_value(json!({"id":"bilibili:BV1:1","bvid":"BV1","cid":1,"overrideTitle":"original","overrideArtist":"a","overrideAlbum":"old"})).unwrap()}
    }
    fn sample() -> Snapshot {
        let mut s = Snapshot::empty("42");
        s.records.insert("track:bilibili:BV1:1".into(), track());
        s.records.insert(
            "favorite:bilibili:BV1:1".into(),
            Record {
                kind: "favorite".into(),
                fields: serde_json::from_value(json!({"trackId":"bilibili:BV1:1"})).unwrap(),
            },
        );
        s
    }
    #[test]
    fn merge_fields_and_detect_collision() {
        let b = sample();
        let mut l = b.clone();
        let mut r = b.clone();
        l.records
            .get_mut("track:bilibili:BV1:1")
            .unwrap()
            .fields
            .insert("overrideArtist".into(), json!("local"));
        r.records
            .get_mut("track:bilibili:BV1:1")
            .unwrap()
            .fields
            .insert("overrideAlbum".into(), json!("remote"));
        let (m, c) = merge(&b, &l, &r, None);
        assert!(c.is_empty());
        assert_eq!(
            text(&m.records["track:bilibili:BV1:1"], "overrideArtist"),
            "local"
        );
        r.records
            .get_mut("track:bilibili:BV1:1")
            .unwrap()
            .fields
            .insert("overrideArtist".into(), json!("other"));
        assert_eq!(merge(&b, &l, &r, None).1.len(), 1);
    }
    #[test]
    fn deletion_does_not_resurrect_and_orphan_removed() {
        let b = sample();
        let l = b.clone();
        let r = Snapshot::empty("42");
        let (mut m, c) = merge(&b, &l, &r, None);
        assert!(c.is_empty());
        m.compact(true);
        assert!(m.records.is_empty());
        let mut s = sample();
        s.records.remove("favorite:bilibili:BV1:1");
        s.compact(true);
        assert!(s.records.is_empty());
    }
    #[test]
    fn reject_wrong_account_and_large_fields() {
        let mut s = sample();
        assert!(s.validate("43").is_err());
        assert!(s.validate("42").is_ok());
        s.records
            .get_mut("track:bilibili:BV1:1")
            .unwrap()
            .fields
            .insert("overrideTitle".into(), json!("a".repeat(4097)));
        assert!(s.validate("42").is_err());
    }
}
