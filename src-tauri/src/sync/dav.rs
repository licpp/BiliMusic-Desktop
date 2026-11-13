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
            let value = if kind == "collectionProgress" && field == "checkpoint" {
                &regs
                    .iter()
                    .max_by_key(|r| checkpoint_order(&r.value))
                    .unwrap()
                    .value
            } else if kind == "history" && field == "resume" {
                &regs
                    .iter()
                    .max_by_key(|r| track_position_order(&r.value))
                    .unwrap()
                    .value
            } else if kind == "history" && field == "playedAt" {
                &regs
                    .iter()
                    .max_by_key(|r| r.value.as_str().unwrap_or_default())
                    .unwrap()
                    .value
            } else {
                &regs[0].value
            };
            let distinct: BTreeSet<_> = regs.iter().map(|r| r.value.to_string()).collect();
            if distinct.len() > 1
                && kind != "collectionProgress"
                && !(kind == "history" && matches!(field.as_str(), "playedAt" | "resume"))
            {
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
            if !(record.kind == "history" && field == "resume" && value.is_null()) {
                record.fields.insert(field, value.clone());
            }
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
    pub linked: Option<Box<DavState>>,
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
    } else if status.as_u16() == 401 {
        Err("同步授权失效（HTTP 401），请使用坚果云应用密码重新连接（已停止自动重试）".into())
    } else if status.as_u16() == 403 {
        Err("坚果云拒绝访问（HTTP 403），请检查账号权限、服务器目录及服务限制".into())
    } else if status.as_u16() == 409 {
        Err("坚果云目录冲突（HTTP 409），请检查服务器地址是否指向已存在的文件夹".into())
    } else if status.as_u16() == 429 {
        Err("坚果云请求过于频繁，请稍后重试".into())
    } else {
        Err(format!("坚果云返回 HTTP {}", status.as_u16()))
    }
}
fn missing_ancestor(data: &[u8]) -> bool {
    let mut reader = quick_xml::Reader::from_reader(data);
    let mut exception = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                exception = e.local_name().as_ref() == b"exception";
            }
            Ok(quick_xml::events::Event::Text(e)) if exception => {
                return e.decode().is_ok_and(|s| s == "AncestorsNotFound");
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => return false,
            _ => {}
        }
    }
}
pub async fn read(c: &Config, s: &Secret) -> Result<Remote, String> {
    let mut main = read_vault(c, s, false).await?;
    // A missing account root cannot contain an extension. Preserve first-connect
    // read-only checks without doubling requests for an uninitialized vault.
    if main.version.is_none() {
        if let Some(state) = main.dav.as_mut() {
            state.linked = Some(Box::new(DavState {
                doc: Doc::empty(&c.uid),
                needs_publish: false,
                linked: None,
            }));
        }
        return Ok(main);
    }
    let linked = read_vault(c, s, true).await?;
    if linked
        .snapshot
        .records
        .values()
        .any(|r| r.kind != "linkedFolder")
    {
        return Err("关联收藏夹同步区包含不支持的资料".into());
    }
    if main
        .snapshot
        .records
        .values()
        .any(|r| r.kind == "linkedFolder")
    {
        return Err("关联收藏夹清单应保存在独立同步区".into());
    }
    main.snapshot.records.extend(linked.snapshot.records);
    main.snapshot.validate(&c.uid)?;
    main.conflicts.extend(linked.conflicts);
    if let Some(state) = main.dav.as_mut() {
        let linked = linked.dav.ok_or("关联收藏夹同步状态缺失")?;
        // An absent empty extension needs no write or device file.
        state.needs_publish |= linked.needs_publish
            && (!linked.doc.fields.is_empty()
                || !main.snapshot.linked_folders().records.is_empty());
        state.linked = Some(Box::new(linked));
    }
    Ok(main)
}
async fn read_vault(c: &Config, s: &Secret, linked: bool) -> Result<Remote, String> {
    let http = client()?;
    let root = if linked {
        format!("{}linked-folders-v1/", folder(c))
    } else {
        folder(c)
    };
    let response=request(&http,"PROPFIND",root.clone(),s).header("Depth","1").header("Content-Type","application/xml").body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>").send().await.map_err(|_|"无法连接坚果云")?;
    // Nutstore returns 409 AncestorsNotFound, rather than 404, when the
    // application parent directory has never been created. Keep connect read-only.
    let status = response.status();
    let data = bytes(response).await?;
    if status.as_u16() == 404 || (status.as_u16() == 409 && missing_ancestor(&data)) {
        // A typo/nonexistent user-supplied base must not masquerade as an empty vault.
        let base = request(
            &http,
            "PROPFIND",
            format!("{}/", c.url.trim_end_matches('/')),
            s,
        )
        .header("Depth", "0")
        .send()
        .await
        .map_err(|_| "无法检查坚果云服务器地址")?;
        check(base.status()).map_err(|e| format!("检查坚果云根目录失败：{e}"))?;
        return Ok(Remote {
            snapshot: Snapshot::empty(&c.uid),
            version: None,
            dav: Some(DavState {
                doc: Doc::empty(&c.uid),
                needs_publish: true,
                linked: None,
            }),
            conflicts: vec![],
            legacy_cloud: false,
            track_positions: true,
            creators: true,
            creator_groups: true,
        });
    }
    check(status)?;
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
            linked: None,
            doc,
        }),
        conflicts,
        legacy_cloud: false,
        track_positions: true,
        creators: true,
        creator_groups: true,
    })
}
async fn put_snapshot(
    http: &reqwest::Client,
    url: String,
    secret: &Secret,
    payload: Vec<u8>,
) -> Result<reqwest::StatusCode, String> {
    #[cfg(target_env = "ohos")]
    {
        let _ = http;
        return crate::ohos_playback::put_webdav(
            &url,
            &secret.username,
            &secret.password,
            &payload,
        )
        .await;
    }
    #[cfg(not(target_env = "ohos"))]
    for attempt in 1..=2 {
        let result = request(http, "PUT", url.clone(), secret)
            .header("Content-Type", "application/json")
            .body(payload.clone())
            .send()
            .await;
        match result {
            Ok(response) => return Ok(response.status()), // HTTP denials/limits are never retried.
            Err(error) => {
                let retryable = error.is_timeout()
                    || error.is_connect()
                    || error.is_body()
                    || error.is_request();
                let reason = if error.is_timeout() {
                    "超时"
                } else if error.is_connect() {
                    "连接失败"
                } else if error.is_body() {
                    "请求体发送失败"
                } else {
                    "连接中断"
                };
                // Remove the request URL (which includes the account/device path).
                // Request errors do not include Authorization headers or body data.
                let diagnostic = format!(
                    "WebDAV PUT attempt={attempt} bytes={} error={:?}",
                    payload.len(),
                    error.without_url()
                );
                eprintln!("{diagnostic}");
                if attempt == 1 && retryable {
                    // Each device owns this file. Replaying identical bytes is
                    // safe even if the first PUT committed but its reply was lost.
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    continue;
                }
                return Err(format!(
                    "坚果云上传{reason}，请检查网络后重试（本机数据已保留）"
                ));
            }
        }
    }
    #[cfg(not(target_env = "ohos"))]
    unreachable!()
}

pub async fn write(
    c: &Config,
    s: &Secret,
    remote: &Remote,
    snapshot: &Snapshot,
) -> Result<bool, String> {
    let state = remote.dav.as_ref().ok_or("坚果云状态缺失")?;
    let mut main = snapshot.clone();
    main.omit_linked_folders();
    let linked = snapshot.linked_folders();
    let http = client()?;
    for path in [
        format!("{}/BiliMusic-sync-v1/", c.url.trim_end_matches('/')),
        folder(c),
    ] {
        create_directory(&http, s, path).await?;
    }
    // Publish the extension first. Replaying either file after a partial upload
    // is idempotent; no baseline is committed until both writes succeed.
    if let Some(extension) = state.linked.as_ref() {
        if !linked.records.is_empty() || !extension.doc.fields.is_empty() {
            let root = format!("{}linked-folders-v1/", folder(c));
            create_directory(&http, s, root.clone()).await?;
            write_doc(&http, c, s, &extension.doc, &linked, root).await?;
        }
    } else if !linked.records.is_empty() {
        return Err("关联收藏夹同步状态缺失".into());
    }
    write_doc(&http, c, s, &state.doc, &main, folder(c)).await?;
    Ok(true)
}
async fn create_directory(http: &reqwest::Client, s: &Secret, path: String) -> Result<(), String> {
    let r = request(http, "MKCOL", path, s)
        .body("")
        .send()
        .await
        .map_err(|_| "坚果云目录创建失败")?;
    if !matches!(r.status().as_u16(), 201 | 405) {
        check(r.status())?;
    }
    Ok(())
}
async fn write_doc(
    http: &reqwest::Client,
    c: &Config,
    s: &Secret,
    previous: &Doc,
    snapshot: &Snapshot,
    root: String,
) -> Result<(), String> {
    let mut doc = previous.clone();
    doc.update(&c.device_id, snapshot)?;
    let payload = serde_json::to_vec(&doc).map_err(|_| "坚果云快照编码失败")?;
    if payload.len() > MAX_DOC_BYTES {
        return Err("坚果云设备快照超过12MB，请清理旧设备或导出重建同步库".into());
    }
    check(put_snapshot(http, format!("{}{}.json", root, c.device_id), s, payload).await?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct MemoryDav {
        directories: BTreeSet<String>,
        files: BTreeMap<String, Vec<u8>>,
        fail_main_once: bool,
    }
    async fn memory_dav() -> (
        String,
        std::sync::Arc<std::sync::Mutex<MemoryDav>>,
        tokio::task::JoinHandle<()>,
    ) {
        use axum::{extract::State, http::StatusCode, response::IntoResponse};
        let memory = std::sync::Arc::new(std::sync::Mutex::new(MemoryDav::default()));
        memory.lock().unwrap().directories.insert("/dav/".into());
        let app = axum::Router::new()
            .fallback(
                |State(memory): State<std::sync::Arc<std::sync::Mutex<MemoryDav>>>,
                 request: axum::extract::Request| async move {
                    let method = request.method().as_str().to_owned();
                    let path = request.uri().path().to_owned();
                    let body = axum::body::to_bytes(request.into_body(), MAX_DOC_BYTES)
                        .await
                        .unwrap();
                    let mut m = memory.lock().unwrap();
                    match method.as_str() {
                        "PROPFIND" if m.directories.contains(&path) => {
                            let hrefs = m
                                .files
                                .keys()
                                .chain(m.directories.iter())
                                .filter(|value| {
                                    value.starts_with(&path)
                                        && !value[path.len()..].trim_end_matches('/').contains('/')
                                })
                                .map(|value| {
                                    format!("<d:response><d:href>{value}</d:href></d:response>")
                                })
                                .collect::<String>();
                            (
                                StatusCode::MULTI_STATUS,
                                format!("<d:multistatus xmlns:d=\"DAV:\">{hrefs}</d:multistatus>"),
                            )
                                .into_response()
                        }
                        "MKCOL" => {
                            let existed = !m.directories.insert(path);
                            (if existed {
                                StatusCode::METHOD_NOT_ALLOWED
                            } else {
                                StatusCode::CREATED
                            })
                            .into_response()
                        }
                        "PUT" => {
                            if m.fail_main_once && !path.contains("linked-folders-v1") {
                                m.fail_main_once = false;
                                return StatusCode::SERVICE_UNAVAILABLE.into_response();
                            }
                            m.files.insert(path, body.to_vec());
                            StatusCode::CREATED.into_response()
                        }
                        "GET" => m
                            .files
                            .get(&path)
                            .cloned()
                            .map(|body| (StatusCode::OK, body).into_response())
                            .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response()),
                        _ => StatusCode::NOT_FOUND.into_response(),
                    }
                },
            )
            .with_state(memory.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/dav/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, memory, task)
    }
    fn linked_snapshot(id: i64, name: &str) -> Snapshot {
        let mut snapshot = Snapshot::empty("42");
        snapshot.records.insert(
            format!("linkedFolder:{id}"),
            Record {
                kind: "linkedFolder".into(),
                fields: serde_json::from_value(json!({"folderId":id,"name":name})).unwrap(),
            },
        );
        snapshot
    }
    #[tokio::test]
    async fn linked_vault_merges_offline_devices_unlinks_and_keeps_legacy_files_unchanged() {
        let (url, memory, server) = memory_dav().await;
        let secret = Secret {
            username: "test".into(),
            password: "test".into(),
        };
        let a = Config {
            url,
            uid: "42".into(),
            device_id: uuid::Uuid::new_v4().to_string(),
            ..Config::default()
        };
        let b = Config {
            device_id: uuid::Uuid::new_v4().to_string(),
            ..a.clone()
        };
        let a0 = read(&a, &secret).await.unwrap();
        let b0 = read(&b, &secret).await.unwrap();
        write(&a, &secret, &a0, &linked_snapshot(1, "设备A"))
            .await
            .unwrap();
        write(&b, &secret, &b0, &linked_snapshot(2, "设备B"))
            .await
            .unwrap();
        let combined = read(&a, &secret).await.unwrap();
        assert_eq!(combined.snapshot.linked_folders().records.len(), 2);
        assert!(combined.conflicts.is_empty());
        // Legacy clients read only account-root UUID files. They never encounter
        // a new record kind, and their writes cannot delete extension records.
        let legacy = read_vault(&a, &secret, false).await.unwrap();
        assert!(legacy.snapshot.records.is_empty());
        for (path, bytes) in &memory.lock().unwrap().files {
            if !path.contains("linked-folders-v1") {
                assert!(!String::from_utf8_lossy(bytes).contains("linkedFolder"));
            }
        }
        let mut removed = combined.snapshot.clone();
        removed.records.remove("linkedFolder:1");
        write(&a, &secret, &combined, &removed).await.unwrap();
        // B was offline during A's unlink; publishing its unchanged older view
        // must acknowledge, rather than resurrect, A's previous entry.
        write(&b, &secret, &combined, &combined.snapshot)
            .await
            .unwrap();
        let after = read(&b, &secret).await.unwrap();
        assert!(!after.snapshot.records.contains_key("linkedFolder:1"));
        assert!(after.snapshot.records.contains_key("linkedFolder:2"));
        write(&b, &secret, &after, &after.snapshot).await.unwrap();
        assert_eq!(read(&a, &secret).await.unwrap().snapshot, after.snapshot);
        // A partial dual-file upload can safely be retried without losing links.
        let mut added = after.snapshot.clone();
        added.records.extend(linked_snapshot(3, "可重试").records);
        memory.lock().unwrap().fail_main_once = true;
        assert!(write(&a, &secret, &after, &added).await.is_err());
        write(&a, &secret, &after, &added).await.unwrap();
        assert_eq!(read(&a, &secret).await.unwrap().snapshot, added);
        server.abort();
    }
    async fn put_server(
        attempts: usize,
        status: Option<u16>,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/device.json", listener.local_addr().unwrap());
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = bodies.clone();
        let task = tokio::spawn(async move {
            for attempt in 0..attempts {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = Vec::new();
                let mut chunk = [0; 8192];
                let (header_end, length) = loop {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    data.extend_from_slice(&chunk[..count]);
                    if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = std::str::from_utf8(&data[..end]).unwrap();
                        assert!(header.starts_with("PUT /device.json HTTP/1.1"));
                        let length = header
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while data.len() < header_end + length {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    data.extend_from_slice(&chunk[..count]);
                }
                captured
                    .lock()
                    .unwrap()
                    .push(data[header_end..header_end + length].to_vec());
                if attempt + 1 == attempts {
                    if let Some(status) = status {
                        socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    }
                }
                // A complete upload can commit before the response connection drops.
                socket.shutdown().await.unwrap();
            }
        });
        (url, bodies, task)
    }

    #[tokio::test]
    async fn first_upload_replays_identical_snapshot_after_a_lost_response() {
        let (url, bodies, server) = put_server(2, Some(201)).await;
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let credentials = Secret {
            username: "test".into(),
            password: "test".into(),
        };
        let payload = vec![b'x'; 512 * 1024];
        let result = put_snapshot(&http, url, &credentials, payload.clone())
            .await
            .unwrap();
        assert_eq!(result.as_u16(), 201);
        server.await.unwrap();
        assert_eq!(*bodies.lock().unwrap(), vec![payload.clone(), payload]);
    }

    #[tokio::test]
    async fn upload_does_not_retry_http_denials_and_bounds_transport_retries() {
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let credentials = Secret {
            username: "test".into(),
            password: "private-test-password".into(),
        };
        for status in [401, 403, 429, 500] {
            let (url, bodies, server) = put_server(1, Some(status)).await;
            let response = put_snapshot(&http, url, &credentials, b"test".to_vec())
                .await
                .unwrap();
            assert_eq!(response.as_u16(), status);
            server.await.unwrap();
            assert_eq!(bodies.lock().unwrap().len(), 1);
        }
        let (url, bodies, server) = put_server(2, None).await;
        let error = put_snapshot(&http, url, &credentials, b"test".to_vec())
            .await
            .err()
            .unwrap();
        server.await.unwrap();
        assert_eq!(bodies.lock().unwrap().len(), 2);
        assert!(error.contains("连接中断"));
        assert!(!error.contains("授权失效"));
        assert!(!error.contains("private-test-password"));
        assert!(!error.contains("http://"));
    }

    #[test]
    fn permission_denial_is_not_reported_as_expired_credentials() {
        let unauthorized = check(reqwest::StatusCode::UNAUTHORIZED).unwrap_err();
        let forbidden = check(reqwest::StatusCode::FORBIDDEN).unwrap_err();
        assert!(unauthorized.contains("授权失效"));
        assert!(unauthorized.contains("401"));
        assert!(forbidden.contains("403"));
        assert!(!forbidden.contains("授权失效"));
    }
    #[tokio::test]
    async fn first_connect_handles_missing_parents_without_writing_or_hiding_errors() {
        for (vault_status, error, base_status, succeeds, requests) in [
            (409, "AncestorsNotFound", 207, true, 2),
            (404, "NotFound", 207, true, 2),
            (409, "Conflict", 207, false, 1),
            (409, "AncestorsNotFound", 404, false, 2),
            (409, "AncestorsNotFound", 401, false, 2),
        ] {
            let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let captured = calls.clone();
            let router = axum::Router::new().fallback(move |req: axum::extract::Request| {
                let calls = captured.clone();
                async move {
                    calls.lock().unwrap().push((req.method().to_string(), req.uri().path().to_string()));
                    let status = if req.uri().path() == "/dav/" { base_status } else { vault_status };
                    (reqwest::StatusCode::from_u16(status).unwrap(), format!("<d:error xmlns:d=\"DAV:\" xmlns:s=\"http://ns.jianguoyun.com\"><s:exception>{error}</s:exception></d:error>"))
                }
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let mut config = Config::default();
            config.uid = "42".into();
            config.url = format!("http://{addr}/dav/");
            let result = read(
                &config,
                &Secret {
                    username: "test".into(),
                    password: "test".into(),
                },
            )
            .await;
            server.abort();
            assert_eq!(
                result.is_ok(),
                succeeds,
                "{vault_status}/{error}/{base_status}"
            );
            if let Ok(remote) = result {
                assert!(remote.snapshot.records.is_empty());
            }
            let calls = calls.lock().unwrap();
            assert_eq!(calls.len(), requests);
            assert!(
                calls.iter().all(|(method, _)| method == "PROPFIND"),
                "connection preview must not write"
            );
        }
    }
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
    #[ignore = "requires explicitly supplied WebDAV test credentials; read-only"]
    async fn live_nutstore_first_connection_is_read_only() {
        let mut config = Config::default();
        config.url = std::env::var("SYNC_TEST_ROOT").expect("WebDAV base directory");
        config.uid = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        let credentials = Secret {
            username: std::env::var("SYNC_TEST_USERNAME").expect("test username"),
            password: std::env::var("SYNC_TEST_PASSWORD").expect("application password"),
        };
        let remote = read(&config, &credentials)
            .await
            .expect("first connection preview");
        assert!(remote.snapshot.records.is_empty());
        assert!(remote.version.is_none());
    }
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
