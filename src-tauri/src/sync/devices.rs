use super::{
    Config, Database, SyncState, config,
    device_policy::{Device, Status},
    transport::Secret,
    v2_net::Client,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, State};

#[derive(Clone, Debug)]
pub struct Observation {
    pub writer: String,
    pub source: String,
    pub hash: String,
    pub has_data: bool,
    pub modified: Option<u64>,
    pub server_time: Option<u64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capability {
    schema: u32,
    uid: String,
    writer: String,
    name: String,
    platform: String,
    ready: bool,
    has_data: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retirement {
    schema: u32,
    uid: String,
    writer: String,
    retired: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    #[serde(flatten)]
    device: Device,
    status: Status,
    current: bool,
}

fn root(cfg: &Config) -> Result<String, String> {
    Ok(format!(
        "sync-v2/{}/",
        super::migration::Genesis::for_config(cfg)?.vault
    ))
}
pub fn init(c: &rusqlite::Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS sync_devices(target TEXT NOT NULL,writer TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(target,writer));
    CREATE TABLE IF NOT EXISTS sync_device_meta(target TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(target,key));").map_err(|e|e.to_string())
}
fn meta(c: &rusqlite::Connection, target: &str, key: &str) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT value FROM sync_device_meta WHERE target=?1 AND key=?2",
        params![target, key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}
fn put_meta(c: &rusqlite::Connection, target: &str, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO sync_device_meta VALUES(?1,?2,?3) ON CONFLICT(target,key) DO UPDATE SET value=excluded.value",params![target,key,value]).map_err(|e|e.to_string())?;
    Ok(())
}
fn load(c: &rusqlite::Connection, target: &str, id: &str) -> Result<Device, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT json FROM sync_devices WHERE target=?1 AND writer=?2",
            params![target, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| "设备记录损坏".into()))
        .unwrap_or_else(|| {
            Ok(Device {
                id: id.into(),
                name: "尚未更新的设备".into(),
                platform: "unknown".into(),
                ready: false,
                has_data: false,
                retired: false,
                last_activity: None,
                sources: BTreeMap::new(),
            })
        })
}
fn save(c: &rusqlite::Connection, target: &str, d: &Device) -> Result<(), String> {
    c.execute("INSERT INTO sync_devices VALUES(?1,?2,?3) ON CONFLICT(target,writer) DO UPDATE SET json=excluded.json",params![target,d.id,serde_json::to_string(d).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn observe(
    c: &rusqlite::Connection,
    target: &str,
    observations: &[Observation],
) -> Result<(), String> {
    init(c)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    for o in observations {
        let mut d = load(c, target, &o.writer)?;
        let changed = d.sources.get(&o.source) != Some(&o.hash);
        d.sources.insert(o.source.clone(), o.hash.clone());
        d.has_data |= o.has_data;
        if let Some(server) = o.server_time {
            put_meta(c, target, "server_time", &server.to_string())?;
            if changed {
                let time = o.modified.filter(|t| *t <= server).unwrap_or(server);
                d.last_activity = Some(d.last_activity.unwrap_or(0).max(time));
            }
        }
        save(c, target, &d)?;
    }
    tx.commit().map_err(|e| e.to_string())
}
pub fn list(c: &rusqlite::Connection, target: &str, current: &str) -> Result<Vec<Row>, String> {
    let now = meta(c, target, "server_time")?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut q = c
        .prepare("SELECT json FROM sync_devices WHERE target=?1 ORDER BY writer")
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for raw in q
        .query_map([target], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        let d: Device =
            serde_json::from_str(&raw.map_err(|e| e.to_string())?).map_err(|_| "设备记录损坏")?;
        result.push(Row {
            status: d.status(now),
            current: d.id == current,
            device: d,
        });
    }
    result.sort_by_key(|d| (!d.current, d.device.retired, d.device.id.clone()));
    Ok(result)
}
pub async fn refresh(db: &Database, cfg: &Config, secret: &Secret) -> Result<(), String> {
    let target = super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    let root = root(&cfg)?;
    let net = Client::new(cfg, secret)?;
    let (caps, server_time) = net.list(&format!("{root}devices/")).await?;
    let (retired, _) = net.list(&format!("{root}retirements/")).await?;
    for name in caps {
        let Some(id) = name
            .strip_suffix(".json")
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        else {
            continue;
        };
        let Some(obj) = net.get(&format!("{root}devices/{name}")).await? else {
            return Err("设备清单正在变化，请重试".into());
        };
        let cap: Capability = serde_json::from_slice(&obj.body).map_err(|_| "设备能力记录无效")?;
        if cap.schema != 1
            || cap.uid != cfg.uid
            || cap.writer != id
            || cap.name.chars().count() > 80
            || cap.platform.len() > 32
        {
            return Err("设备能力身份无效".into());
        }
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        super::active(db, &cfg.uid)?;
        init(&c)?;
        let mut d = load(&c, &target, id)?;
        d.name = cap.name;
        d.platform = cap.platform;
        d.ready = cap.ready;
        d.has_data |= cap.has_data;
        if let Some(time) = obj.modified {
            d.last_activity = Some(d.last_activity.unwrap_or(0).max(time));
        }
        save(&c, &target, &d)?;
    }
    for name in retired {
        let Some(id) = name
            .strip_suffix(".json")
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        else {
            continue;
        };
        let Some(obj) = net.get(&format!("{root}retirements/{name}")).await? else {
            return Err("停用设备记录暂不可用".into());
        };
        let r: Retirement = serde_json::from_slice(&obj.body).map_err(|_| "停用设备记录无效")?;
        if r.schema != 1 || r.uid != cfg.uid || r.writer != id || !r.retired {
            return Err("停用设备身份无效".into());
        }
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        super::active(db, &cfg.uid)?;
        init(&c)?;
        let mut d = load(&c, &target, id)?;
        d.retired = true;
        save(&c, &target, &d)?;
    }
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    super::active(db, &cfg.uid)?;
    init(&c)?;
    if let Some(now) = server_time {
        put_meta(&c, &target, "server_time", &now.to_string())?;
    }
    put_meta(
        &c,
        &target,
        "refreshed",
        &super::scheduler::wall().to_string(),
    )
}

/// Low-frequency capability heartbeat; old clients ignore this subdirectory.
pub async fn after_sync(db: &Database, cfg: &Config, secret: &Secret) -> Result<(), String> {
    if cfg.provider != "webdav" {
        return Ok(());
    }
    let target = super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    let root = root(&cfg)?;
    let (heartbeat, refresh_due, has_data) = {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        init(&c)?;
        super::active(db, &cfg.uid)?;
        let now = super::scheduler::wall();
        let age = |key: &str| {
            meta(&c, &target, key)
                .ok()
                .flatten()
                .and_then(|v| v.parse::<u64>().ok())
                .map(|t| now.saturating_sub(t))
        };
        (
            age("heartbeat").is_none_or(|age| age >= 24 * 60 * 60 * 1000),
            age("refreshed").is_none_or(|age| age >= 60 * 60 * 1000),
            !super::storage::export(&c, &cfg.uid, cfg.history)?
                .records
                .is_empty(),
        )
    };
    if heartbeat {
        let net = Client::new(cfg, secret)?;
        for path in [
            "sync-v2/".to_owned(),
            root.clone(),
            format!("{root}devices/"),
            format!("{root}retirements/"),
        ] {
            net.mkdir(&path).await?;
        }
        let cap = Capability {
            schema: 1,
            uid: cfg.uid.clone(),
            writer: cfg.device_id.clone(),
            name: format!("{} 设备", std::env::consts::OS),
            platform: std::env::consts::OS.into(),
            ready: true,
            has_data,
        };
        net.put(
            &format!("{root}devices/{}.json", cfg.device_id),
            serde_json::to_vec(&cap).map_err(|e| e.to_string())?,
        )
        .await?;
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        super::active(db, &cfg.uid)?;
        put_meta(
            &c,
            &target,
            "heartbeat",
            &super::scheduler::wall().to_string(),
        )?;
    }
    if refresh_due || heartbeat {
        refresh(db, cfg, secret).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_devices(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
    refresh: Option<bool>,
) -> Result<Vec<Row>, String> {
    let _gate = state.exchange_gate.lock().await;
    let cfg = config(&database)?;
    if cfg.provider != "webdav" || !cfg.initialized {
        return Ok(vec![]);
    }
    super::active(&database, &cfg.uid)?;
    let secret: Secret =
        serde_json::from_str(&super::secret(&app, &cfg, None, false)?.ok_or("请重新连接坚果云")?)
            .map_err(|_| "同步凭据无效")?;
    if refresh.unwrap_or(false) {
        self::refresh(&database, &cfg, &secret).await?;
    }
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    init(&c)?;
    list(
        &c,
        &super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?,
        &cfg.device_id,
    )
}
#[tauri::command]
pub async fn sync_retire_device(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
    device_id: String,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&device_id).is_err() {
        return Err("设备身份无效".into());
    }
    let _gate = state.exchange_gate.lock().await;
    let cfg = config(&database)?;
    super::active(&database, &cfg.uid)?;
    if cfg.provider != "webdav" || !cfg.initialized || device_id == cfg.device_id {
        return Err("请在另一台已连接设备中停用此设备".into());
    }
    let secret: Secret =
        serde_json::from_str(&super::secret(&app, &cfg, None, false)?.ok_or("请重新连接坚果云")?)
            .map_err(|_| "同步凭据无效")?;
    let target = super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    let root = root(&cfg)?;
    {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        init(&c)?;
        let known: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_devices WHERE target=?1 AND writer=?2)",
                params![target, device_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !known {
            return Err("未找到该设备，请刷新设备列表".into());
        }
    }
    let net = Client::new(&cfg, &secret)?;
    net.mkdir(&root).await?;
    net.mkdir(&format!("{root}retirements/")).await?;
    let record = Retirement {
        schema: 1,
        uid: cfg.uid.clone(),
        writer: device_id.clone(),
        retired: true,
    };
    let path = format!("{root}retirements/{device_id}.json");
    let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
    net.put(&path, bytes.clone()).await?;
    if net.get(&path).await?.is_none_or(|obj| obj.body != bytes) {
        return Err("停用记录尚未确认，请重试".into());
    }
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    super::active(&database, &cfg.uid)?;
    let mut d = load(&c, &target, &device_id)?;
    d.retired = true;
    save(&c, &target, &d)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refreshing_an_unchanged_source_does_not_extend_its_week() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let first = Observation {
            writer: id.clone(),
            source: "legacy".into(),
            hash: "a".repeat(64),
            has_data: true,
            modified: Some(100),
            server_time: Some(101),
        };
        observe(&c, "t", &[first.clone()]).unwrap();
        let mut later = first.clone();
        later.server_time = Some(100 + super::super::device_policy::DORMANT_SECONDS);
        later.modified = None;
        observe(&c, "t", &[later.clone()]).unwrap();
        assert_eq!(list(&c, "t", "").unwrap()[0].status, Status::Dormant);
        let mut d = load(&c, "t", &id).unwrap();
        d.retired = true;
        save(&c, "t", &d).unwrap();
        later.hash = "b".repeat(64);
        observe(&c, "t", &[later]).unwrap();
        assert_eq!(list(&c, "t", "").unwrap()[0].status, Status::Retired);
        assert_eq!(
            load(&c, "t", &id).unwrap().sources["legacy"],
            "b".repeat(64)
        );
    }
    #[tokio::test]
    async fn retirement_reaches_another_installation_without_removing_legacy_files() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let net = Client::new(&cfg, &secret).unwrap();
        let root = root(&cfg).unwrap();
        for path in [
            root.clone(),
            format!("{root}devices/"),
            format!("{root}retirements/"),
        ] {
            net.mkdir(&path).await.unwrap();
        }
        let old = uuid::Uuid::new_v4().to_string();
        let legacy_path = format!("/dav/BiliMusic-sync-v1/42/{old}.json");
        store
            .lock()
            .unwrap()
            .files
            .insert(legacy_path.clone(), (b"preserved".to_vec(), 100));
        let retired = Retirement {
            schema: 1,
            uid: "42".into(),
            writer: old.clone(),
            retired: true,
        };
        net.put(
            &format!("{root}retirements/{old}.json"),
            serde_json::to_vec(&retired).unwrap(),
        )
        .await
        .unwrap();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("active-profile"), "42").unwrap();
        let c = rusqlite::Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        let db = Database(std::sync::Mutex::new(c), dir.clone());
        refresh(&db, &cfg, &secret).await.unwrap();
        let target =
            super::super::storage::target_key("webdav", "42", &cfg.url, &secret.username).unwrap();
        assert!(load(&db.0.lock().unwrap(), &target, &old).unwrap().retired);
        assert_eq!(store.lock().unwrap().files[&legacy_path].0, b"preserved");
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
