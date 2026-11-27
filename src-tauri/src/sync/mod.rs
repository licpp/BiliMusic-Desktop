pub mod chapters;
pub(crate) mod favorite_order;
mod register_extension;
mod source_titles;
pub mod visibility;
pub(crate) use source_titles::save as cache_source_titles;
pub mod actor;
pub mod background;
mod cache;
pub mod causal;
mod cloud_transport;
pub mod device_policy;
pub mod devices;
mod engine;
pub mod migration;
pub mod model;
pub mod outbox;
mod projection;
pub mod protocol_v2;
pub mod publication;
mod recovery;
pub(crate) mod repair;
pub(crate) mod request_budget;
mod scheduler;
#[cfg(test)]
mod simulation;
pub mod statistics;
mod statistics_v2;
pub mod storage;
#[cfg(test)]
mod test_dav;
pub(crate) mod traffic;
mod transport;
pub mod upgrade_merge;
mod v2_net;
use crate::infrastructure::{
    database::Database, providers::bilibili::BilibiliProvider, repositories::auth::AuthRepository,
};
use model::*;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct SyncState {
    scheduler: std::sync::Mutex<scheduler::Scheduler>,
    exchange_gate: tokio::sync::Mutex<()>,
    pub gate: tokio::sync::Mutex<()>,
    pub statistics_gate: tokio::sync::Mutex<()>,
    statistics_active: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
    source_hydration: source_titles::Hydration,
    // Playback only waits for actual account mutations, never sync HTTP requests.
    pub account_gate: tokio::sync::Mutex<()>,
    active: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
}
impl SyncState {
    pub fn interrupt(&self) {
        self.source_hydration.cancel();
        if let Ok(active) = self.statistics_active.lock() {
            if let Some(token) = active.as_ref() {
                token.cancel();
            }
        }
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
    // Kept for older saved configurations; account statistics no longer use this opt-in gate.
    #[serde(default)]
    pub statistics: bool,
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
            statistics: false,
            initialized: false,
            device_id: String::new(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub visibility_error: Option<String>,
    pub import_error: Option<String>,
    pub chapters_error: Option<String>,
    pub favorite_order_error: Option<String>,
    pub local_error: Option<String>,
    pub track_repair: Option<repair::Preview>,
    pub config: Config,
    pub last_success: Option<String>,
    pub records: usize,
    pub bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub skipped: bool,
    pub conflicts: Vec<Conflict>,
    pub visibility_error: Option<String>,
    pub import_error: Option<String>,
    pub chapters_error: Option<String>,
    pub favorite_order_error: Option<String>,
    pub records: usize,
    pub bytes: usize,
    pub changed: bool,
}
impl Outcome {
    fn has_extension_error(&self) -> bool {
        self.import_error.is_some()
            || self.visibility_error.is_some()
            || self.chapters_error.is_some()
            || self.favorite_order_error.is_some()
    }
}
fn config(db: &Database) -> Result<Config, String> {
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    Ok(config_from_connection(&c)?.unwrap_or_default())
}
fn config_from_connection(c: &rusqlite::Connection) -> Result<Option<Config>, String> {
    let s: Option<String> = c
        .query_row("SELECT json FROM sync_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    s.map(|s| serde_json::from_str(&s).map_err(|_| "同步设置损坏".into()))
        .transpose()
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
    #[cfg(target_os = "ios")]
    {
        tauri_plugin_ios_player::secret(app, &key, value, remove)
    }
    #[cfg(target_env = "ohos")]
    {
        tauri_plugin_ohos_player::secret(app, &key, value, remove)
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "android",
        target_os = "ios",
        target_env = "ohos"
    )))]
    {
        let _ = (app, key, value, remove);
        Err("此平台暂不支持安全保存同步凭据".into())
    }
}
#[tauri::command]
pub fn sync_status(database: State<'_, Database>) -> Result<Status, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    let mut cfg = config_from_connection(&c)?.unwrap_or_default();
    // Local import/export remains available even when no cloud connection was made.
    if cfg.uid.is_empty() {
        let uid = std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default();
        if !uid.is_empty() && uid.bytes().all(|c| c.is_ascii_digit()) {
            cfg.uid = uid;
        }
    }
    let last = c
        .query_row(
            "SELECT value FROM sync_info WHERE key='last_success:' || (SELECT value FROM sync_info WHERE key='active_target')",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (snapshot, track_repair, local_error) = if cfg.uid.is_empty() {
        (None, None, None)
    } else {
        match storage::export(&c, &cfg.uid, cfg.history) {
            Ok(snap) => (Some(snap), None, None),
            Err(error) if error.ends_with(model::MISSING_TRACK) => {
                let repair = repair::preview(&c, cfg.history)?;
                let local_error = repair.is_none().then_some(error);
                (None, repair, local_error)
            }
            Err(error) => (None, None, Some(error)),
        }
    };
    Ok(Status {
        visibility_error: sync_area_error(&c, "visibility-error")?,
        import_error: sync_area_error(&c, "import-error")?,
        chapters_error: sync_area_error(&c, "chapters-error")?,
        favorite_order_error: sync_area_error(&c, "favorite-order-error")?,
        local_error,
        config: cfg,
        track_repair,
        last_success: last,
        records: snapshot.as_ref().map_or(0, |s| s.records.len()),
        bytes: snapshot
            .as_ref()
            .map_or(0, |s| serde_json::to_vec(s).unwrap().len()),
    })
}

fn sync_area_error(c: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT json FROM sync_v2_state WHERE target=(SELECT value FROM sync_info WHERE key='active_target') AND key=?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|value| serde_json::from_str::<Option<String>>(&value).map_err(|e| e.to_string()))
    .transpose()
    .map(Option::flatten)
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
    state.interrupt();
    let _exchange = state.exchange_gate.lock().await;
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
        let _account = state.account_gate.lock().await;
        database.switch(Some(uid), Some(&cookie))?;
    }
    active(&database, &settings.uid)?;
    if !matches!(settings.provider.as_str(), "cloud" | "webdav") {
        return Err("无效的同步服务商".into());
    }
    let credentials = if settings.provider == "cloud" {
        let cookie = {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            AuthRepository::get_cookie(&c, "bilibili")
                .map_err(|_| "无法读取登录状态")?
                .ok_or("登录已失效")?
        };
        transport::authenticate(cookie, &settings.uid).await?
    } else {
        transport::validate_nutstore(&settings)?;
        if username.trim().is_empty() || password.is_empty() {
            return Err("请输入坚果云账号和应用密码".into());
        }
        transport::Secret {
            username: username.trim().into(),
            password,
        }
    };
    // Keep the old BiliMusic Cloud baseline associated with its original credentials.
    let previous = config(&database)?;
    if previous.provider == "cloud" {
        let previous_target = secret(&app, &previous, None, false)
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<transport::Secret>(&value).ok())
            .and_then(|value| {
                storage::target_key("cloud", &previous.uid, &previous.url, &value.username).ok()
            })
            .unwrap_or_else(|| "unbound-legacy".into());
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        storage::bind_cloud_baseline(&c, &previous_target)?;
    }
    // Read-only connection test. A new remote will only be created by explicit first sync.
    if settings.provider == "webdav" {
        engine::probe(&settings, &credentials).await?;
    } else {
        cloud_transport::read(&settings, &credentials).await?;
    }
    secret(
        &app,
        &settings,
        Some(&serde_json::to_string(&credentials).unwrap()),
        false,
    )?;
    if uuid::Uuid::parse_str(&settings.device_id).is_err() {
        settings.device_id = uuid::Uuid::new_v4().to_string();
    }
    let target = storage::target_key(
        &settings.provider,
        &settings.uid,
        &settings.url,
        &credentials.username,
    )?;
    database.0.lock().map_err(|_| "数据库正忙")?.execute("INSERT INTO sync_info(key,value) VALUES('active_target',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[&target]).map_err(|e|e.to_string())?;
    database.0.lock().map_err(|_| "数据库正忙")?.execute("INSERT INTO sync_info(key,value) VALUES('scheduler_binding',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[&target]).map_err(|e|e.to_string())?;
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
    c.initialized = false;
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
        if r.kind == "collectionProgress" {
            base.records.insert(k.clone(), r.clone());
            local.records.insert(k.clone(), r.clone());
        } else if r.kind == "history" {
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
pub fn sync_conflict_options(
    database: State<'_, Database>,
) -> Result<engine::ConflictMenu, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    let cfg = config_from_connection(&c)?.ok_or("尚未连接同步服务")?;
    active(&database, &cfg.uid)?;
    let target: String = c
        .query_row(
            "SELECT value FROM sync_info WHERE key='active_target'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "尚未连接同步目标")?;
    engine::get(&c, &target, "conflict-menu")?.ok_or("请先预览同步冲突".into())
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
    let auto = automatic.unwrap_or(false);
    background::run(
        app.try_state::<crate::infrastructure::diagnostics::Diagnostics>()
            .map(|state| state.inner().clone()),
        &database,
        &state,
        scheduler::Domain::Library,
        auto,
        Box::pin(sync_now_inner(
            app.clone(),
            database.clone(),
            state.clone(),
            resolution,
            preview,
            automatic,
        )),
        |outcome| {
            (
                outcome.changed,
                !outcome.conflicts.is_empty(),
                outcome.has_extension_error(),
            )
        },
    )
    .await
    .map(|value| {
        value.unwrap_or(Outcome {
            skipped: true,
            conflicts: vec![],
            visibility_error: None,
            import_error: None,
            chapters_error: None,
            favorite_order_error: None,
            records: 0,
            bytes: 0,
            changed: false,
        })
    })
}
async fn sync_now_inner(
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
    // Nutstore V2 joins automatically; only destructive conflicts require a choice.
    if automatic.unwrap_or(false) && !cfg.initialized && cfg.provider != "webdav" {
        return Err("请先在设置中预览并确认首次合并".into());
    }
    if resolution
        .as_deref()
        .is_some_and(|s| !engine::validate_resolution(s))
    {
        return Err("无效的冲突处理选项".into());
    }
    let credentials: transport::Secret =
        serde_json::from_str(&secret(&app, &cfg, None, false)?.ok_or("请重新连接同步服务")?)
            .map_err(|_| "凭据无效，请重新连接")?;
    let target = storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &credentials.username)?;
    if cfg.provider == "webdav" {
        return tokio::select! {_ = cancellation.cancelled()=>Err("同步已取消".into()), result=async{
            let outcome=engine::sync(&database,&cfg,&credentials,resolution.as_deref(),preview.unwrap_or(false)).await?;
            if !preview.unwrap_or(false)&&outcome.conflicts.is_empty(){let updated=config(&database)?;let _=devices::after_sync(&database,&updated,&credentials).await;}
            Ok(outcome)
        }=>result};
    }
    if cfg.provider != "cloud" {
        return Err("未知的同步服务".into());
    }
    let (initial, base) = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        storage::bind_cloud_baseline(&c, &target)?;
        let current = storage::export(&c, &cfg.uid, cfg.history)?;
        let base = c
            .query_row(
                "SELECT json FROM sync_target_base WHERE target=?1",
                [&target],
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
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err("同步已取消".into()),
            response = cloud_transport::read(&cfg, &credentials) => response,
        };
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
        let mut initial = initial.clone();
        let mut baseline = base.clone();
        initial.omit_linked_folders();
        baseline.omit_linked_folders();
        initial.omit_followed_season_progress();
        baseline.omit_followed_season_progress();
        if remote.legacy_cloud {
            initial.use_legacy_cloud_format();
            baseline.use_legacy_cloud_format();
        }
        if !remote.track_positions {
            initial.omit_track_positions();
            baseline.omit_track_positions();
        }
        if !remote.creators {
            initial.omit_creators();
            baseline.omit_creators();
        }
        if !remote.creator_groups {
            initial.omit_folder_scopes();
            baseline.omit_folder_scopes();
        }
        let initial_with_full_bias = initial.clone();
        if !remote.wide_lyric_bias {
            cloud_transport::project_lyric_bias(&mut initial);
            cloud_transport::project_lyric_bias(&mut baseline);
        }
        let mut local = initial.clone();
        if !cfg.history {
            preserve_history(&mut baseline, &mut local, &remote.snapshot);
        }
        let (mut merged, conflicts) =
            merge(&baseline, &local, &remote.snapshot, resolution.as_deref());
        merged.compact(true);
        merged.restore_missing_tracks();
        merged.validate(&cfg.uid)?;
        let bytes = serde_json::to_vec(&merged).unwrap().len();
        let count = merged.records.len();
        if preview.unwrap_or(false) || (!conflicts.is_empty() && resolution.is_none()) {
            return Ok(Outcome {
                skipped: false,
                conflicts,
                visibility_error: None,
                import_error: None,
                chapters_error: None,
                favorite_order_error: None,
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
                [serde_json::to_string(&initial_with_full_bias).unwrap()],
            )
            .map_err(|e| e.to_string())?;
        }
        if merged != remote.snapshot || remote.version.is_none() {
            let written = tokio::select! {
                _ = cancellation.cancelled() => return Err("同步已取消".into()),
                result = cloud_transport::write(&cfg, &credentials, &remote, &merged) => result,
            }?;
            if !written {
                continue;
            }
        }
        active(&database, &cfg.uid)?;
        if cancellation.is_cancelled() {
            return Err("同步已取消".into());
        }
        let changed = {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            let mut current = storage::export(&c, &cfg.uid, cfg.history)?;
            let local_linked = current.linked_folders();
            current.omit_linked_folders();
            current.omit_followed_season_progress();
            if remote.legacy_cloud {
                current.use_legacy_cloud_format();
            }
            if !remote.track_positions {
                current.omit_track_positions();
            }
            let local_scopes: Vec<_> = current
                .records
                .iter()
                .filter(|(_, r)| r.kind == "collectionFolder")
                .filter_map(|(k, r)| r.fields.get("scope").map(|v| (k.clone(), v.clone())))
                .collect();
            if !remote.creator_groups {
                current.omit_folder_scopes();
            }
            let local_creators: Vec<_> = current
                .records
                .iter()
                .filter(|(_, r)| {
                    (r.kind == "collection" && text(r, "bvid").starts_with("up:"))
                        || (r.kind == "collectionProgress"
                            && text(r, "reference").starts_with("up:"))
                })
                .map(|(k, r)| (k.clone(), r.clone()))
                .collect();
            if !remote.creators {
                current.omit_creators();
            }
            // Rebase edits made while network IO was in flight. Never overwrite a new local edit.
            let mut merged_for_device = merged.clone();
            if !remote.wide_lyric_bias {
                cloud_transport::restore_local_lyric_bias(
                    &mut merged_for_device,
                    &initial_with_full_bias,
                );
            }
            let (mut final_local, post_conflicts) = merge(
                &initial_with_full_bias, &current, &merged_for_device, Some("local"),
            );
            final_local.records.extend(local_linked.records);
            if !remote.creators {
                final_local.records.extend(local_creators);
            }
            if !remote.creator_groups {
                for (k, scope) in local_scopes {
                    if let Some(r) = final_local.records.get_mut(&k) {
                        r.fields.insert("scope".into(), scope);
                    }
                }
            }
            final_local.compact(true);
            let inferred = final_local.restore_missing_tracks();
            if !post_conflicts.is_empty() {
                return Err("同步期间本机数据发生冲突，已保留本机修改，请再次同步".into());
            }
            let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
            storage::apply_with_inferred_tracks(&c, &final_local, cfg.history, &inferred)?;
            c.execute("INSERT INTO sync_target_base(target,json) VALUES(?1,?2) ON CONFLICT(target) DO UPDATE SET json=excluded.json",params![target,serde_json::to_string(&merged).unwrap()]).map_err(|e|e.to_string())?;
            c.execute("INSERT INTO sync_info(key,value) VALUES(?1,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[format!("last_success:{target}")]).map_err(|e|e.to_string())?;
            c.execute("INSERT INTO sync_info(key,value) VALUES('active_target',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[&target]).map_err(|e|e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            initial_with_full_bias != final_local
        };
        cfg.initialized = true;
        save(&database, &cfg)?;
        return Ok(Outcome {
            skipped: false,
            conflicts: vec![],
            visibility_error: None,
            import_error: None,
            chapters_error: None,
            favorite_order_error: None,
            records: count,
            bytes,
            changed,
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
    crate::infrastructure::migrations::migrate(&guest).map_err(|e| e.to_string())?;
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
    expected_account_session: String,
    track_ids: Option<Vec<String>>,
    title_ids: Option<Vec<String>>,
) -> Result<usize, String> {
    state
        .source_hydration
        .run(&database, &expected_account_session, async {
            match title_ids {
                Some(ids) => {
                    source_titles::hydrate_titles(
                        &database,
                        &provider,
                        &expected_account_session,
                        ids,
                    )
                    .await
                }
                None => {
                    source_titles::hydrate_placeholders(
                        &database,
                        &provider,
                        &expected_account_session,
                        track_ids,
                    )
                    .await
                }
            }
        })
        .await
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
    state.interrupt();
    let _gate = state.gate.lock().await;
    let _statistics = state.statistics_gate.lock().await;
    let mut cfg = config(&database)?;
    active(&database, &cfg.uid)?;
    if cfg.provider != "cloud" {
        return Err("坚果云数据请在专用目录自行管理".into());
    }
    let credentials: transport::Secret =
        serde_json::from_str(&secret(&app, &cfg, None, false)?.ok_or("请先连接BiliMusic云")?)
            .map_err(|_| "凭据无效")?;
    transport::cloud_delete(&credentials, "vault").await?;
    statistics::pause_account_sync(&database, &cfg.uid, true)?;
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

#[cfg(test)]
mod playback_gate_tests {
    #[tokio::test]
    async fn slow_sync_does_not_lock_playback_account_access() {
        let state = super::SyncState::default();
        let _sync = state.gate.lock().await;
        let account = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            state.account_gate.lock(),
        )
        .await
        .unwrap();
        assert!(state.account_gate.try_lock().is_err());
        drop(account);
        assert!(state.account_gate.try_lock().is_ok());
    }
}

pub mod import_entries;
