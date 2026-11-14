use super::{
    Database, Outcome, SyncState, config,
    scheduler::{self, Domain, Hint, Saved},
    statistics, traffic,
};
use rusqlite::OptionalExtension;
use tauri::{AppHandle, State};

fn context_key(db: &Database, c: &rusqlite::Connection) -> Result<String, String> {
    let value: Option<String> = c
        .query_row("SELECT json FROM sync_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let cfg: super::Config =
        serde_json::from_str(&value.ok_or("尚未连接同步服务")?).map_err(|_| "同步设置损坏")?;
    super::active(db, &cfg.uid)?;
    scope_key(c, &cfg)
}
pub(super) fn scope_key(c: &rusqlite::Connection, cfg: &super::Config) -> Result<String, String> {
    let target: Option<String> = c
        .query_row(
            "SELECT value FROM sync_info WHERE key='scheduler_binding'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    super::storage::target_key(
        &cfg.provider,
        &cfg.uid,
        &cfg.url,
        target.as_deref().unwrap_or(&cfg.device_id),
    )
}

fn context(db: &Database, state: &SyncState) -> Result<String, String> {
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    let scope = context_key(db, &c)?;
    let saved: Option<String> = c
        .query_row(
            "SELECT json FROM sync_scheduler WHERE target=?1",
            [&scope],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    drop(c);
    let mut runtime = state.scheduler.lock().map_err(|_| "同步调度正忙")?;
    runtime.restore(
        &scope,
        saved
            .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
            .unwrap_or_default(),
        scheduler::now(),
        scheduler::wall(),
    );
    Ok(scope)
}

pub async fn run<T>(
    db: &Database,
    state: &SyncState,
    domain: Domain,
    automatic: bool,
    future: impl std::future::Future<Output = Result<T, String>>,
    inspect: impl FnOnce(&T) -> (bool, bool),
) -> Result<Option<T>, String> {
    // One network exchange per installation; no SQLite/account lock is held during IO.
    let _gate = if automatic {
        let Ok(gate) = state.exchange_gate.try_lock() else {
            return Ok(None);
        };
        gate
    } else {
        state.exchange_gate.lock().await
    };
    let scope = context(db, state)?;
    {
        let mut runtime = state.scheduler.lock().map_err(|_| "同步调度正忙")?;
        if automatic && !runtime.due(domain, scheduler::now()) {
            return Ok(None);
        }
        if !runtime.manual_allowed(scheduler::now()) {
            return Err("同步服务正在限流，请稍后重试".into());
        }
        runtime.start(domain, scheduler::now());
    }
    let (result, usage) = traffic::capture(future).await;
    let (changed, conflict) = result.as_ref().map(inspect).unwrap_or((false, false));
    // Account/connection replacement invalidates the completion. Never write the new profile.
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    if context_key(db, &c).ok().as_deref() == Some(&scope) {
        let saved = {
            let mut runtime = state.scheduler.lock().map_err(|_| "同步调度正忙")?;
            if runtime.scope() != scope {
                return result.map(Some);
            }
            runtime.finish(
                domain,
                scheduler::now(),
                changed,
                result.is_err(),
                conflict || (result.is_err() && usage.unauthorized),
                usage.retry_after_ms,
                uuid::Uuid::new_v4().as_u128() as u64,
            );
            runtime.save(scheduler::now(), scheduler::wall())
        };
        let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
        traffic::persist(&c, &scope, domain.name(), &usage)?;
        c.execute("INSERT INTO sync_scheduler(target,json) VALUES(?1,?2) ON CONFLICT(target) DO UPDATE SET json=excluded.json",rusqlite::params![scope,serde_json::to_string(&saved).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    result.map(Some)
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    library: Option<Outcome>,
    library_error: Option<String>,
    statistics: bool,
    statistics_error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    domain: String,
    requests: u64,
    uploaded_bytes: u64,
    downloaded_bytes: u64,
    cache_hits: u64,
    failed_requests: u64,
}

/// Rolling 30-day payload estimates, including unsuccessful exchanges.
#[tauri::command]
pub fn sync_diagnostics(database: State<'_, Database>) -> Result<Vec<Diagnostic>, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    let scope = context_key(&database, &c)?;
    let mut q=c.prepare("SELECT domain,SUM(requests),SUM(uploaded),SUM(downloaded),SUM(cache_hits),SUM(failed) FROM sync_traffic WHERE target=?1 AND day>=date('now','-29 days') GROUP BY domain").map_err(|e|e.to_string())?;
    q.query_map([scope], |r| {
        Ok(Diagnostic {
            domain: r.get(0)?,
            requests: r.get(1)?,
            uploaded_bytes: r.get(2)?,
            downloaded_bytes: r.get(3)?,
            cache_hits: r.get(4)?,
            failed_requests: r.get(5)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_background(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
    hint: Hint,
) -> Result<Report, String> {
    let cfg = config(&database)?;
    if cfg.uid.is_empty() || super::active(&database, &cfg.uid).is_err() {
        return Ok(Report::default());
    }
    context(&database, &state)?;
    state
        .scheduler
        .lock()
        .map_err(|_| "同步调度正忙")?
        .hint(hint, scheduler::now());
    let mut report = Report::default();
    if cfg.enabled {
        match super::sync_now(
            app.clone(),
            database.clone(),
            state.clone(),
            None,
            Some(false),
            Some(true),
        )
        .await
        {
            Ok(outcome) if !outcome.skipped => report.library = Some(outcome),
            Err(e) => report.library_error = Some(e),
            _ => {}
        }
    }
    // Library conflicts and pause never disable independent account statistics.
    match statistics::listening_sync(app, database, state, Some(true)).await {
        Ok(synced) => report.statistics = synced,
        Err(e) => report.statistics_error = Some(e),
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Database, SyncState) {
        let dir = std::env::temp_dir().join(format!("sync-schedule-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("active-profile"), "42").unwrap();
        let c = rusqlite::Connection::open_in_memory().unwrap();
        super::super::storage::init(&c).unwrap();
        let cfg = super::super::Config {
            uid: "42".into(),
            enabled: true,
            initialized: true,
            ..Default::default()
        };
        c.execute(
            "INSERT INTO sync_settings VALUES(1,?1)",
            [serde_json::to_string(&cfg).unwrap()],
        )
        .unwrap();
        (
            Database(std::sync::Mutex::new(c), dir),
            SyncState::default(),
        )
    }
    #[tokio::test]
    async fn conflicts_block_only_library_and_failed_attempts_are_persisted() {
        let (db, state) = fixture();
        let value = run(
            &db,
            &state,
            Domain::Library,
            true,
            async {
                traffic::bridge_started(100);
                traffic::downloaded(7);
                Ok(true)
            },
            |_| (false, true),
        )
        .await
        .unwrap();
        assert_eq!(value, Some(true));
        assert!(
            run(
                &db,
                &state,
                Domain::Library,
                true,
                async {
                    panic!("blocked library started IO");
                    #[allow(unreachable_code)]
                    Ok(())
                },
                |_| (false, false)
            )
            .await
            .unwrap()
            .is_none()
        );
        assert!(
            run(
                &db,
                &state,
                Domain::Statistics,
                true,
                async { Ok(()) },
                |_| (false, false)
            )
            .await
            .unwrap()
            .is_some()
        );
        let c = db.0.lock().unwrap();
        assert_eq!(
            c.query_row("SELECT SUM(uploaded) FROM sync_traffic", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            100
        );
        assert_eq!(
            c.query_row("SELECT SUM(downloaded) FROM sync_traffic", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            7
        );
        drop(c);
        std::fs::remove_dir_all(db.1).unwrap();
    }
    #[tokio::test]
    async fn server_limit_survives_restart_and_still_gates_manual_work() {
        let (db, state) = fixture();
        assert!(
            run::<()>(
                &db,
                &state,
                Domain::Library,
                true,
                async {
                    traffic::bridge_started(100);
                    traffic::bridge_finished(Some(429));
                    Err("limited".into())
                },
                |_| (false, false)
            )
            .await
            .is_err()
        );
        let restarted = SyncState::default();
        assert!(
            run(
                &db,
                &restarted,
                Domain::Statistics,
                true,
                async {
                    panic!("limited account started IO");
                    #[allow(unreachable_code)]
                    Ok(())
                },
                |_| (false, false)
            )
            .await
            .unwrap()
            .is_none()
        );
        assert!(
            run(
                &db,
                &restarted,
                Domain::Statistics,
                false,
                async { Ok(()) },
                |_| (false, false)
            )
            .await
            .unwrap_err()
            .contains("限流")
        );
        std::fs::remove_dir_all(db.1).unwrap();
    }
    #[tokio::test]
    async fn completion_for_previous_profile_never_writes_new_profile_metadata() {
        let (db, state) = fixture();
        run(
            &db,
            &state,
            Domain::Library,
            true,
            async {
                traffic::bridge_started(100);
                let mut cfg = config(&db)?;
                cfg.uid = "43".into();
                db.0.lock()
                    .unwrap()
                    .execute(
                        "UPDATE sync_settings SET json=?1",
                        [serde_json::to_string(&cfg).unwrap()],
                    )
                    .unwrap();
                std::fs::write(db.1.join("active-profile"), "43").unwrap();
                Ok(())
            },
            |_| (false, false),
        )
        .await
        .unwrap();
        let c = db.0.lock().unwrap();
        for table in ["sync_scheduler", "sync_traffic"] {
            assert_eq!(
                c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, u64>(0))
                    .unwrap(),
                0
            );
        }
        drop(c);
        std::fs::remove_dir_all(db.1).unwrap();
    }
    #[tokio::test]
    async fn first_upgrade_establishing_baseline_target_keeps_its_traffic_and_cadence() {
        let (db, state) = fixture();
        run(
            &db,
            &state,
            Domain::Library,
            true,
            async {
                traffic::bridge_started(100);
                db.0.lock()
                    .unwrap()
                    .execute(
                        "INSERT INTO sync_info VALUES('active_target','newly-bound-target')",
                        [],
                    )
                    .unwrap();
                Ok(())
            },
            |_| (false, false),
        )
        .await
        .unwrap();
        assert!(
            run(
                &db,
                &state,
                Domain::Library,
                true,
                async {
                    panic!("first sync lost its admission state");
                    #[allow(unreachable_code)]
                    Ok(())
                },
                |_| (false, false)
            )
            .await
            .unwrap()
            .is_none()
        );
        assert_eq!(
            db.0.lock()
                .unwrap()
                .query_row("SELECT SUM(uploaded) FROM sync_traffic", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            100
        );
        std::fs::remove_dir_all(db.1).unwrap();
    }
}
