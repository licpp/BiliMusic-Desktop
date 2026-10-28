mod dav;
pub mod model;
pub mod storage;
mod transport;
use crate::infrastructure::{
    database::Database, providers::bilibili::BilibiliProvider, repositories::auth::AuthRepository,
};
use model::*;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct SyncState {
    pub gate: tokio::sync::Mutex<()>,
    active: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
}
impl SyncState {
    pub fn interrupt(&self) {
        if let Ok(active) = self.active.lock() {
            if let Some(token) = active.as_ref() {
                token.cancel();
            }
        }
    }
    fn begin(&self) -> tokio_util::sync::CancellationToken {
        let token = tokio_util::sync::CancellationToken::new();
        if let Ok(mut active) = self.active.lock() {
            *active = Some(token.clone());
        }
        token
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub provider: String,
    pub uid: String,
    pub url: String,
    pub history: bool,
    #[serde(default)]
    pub initialized: bool,
    #[serde(default)]
    pub device_id: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "webdav".into(),
            uid: String::new(),
            url: "https://dav.jianguoyun.com/dav/".into(),
            history: false,
            initialized: false,
            device_id: String::new(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub config: Config,
    pub last_success: Option<String>,
    pub records: usize,
    pub bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub conflicts: Vec<Conflict>,
    pub records: usize,
    pub bytes: usize,
    pub changed: bool,
}
fn config(db: &Database) -> Result<Config, String> {
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    let s: Option<String> = c
        .query_row("SELECT json FROM sync_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    s.map(|s| serde_json::from_str(&s).map_err(|_| "同步设置损坏".into()))
        .unwrap_or(Ok(Config::default()))
}
fn save(db: &Database, cfg: &Config) -> Result<(), String> {
    db.0.lock().map_err(|_|"数据库正忙")?.execute("INSERT INTO sync_settings(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",[serde_json::to_string(cfg).unwrap()]).map_err(|e|e.to_string())?;
    Ok(())
}
fn active(db: &Database, uid: &str) -> Result<(), String> {
    if uid.is_empty()
        || std::fs::read_to_string(db.1.join("active-profile")).unwrap_or_default() != uid
    {
        Err("请登录对应的B站账号后再同步".into())
    } else {
        Ok(())
    }
}
fn secret(
    app: &AppHandle,
    c: &Config,
    value: Option<&str>,
    remove: bool,
) -> Result<Option<String>, String> {
    let key = format!("sync-{}-{}", c.uid, c.provider);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let _ = app;
        let entry =
            keyring::Entry::new("app.bilimusic.sync", &key).map_err(|_| "无法访问系统凭据库")?;
        if remove {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => return Ok(None),
                Err(_) => return Err("无法删除同步凭据".into()),
            }
        }
        if let Some(value) = value {
            entry.set_password(value).map_err(|_| "无法保存同步凭据")?;
            return Ok(None);
        }
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("无法读取同步凭据，请重新连接".into()),
        }
    }
    #[cfg(target_os = "android")]
    {
        tauri_plugin_android_player::secret(app, &key, value, remove)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "android")))]
    {
        let _ = (app, key, value, remove);
        Err("此平台暂不支持安全保存同步凭据".into())
    }
}
#[tauri::command]
pub fn sync_status(database: State<'_, Database>) -> Result<Status, String> {
    let mut cfg = config(&database)?;
    // Local import/export remains available even when no cloud connection was made.
    if cfg.uid.is_empty() {
        let uid = std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default();
        if !uid.is_empty() && uid.bytes().all(|c| c.is_ascii_digit()) {
            cfg.uid = uid;
        }
    }
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    let last = c
        .query_row(
            "SELECT value FROM sync_info WHERE key='last_success'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let snap = if cfg.uid.is_empty() {
        Snapshot::empty("0")
    } else {
        storage::export(&c, &cfg.uid, cfg.history)?
    };
    Ok(Status {
        config: cfg,
        last_success: last,
        records: snap.records.len(),
        bytes: serde_json::to_vec(&snap).unwrap().len(),
    })
}
#[tauri::command]
pub async fn sync_connect(
    app: AppHandle,
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    state: State<'_, SyncState>,
    mut settings: Config,
    username: String,
    password: String,
    consent: bool,
) -> Result<Status, String> {
    let _gate = state.gate.lock().await;
    if !consent {
        return Err("请先确认同步范围及服务商授权说明".into());
    }
    let profile = provider
        .account_profile()
        .await
        .map_err(|_| "请先登录B站账号")?;
    let uid = profile
        .user_id
        .filter(|_| profile.logged_in)
        .ok_or("请先登录B站账号")?;
    settings.uid = uid.to_string();
    if std::fs::read_to_string(database.1.join("active-profile"))
        .unwrap_or_default()
        .is_empty()
    {
        let cookie = {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            AuthRepository::get_cookie(&c, "bilibili")
                .map_err(|_| "读取登录状态失败")?
                .ok_or("请重新登录")?
        };
        database.switch(Some(uid), Some(&cookie))?;
    }
    active(&database, &settings.uid)?;
    if !matches!(settings.provider.as_str(), "cloud" | "webdav") {
        return Err("无效的同步服务商".into());
    }
    transport::endpoint(&settings)?;
    let credentials = if settings.provider == "cloud" {
        let cookie = {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            AuthRepository::get_cookie(&c, "bilibili")
                .map_err(|_| "无法读取登录状态")?
                .ok_or("登录已失效")?
        };
        transport::authenticate(cookie, &settings.uid).await?
    } else {
        if username.trim().is_empty() || password.is_empty() {
            return Err("请输入坚果云账号和应用密码".into());
        }
        transport::Secret {
            username: username.trim().into(),
            password,
        }
    };
    // Read-only connection test. A new remote will only be created by explicit first sync.
    transport::read(&settings, &credentials).await?;
    secret(
        &app,
        &settings,
        Some(&serde_json::to_string(&credentials).unwrap()),
        false,
    )?;
    if uuid::Uuid::parse_str(&settings.device_id).is_err() {
        settings.device_id = uuid::Uuid::new_v4().to_string();
    }
    settings.enabled = true;
    settings.initialized = false;
    save(&database, &settings)?;
    sync_status(database)
}
#[tauri::command]
pub async fn sync_pause(
    database: State<'_, Database>,
    state: State<'_, SyncState>,
    paused: bool,
) -> Result<(), String> {
    state.interrupt();
    let _gate = state.gate.lock().await;
    let mut c = config(&database)?;
    if !paused {
        active(&database, &c.uid)?;
    }
    c.enabled = !paused;
    save(&database, &c)
}
#[tauri::command]
pub async fn sync_disconnect(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
) -> Result<(), String> {
    state.interrupt();
    let _gate = state.gate.lock().await;
    let mut c = config(&database)?;
    c.enabled = false;
    save(&database, &c)?;
    let mut revoke_error = None;
    if !c.uid.is_empty() {
        if c.provider == "cloud" {
            if let Some(value) = secret(&app, &c, None, false)? {
                if let Ok(credentials) = serde_json::from_str::<transport::Secret>(&value) {
                    revoke_error = transport::cloud_delete(&credentials, "session").await.err();
                }
            }
        }
        secret(&app, &c, None, true)?;
    }
    if revoke_error.is_some() {
        return Err(
            "已关闭同步并删除本机凭据，但服务器撤销未完成；原设备令牌将在到期后失效".into(),
        );
    }
    Ok(())
}
fn preserve_history(base: &mut Snapshot, local: &mut Snapshot, remote: &Snapshot) {
    for (k, r) in &remote.records {
        if r.kind == "history" {
            base.records.insert(k.clone(), r.clone());
            local.records.insert(k.clone(), r.clone());
            let t = format!("track:{}", text(r, "trackId"));
            if !local.records.contains_key(&t) {
                if let Some(track) = remote.records.get(&t) {
                    base.records.insert(t.clone(), track.clone());
                    local.records.insert(t, track.clone());
                    let lyric_key = format!("lyric:{}", text(r, "trackId"));
                    if let Some(lyric) = remote.records.get(&lyric_key) {
                        base.records.insert(lyric_key.clone(), lyric.clone());
                        local.records.insert(lyric_key, lyric.clone());
                    }
                }
            }
        }
    }
}
#[tauri::command]
pub async fn sync_now(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
    resolution: Option<String>,
    preview: Option<bool>,
    automatic: Option<bool>,
) -> Result<Outcome, String> {
    let _gate = state.gate.lock().await;
    let mut cfg = config(&database)?;
    if !cfg.enabled {
        return Err("云同步已关闭".into());
    }
    active(&database, &cfg.uid)?;
    let cancellation = state.begin();
    if automatic.unwrap_or(false) && !cfg.initialized {
        return Err("请先在设置中预览并确认首次合并".into());
    }
    if resolution
        .as_deref()
        .is_some_and(|s| s != "local" && s != "remote")
    {
        return Err("无效的冲突处理选项".into());
    }
    let credentials: transport::Secret =
        serde_json::from_str(&secret(&app, &cfg, None, false)?.ok_or("请重新连接同步服务")?)
            .map_err(|_| "凭据无效，请重新连接")?;
    let (initial, base) = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        let current = storage::export(&c, &cfg.uid, cfg.history)?;
        let base = c
            .query_row(
                "SELECT json FROM sync_base WHERE provider=?1",
                [&cfg.provider],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .map(|s| serde_json::from_str::<Snapshot>(&s).map_err(|_| "同步基准损坏"))
            .transpose()?
            .unwrap_or_else(|| Snapshot::empty(&cfg.uid));
        (current, base)
    };
    for _ in 0..3 {
        let response = tokio::select! { _=cancellation.cancelled()=>return Err("同步已取消".into()),response=transport::read(&cfg,&credentials)=>response };
        let remote = match response {
            Ok(r) => r,
            Err(e) => {
                if e.contains("授权失效") {
                    cfg.enabled = false;
                    save(&database, &cfg)?;
                }
                return Err(e);
            }
        };
        let mut local = initial.clone();
        let mut baseline = base.clone();
        if !cfg.history {
            preserve_history(&mut baseline, &mut local, &remote.snapshot);
        }
        let effective_remote = if !remote.conflicts.is_empty() && resolution.is_some() {
            remote
                .dav
                .as_ref()
                .ok_or("并发状态缺失")?
                .doc
                .resolved(&initial, resolution.as_deref() == Some("local"))?
        } else {
            remote.snapshot.clone()
        };
        let (mut merged, mut conflicts) =
            merge(&baseline, &local, &effective_remote, resolution.as_deref());
        conflicts.extend(remote.conflicts.clone());
        merged.compact(true);
        merged.validate(&cfg.uid)?;
        let bytes = serde_json::to_vec(&merged).unwrap().len();
        let count = merged.records.len();
        if preview.unwrap_or(false) || (!conflicts.is_empty() && resolution.is_none()) {
            return Ok(Outcome {
                conflicts,
                records: count,
                bytes,
                changed: merged != remote.snapshot,
            });
        }
        // A consistent copy is made before the first upload/merge, never from credentials.
        {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            c.execute(
                "INSERT INTO sync_info(key,value) VALUES('backup',?1) ON CONFLICT(key) DO NOTHING",
                [serde_json::to_string(&initial).unwrap()],
            )
            .map_err(|e| e.to_string())?;
        }
        if merged != remote.snapshot
            || remote.version.is_none()
            || !remote.conflicts.is_empty()
            || remote.dav.as_ref().is_some_and(|d| d.needs_publish)
        {
            let written = tokio::select! { _=cancellation.cancelled()=>return Err("同步已取消".into()),result=transport::write(&cfg,&credentials,&remote,&merged)=>result }?;
            if !written {
                continue;
            }
        }
        active(&database, &cfg.uid)?;
        if cancellation.is_cancelled() {
            return Err("同步已取消".into());
        }
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        let current = storage::export(&c, &cfg.uid, cfg.history)?;
        // Rebase edits made while network IO was in flight. Never overwrite a new local edit.
        let (mut final_local, post_conflicts) = merge(&initial, &current, &merged, Some("local"));
        final_local.compact(true);
        if !post_conflicts.is_empty() {
            return Err("同步期间本机数据发生冲突，已保留本机修改，请再次同步".into());
        }
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        storage::apply(&c, &final_local, cfg.history)?;
        c.execute("INSERT INTO sync_base(provider,json) VALUES(?1,?2) ON CONFLICT(provider) DO UPDATE SET json=excluded.json",params![cfg.provider,serde_json::to_string(&merged).unwrap()]).map_err(|e|e.to_string())?;
        c.execute("INSERT INTO sync_info(key,value) VALUES('last_success',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(c);
        cfg.initialized = true;
        save(&database, &cfg)?;
        return Ok(Outcome {
            conflicts: vec![],
            records: count,
            bytes,
            changed: initial != final_local,
        });
    }
    Err("其它设备正在修改，请稍后重新同步".into())
}
#[tauri::command]
pub async fn sync_import_guest(
    database: State<'_, Database>,
    state: State<'_, SyncState>,
) -> Result<usize, String> {
    let _gate = state.gate.lock().await;
    let uid = std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default();
    active(&database, &uid)?;
    let guest = rusqlite::Connection::open(database.1.join("resonance.sqlite3"))
        .map_err(|_| "无法打开本机访客资料库")?;
    let source = storage::export(&guest, &uid, true)?;
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    let current = storage::export(&c, &uid, true)?;
    let (mut merged, _) = merge(&Snapshot::empty(&uid), &current, &source, Some("local"));
    merged.compact(true);
    storage::apply(&c, &merged, true)?;
    Ok(merged.records.len())
}

#[tauri::command]
pub async fn sync_hydrate_sources(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    state: State<'_, SyncState>,
    track_ids: Option<Vec<String>>,
) -> Result<usize, String> {
    let _gate = state.gate.lock().await;
    let videos: Vec<String> = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        let mut q=c.prepare("SELECT id,bvid FROM source_items WHERE source_title='' OR source_title='B站歌曲（待加载）' ORDER BY bvid LIMIT 5000").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .filter(|(id, _)| track_ids.as_ref().is_none_or(|ids| ids.contains(id)))
            .map(|(_, bvid)| bvid)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .take(10)
            .collect()
    };
    let mut count = 0;
    for bvid in videos {
        if let Ok(video) = provider.video_parts(&bvid).await {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            for part in &video.parts {
                let id = format!("bilibili:{bvid}:{}", part.cid);
                let title = if video.parts.len() > 1 {
                    &part.title
                } else {
                    &video.title
                };
                c.execute("UPDATE source_items SET aid=?2,page=?3,source_title=?4,uploader_id=?5,uploader_name=?6 WHERE id=?1 AND (source_title='' OR source_title='B站歌曲（待加载）')",params![id,video.aid,part.page,title,video.uploader_id,video.uploader_name]).map_err(|e|e.to_string())?;
                count += c.execute("UPDATE tracks SET title=?2,cover_url=?3,duration_seconds=?4 WHERE id=?1 AND title='B站歌曲（待加载）'",params![id,title,part.cover_url,part.duration_seconds]).map_err(|e|e.to_string())?;
            }
        } else {
            break;
        }
    }
    Ok(count)
}

#[tauri::command]
pub fn sync_current_track(
    database: State<'_, Database>,
    track_id: String,
) -> Result<Option<crate::infrastructure::repositories::library::TrackRecord>, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    crate::infrastructure::repositories::library::LibraryRepository::get(&c, &track_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn sync_export(
    database: State<'_, Database>,
    state: State<'_, SyncState>,
) -> Result<String, String> {
    let _gate = state.gate.lock().await;
    let uid = std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default();
    active(&database, &uid)?;
    let snapshot = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        storage::export(&c, &uid, true)?
    };
    let path = database.1.join(format!("sync-backup-{uid}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&snapshot).unwrap())
        .map_err(|_| "无法保存备份")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置备份权限")?;
    }
    Ok(path.to_string_lossy().into())
}
#[tauri::command]
pub async fn sync_delete_cloud(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
) -> Result<(), String> {
    let _gate = state.gate.lock().await;
    let mut cfg = config(&database)?;
    active(&database, &cfg.uid)?;
    if cfg.provider != "cloud" {
        return Err("坚果云数据请在专用目录自行管理".into());
    }
    let credentials: transport::Secret =
        serde_json::from_str(&secret(&app, &cfg, None, false)?.ok_or("请先连接BiliMusic云")?)
            .map_err(|_| "凭据无效")?;
    transport::cloud_delete(&credentials, "vault").await?;
    cfg.enabled = false;
    cfg.initialized = false;
    save(&database, &cfg)?;
    secret(&app, &cfg, None, true)?;
    database
        .0
        .lock()
        .map_err(|_| "数据库正忙")?
        .execute("DELETE FROM sync_base WHERE provider='cloud'", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
