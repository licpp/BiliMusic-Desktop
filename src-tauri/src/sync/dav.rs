//! Each device owns its file. Nutstore ignores conditional PUT and MKCOL exclusion.
//! Causal multi-value registers prevent cross-device overwrite without server locks.
use super::{
    Config,
    model::*,
    transport::{Remote, Secret, client},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
pub const MAX_DOC_BYTES: usize = 12 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct Dot {
    pub device: String,
    pub seq: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Register {
    pub dot: Dot,
    pub context: BTreeMap<String, u64>,
    pub value: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Doc {
    pub schema: u32,
    pub uid: String,
    pub clock: BTreeMap<String, u64>,
    pub fields: BTreeMap<String, Vec<Register>>,
}
impl Doc {
    pub fn empty(uid: &str) -> Self {
        Self {
            schema: 1,
            uid: uid.into(),
            clock: BTreeMap::new(),
            fields: BTreeMap::new(),
        }
    }
    pub fn join(&mut self, other: Doc) -> Result<(), String> {
        if other.schema != 1
            || other.uid != self.uid
            || other.clock.len() > 10
            || other.fields.len() > 150000
        {
            return Err("坚果云同步文件格式或配额不正确".into());
        }
        for (k, mut regs) in other.fields {
            let dest = self.fields.entry(k).or_default();
            dest.append(&mut regs);
            dest.sort_by(|a, b| a.dot.cmp(&b.dot));
            dest.dedup_by(|a, b| a.dot == b.dot);
            let all = dest.clone();
            dest.retain(|r| {
                !all.iter().any(|o| {
                    o.dot != r.dot
                        && o.context.get(&r.dot.device).copied().unwrap_or(0) >= r.dot.seq
                })
            });
            if dest.len() > 10 {
                return Err("并发版本过多，请先处理冲突".into());
            }
        }
        for (d, s) in other.clock {
            self.clock
                .entry(d)
                .and_modify(|v| *v = (*v).max(s))
                .or_insert(s);
        }
        self.compact_deleted();
        Ok(())
    }
    fn compact_deleted(&mut self) {
        let mut deleted = BTreeMap::<String, Vec<Register>>::new();
        for (key, regs) in &self.fields {
            if let Ok((record, _, field)) = serde_json::from_str::<(String, String, String)>(key) {
                if field == "__present"
                    && !regs.is_empty()
                    && regs.iter().all(|r| r.value == json!(false))
                {
                    deleted.insert(record, regs.clone());
                }
            }
        }
        self.fields.retain(|key, regs| {
            let Ok((record, _, field)) = serde_json::from_str::<(String, String, String)>(key)
            else {
                return false;
            };
            if field == "__present" {
                return true;
            }
            if let Some(deletes) = deleted.get(&record) {
                regs.retain(|r| {
                    !deletes.iter().any(|d| {
                        d.dot == r.dot
                            || d.context.get(&r.dot.device).copied().unwrap_or(0) >= r.dot.seq
                    })
                });
            }
            !regs.is_empty()
        });
    }
    fn flat(s: &Snapshot) -> BTreeMap<String, Value> {
        let mut result = BTreeMap::new();
        for (k, r) in &s.records {
            result.insert(
                serde_json::to_string(&(k, &r.kind, "__present")).unwrap(),
                json!(true),
            );
            for (f, v) in &r.fields {
                result.insert(serde_json::to_string(&(k, &r.kind, f)).unwrap(), v.clone());
            }
        }
        result
    }
    pub fn materialize(&self) -> Result<(Snapshot, Vec<Conflict>), String> {
        let mut snapshot = Snapshot::empty(&self.uid);
        let mut absent = BTreeSet::new();
        let mut conflicts = vec![];
        for (k, regs) in &self.fields {
            if regs.is_empty() {
                continue;
            }
            let (key, kind, field): (String, String, String) =
                serde_json::from_str(k).map_err(|_| "同步字段键无效")?;
            if field == "__record" {
                continue;
            }
            let value = &regs[0].value;
            let distinct: BTreeSet<_> = regs.iter().map(|r| r.value.to_string()).collect();
            if distinct.len() > 1 {
                conflicts.push(Conflict {
                    key: key.clone(),
                    field: field.clone(),
                    local: regs[0].value.clone(),
                    remote: regs.last().unwrap().value.clone(),
                });
            }
            if field == "__present" {
                if regs.iter().any(|r| r.value == json!(false)) {
                    absent.insert(key);
                }
                continue;
            }
            let record = snapshot.records.entry(key).or_insert_with(|| Record {
                kind,
                fields: BTreeMap::new(),
            });
            record.fields.insert(field, value.clone());
        }
        snapshot.records.retain(|k, _| !absent.contains(k));
        snapshot.compact(true);
        snapshot.validate(&self.uid)?;
        Ok((snapshot, conflicts))
    }
    pub fn resolved(&self, local: &Snapshot, prefer_local: bool) -> Result<Snapshot, String> {
        let (mut result, conflicts) = self.materialize()?;
        for c in conflicts.iter().filter(|c| c.field == "__present") {
            let live = if prefer_local {
                local.records.contains_key(&c.key)
            } else {
                !local.records.contains_key(&c.key)
            };
            if !live {
                result.records.remove(&c.key);
                continue;
            }
            if prefer_local {
                if let Some(r) = local.records.get(&c.key) {
                    result.records.insert(c.key.clone(), r.clone());
                }
            } else {
                for (k, regs) in &self.fields {
                    let (key, _, field): (String, String, String) =
                        serde_json::from_str(k).map_err(|_| "字段格式错误")?;
                    if key == c.key && field == "__record" {
                        if let Some(r) = regs
                            .iter()
                            .find_map(|v| serde_json::from_value::<Record>(v.value.clone()).ok())
                        {
                            result.records.insert(key, r);
                        }
                    }
                }
            }
        }
        for c in conflicts.iter().filter(|c| c.field != "__present") {
            if let Some(r) = result.records.get_mut(&c.key) {
                let current = local
                    .records
                    .get(&c.key)
                    .and_then(|r| r.fields.get(&c.field))
                    .cloned()
                    .unwrap_or(Value::Null);
                let value = if prefer_local {
                    current
                } else if c.local != current {
                    c.local.clone()
                } else {
                    c.remote.clone()
                };
                r.fields.insert(c.field.clone(), value);
            }
        }
        result.compact(true);
        result.validate(&self.uid)?;
        Ok(result)
    }
    pub fn update(&mut self, device: &str, snapshot: &Snapshot) -> Result<(), String> {
        let (before, conflicts) = self.materialize()?;
        let old = Self::flat(&before);
        let new = Self::flat(snapshot);
        if old == new && conflicts.is_empty() {
            return Ok(());
        }
        let seq = self
            .clock
            .get(device)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("设备序列超限")?;
        let context = self.clock.clone();
        let keys: BTreeSet<_> = old
            .keys()
            .chain(new.keys())
            .chain(self.fields.keys())
            .cloned()
            .collect();
        let conflicted: BTreeSet<_> = conflicts
            .iter()
            .map(|c| (c.key.as_str(), c.field.as_str()))
            .collect();
        let changed_records: BTreeSet<_> = keys
            .iter()
            .filter(|k| old.get(*k) != new.get(*k))
            .filter_map(|k| {
                serde_json::from_str::<(String, String, String)>(k)
                    .ok()
                    .map(|v| v.0)
            })
            .collect();
        for key in keys {
            let (record, kind, field): (String, String, String) =
                serde_json::from_str(&key).map_err(|_| "字段键无效")?;
            let presence = field == "__present";
            if old.get(&key) == new.get(&key)
                && !conflicted.contains(&(record.as_str(), field.as_str()))
                && !(presence && changed_records.contains(&record))
            {
                continue;
            }
            let value =
                new.get(&key)
                    .cloned()
                    .unwrap_or(if presence { json!(false) } else { Value::Null });
            self.fields.insert(
                key,
                vec![Register {
                    dot: Dot {
                        device: device.into(),
                        seq,
                    },
                    context: context.clone(),
                    value,
                }],
            );
            let _ = kind;
        }
        let affected: BTreeSet<_> = changed_records
            .into_iter()
            .chain(conflicts.iter().map(|c| c.key.clone()))
            .collect();
        for record in affected {
            let kind = snapshot
                .records
                .get(&record)
                .map(|r| r.kind.clone())
                .or_else(|| before.records.get(&record).map(|r| r.kind.clone()))
                .unwrap_or_else(|| record.split(':').next().unwrap_or("").to_owned());
            let key = serde_json::to_string(&(&record, &kind, "__record")).unwrap();
            self.fields.insert(
                key,
                vec![Register {
                    dot: Dot {
                        device: device.into(),
                        seq,
                    },
                    context: context.clone(),
                    value: snapshot
                        .records
                        .get(&record)
                        .map(|r| serde_json::to_value(r).unwrap())
                        .unwrap_or(Value::Null),
                }],
            );
        }
        self.clock.insert(device.into(), seq);
        self.compact_deleted();
        if self.clock.len() > 10 {
            return Err("坚果云最多连接10台设备，请先清理已停用设备文件".into());
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct DavState {
    pub doc: Doc,
    pub needs_publish: bool,
}
fn folder(c: &Config) -> String {
    format!(
        "{}/BiliMusic-sync-v1/{}/",
        c.url.trim_end_matches('/'),
        c.uid
    )
}
async fn bytes(mut r: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    while let Some(chunk) = r.chunk().await.map_err(|_| "坚果云下载中断")? {
        if out.len() + chunk.len() > MAX_DOC_BYTES {
            return Err("坚果云设备快照超过12MB上限".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}
fn request(c: &reqwest::Client, method: &str, url: String, s: &Secret) -> reqwest::RequestBuilder {
    c.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
        .basic_auth(&s.username, Some(&s.password))
        .header("User-Agent", "BiliMusic/0.1.6")
}
fn check(status: reqwest::StatusCode) -> Result<(), String> {
    if status.is_success() {
        Ok(())
    } else if matches!(status.as_u16(), 401 | 403) {
        Err("同步授权失效，请重新连接（已停止自动重试）".into())
    } else {
        Err(format!("坚果云返回 HTTP {}", status.as_u16()))
    }
}
pub async fn read(c: &Config, s: &Secret) -> Result<Remote, String> {
    let http = client()?;
    let root = folder(c);
    let response=request(&http,"PROPFIND",root.clone(),s).header("Depth","1").header("Content-Type","application/xml").body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>").send().await.map_err(|_|"无法连接坚果云")?;
    if response.status().as_u16() == 404 {
        return Ok(Remote {
            snapshot: Snapshot::empty(&c.uid),
            version: None,
            dav: Some(DavState {
                doc: Doc::empty(&c.uid),
                needs_publish: true,
            }),
            conflicts: vec![],
        });
    }
    check(response.status())?;
    let data = bytes(response).await?;
    let mut reader = quick_xml::Reader::from_reader(data.as_slice());
    let mut href = false;
    let mut files = BTreeSet::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                href = e.local_name().as_ref() == b"href";
            }
            Ok(quick_xml::events::Event::Text(e)) if href => {
                let value = e.decode().map_err(|_| "WebDAV目录编码错误")?;
                let url = url::Url::parse(&root)
                    .unwrap()
                    .join(&value)
                    .map_err(|_| "WebDAV文件路径无效")?;
                let name = url.path().rsplit('/').next().unwrap_or("");
                if let Some(id) = name.strip_suffix(".json") {
                    if uuid::Uuid::parse_str(id).is_ok() && url.as_str() == format!("{root}{name}")
                    {
                        files.insert(url.to_string());
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => return Err("WebDAV目录解析失败".into()),
            _ => {}
        }
    }
    if files.len() > 10 {
        return Err("坚果云同步设备文件超过10个，请清理已停用设备".into());
    }
    let mut doc = Doc::empty(&c.uid);
    let mut own_doc = None;
    for file in files {
        let own = file.ends_with(&format!("/{}.json", c.device_id));
        let r = request(&http, "GET", file, s)
            .send()
            .await
            .map_err(|_| "坚果云设备快照读取失败")?;
        check(r.status())?;
        let other: Doc =
            serde_json::from_slice(&bytes(r).await?).map_err(|_| "坚果云设备快照格式无效")?;
        if own {
            own_doc = Some(other.clone());
        }
        doc.join(other)?;
    }
    let (snapshot, conflicts) = doc.materialize()?;
    Ok(Remote {
        snapshot,
        version: Some("device-registers-v1".into()),
        dav: Some(DavState {
            needs_publish: own_doc.as_ref() != Some(&doc),
            doc,
        }),
        conflicts,
    })
}
pub async fn write(
    c: &Config,
    s: &Secret,
    remote: &Remote,
    snapshot: &Snapshot,
) -> Result<bool, String> {
    let mut doc = remote.dav.as_ref().ok_or("坚果云状态缺失")?.doc.clone();
    doc.update(&c.device_id, snapshot)?;
    let payload = serde_json::to_vec(&doc).map_err(|_| "坚果云快照编码失败")?;
    if payload.len() > MAX_DOC_BYTES {
        return Err("坚果云设备快照超过12MB，请清理旧设备或导出重建同步库".into());
    }
    let http = client()?;
    for path in [
        format!("{}/BiliMusic-sync-v1/", c.url.trim_end_matches('/')),
        folder(c),
    ] {
        let r = request(&http, "MKCOL", path, s)
            .body("")
            .send()
            .await
            .map_err(|_| "坚果云目录创建失败")?;
        if !matches!(r.status().as_u16(), 201 | 405) {
            check(r.status())?;
        }
    }
    let r = request(
        &http,
        "PUT",
        format!("{}{}.json", folder(c), c.device_id),
        s,
    )
    .header("Content-Type", "application/json")
    .body(payload)
    .send()
    .await
    .map_err(|_| "坚果云上传中断")?;
    check(r.status())?;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Snapshot {
        let mut s = Snapshot::empty("42");
        s.records.insert("playlist:12345678-1234-4234-8234-123456789abc".into(),Record{kind:"playlist".into(),fields:serde_json::from_value(json!({"id":"12345678-1234-4234-8234-123456789abc","name":"first","description":"old"})).unwrap()});
        s
    }
    #[test]
    fn concurrent_fields_survive_and_deleted_records_do_not_resurrect() {
        let mut original = Doc::empty("42");
        original.update("a", &sample()).unwrap();
        let mut a = original.clone();
        let mut b = original.clone();
        let mut sa = sample();
        let mut sb = sample();
        let key = sa.records.keys().next().unwrap().clone();
        sa.records
            .get_mut(&key)
            .unwrap()
            .fields
            .insert("name".into(), json!("new"));
        sb.records
            .get_mut(&key)
            .unwrap()
            .fields
            .insert("description".into(), json!("note"));
        a.update("a", &sa).unwrap();
        b.update("b", &sb).unwrap();
        a.join(b).unwrap();
        let (s, c) = a.materialize().unwrap();
        assert!(c.is_empty());
        assert_eq!(text(&s.records[&key], "name"), "new");
        assert_eq!(text(&s.records[&key], "description"), "note");
        let stale = original.clone();
        a.update("a", &Snapshot::empty("42")).unwrap();
        a.join(stale).unwrap();
        assert!(a.materialize().unwrap().0.records.is_empty());
    }
    #[test]
    fn same_field_concurrency_is_visible_until_explicit_resolution() {
        let mut original = Doc::empty("42");
        original.update("a", &sample()).unwrap();
        let mut a = original.clone();
        let mut b = original;
        let mut sa = sample();
        let mut sb = sample();
        let key = sa.records.keys().next().unwrap().clone();
        sa.records
            .get_mut(&key)
            .unwrap()
            .fields
            .insert("name".into(), json!("one"));
        sb.records
            .get_mut(&key)
            .unwrap()
            .fields
            .insert("name".into(), json!("two"));
        a.update("a", &sa).unwrap();
        b.update("b", &sb).unwrap();
        a.join(b).unwrap();
        assert_eq!(a.materialize().unwrap().1.len(), 1);
        a.update("a", &sa).unwrap();
        assert!(a.materialize().unwrap().1.is_empty());
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires explicitly supplied WebDAV test credentials"]
    async fn live_nutstore_two_devices_merge_and_delete() {
        let username = std::env::var("SYNC_TEST_USERNAME").expect("test username");
        let password = std::env::var("SYNC_TEST_PASSWORD").expect("test application password");
        let url = std::env::var("SYNC_TEST_ROOT").expect("isolated test root");
        let uid = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        let mut a = Config::default();
        a.uid = uid.clone();
        a.url = url;
        a.device_id = uuid::Uuid::new_v4().to_string();
        let mut b = a.clone();
        b.device_id = uuid::Uuid::new_v4().to_string();
        let credentials = Secret { username, password };
        let http = client().unwrap();
        let result=async {
   let initial=read(&a,&credentials).await?;let mut first=Snapshot::empty(&uid);let id=uuid::Uuid::new_v4().to_string();let key=format!("playlist:{id}");
   first.records.insert(key.clone(),Record{kind:"playlist".into(),fields:serde_json::from_value(json!({"id":id,"name":"Test playlist","description":"initial","coverUrl":null})).unwrap()});
   write(&a,&credentials,&initial,&first).await?;
   let ra=read(&a,&credentials).await?;let rb=read(&b,&credentials).await?;if ra.snapshot!=first{return Err("initial read mismatch".to_owned());}
   let mut left=ra.snapshot.clone();let mut right=rb.snapshot.clone();left.records.get_mut(&key).unwrap().fields.insert("name".into(),json!("device A edit"));right.records.get_mut(&key).unwrap().fields.insert("description".into(),json!("device B edit"));
   write(&a,&credentials,&ra,&left).await?;write(&b,&credentials,&rb,&right).await?;
   let combined=read(&a,&credentials).await?;
   if !combined.conflicts.is_empty()||text(&combined.snapshot.records[&key],"name")!="device A edit"||text(&combined.snapshot.records[&key],"description")!="device B edit"{return Err("concurrent field merge failed".into());}
   write(&a,&credentials,&combined,&Snapshot::empty(&uid)).await?;
   write(&b,&credentials,&rb,&rb.snapshot).await?;
   if !read(&a,&credentials).await?.snapshot.records.is_empty(){return Err("offline device resurrected deletion".into());}
   let acknowledge=read(&b,&credentials).await?;
   write(&b,&credentials,&acknowledge,&acknowledge.snapshot).await?;
   let stable=read(&a,&credentials).await?;
   if stable.dav.as_ref().unwrap().needs_publish{return Err("unchanged devices keep republishing".into());}
   if stable.dav.as_ref().unwrap().doc.fields.keys().any(|k|!k.contains("__present")){return Err("deleted personal fields were retained".into());}
   Ok::<(),String>(())
  }.await;
        let cleanup = request(
            &http,
            "DELETE",
            format!("{}/BiliMusic-sync-v1/", a.url.trim_end_matches('/')),
            &credentials,
        )
        .send()
        .await;
        assert!(
            cleanup.is_ok_and(|r| r.status().is_success()),
            "isolated test subtree cleanup failed"
        );
        assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    }
}
