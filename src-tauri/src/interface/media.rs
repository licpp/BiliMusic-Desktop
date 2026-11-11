use super::error::CommandError;
use crate::infrastructure::{database::Database, providers::bilibili::*};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{Manager, State};
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityPreferences {
    pub audio_id: u32,
    pub video_height: u32,
}
pub fn preferences(c: &Connection) -> rusqlite::Result<QualityPreferences> {
    Ok(c.query_row(
        "SELECT audio_id,video_height FROM playback_preferences WHERE id=1",
        [],
        |r| {
            Ok(QualityPreferences {
                audio_id: r.get(0)?,
                video_height: r.get(1)?,
            })
        },
    )
    .optional()?
    .unwrap_or_default())
}
#[tauri::command]
pub fn media_preferences(
    database: State<'_, Database>,
) -> Result<QualityPreferences, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    preferences(&connection).map_err(CommandError::database)
}
#[tauri::command]
pub fn media_set_preferences(
    database: State<'_, Database>,
    audio_id: Option<u32>,
    video_height: Option<u32>,
) -> Result<QualityPreferences, CommandError> {
    if audio_id.is_some_and(|v| v > 40000) || video_height.is_some_and(|v| v > 4320) {
        return Err(CommandError::validation("无效的播放质量"));
    }
    let c = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    let old = preferences(&c).map_err(CommandError::database)?;
    c.execute("INSERT INTO playback_preferences(id,audio_id,video_height) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET audio_id=excluded.audio_id,video_height=excluded.video_height",params![audio_id.unwrap_or(old.audio_id),video_height.unwrap_or(old.video_height)]).map_err(CommandError::database)?;
    preferences(&c).map_err(CommandError::database)
}
#[tauri::command]
pub async fn bili_media_options(
    provider: State<'_, BilibiliProvider>,
    bvid: String,
    cid: i64,
) -> Result<MediaOptions, CommandError> {
    provider
        .media_options(&bvid, cid)
        .await
        .map_err(CommandError::provider)
}
#[tauri::command]
pub async fn bili_season(
    provider: State<'_, BilibiliProvider>,
    mid: i64,
    season_id: i64,
    refresh: Option<bool>,
) -> Result<Season, CommandError> {
    if mid <= 0 || season_id <= 0 {
        return Err(CommandError::validation("合集标识无效"));
    }
    provider
        .season(mid, season_id, refresh.unwrap_or(false))
        .await
        .map_err(CommandError::provider)
}
#[tauri::command]
pub async fn bili_subtitles(
    provider: State<'_, BilibiliProvider>,
    bvid: String,
    cid: i64,
) -> Result<Vec<SubtitleChoice>, CommandError> {
    provider
        .subtitles(&bvid, cid)
        .await
        .map_err(CommandError::provider)
}
#[tauri::command]
pub async fn bili_subtitle_lines(
    provider: State<'_, BilibiliProvider>,
    bvid: String,
    cid: i64,
    language: String,
) -> Result<Vec<SubtitleLine>, CommandError> {
    let lines = provider
        .subtitle_lines(&bvid, cid, &language)
        .await
        .map_err(CommandError::provider)?;
    if lines.is_empty() {
        return Err(CommandError::validation("这份字幕没有可显示的内容"));
    }
    Ok(lines)
}
pub fn profile(database: &Database) -> String {
    std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default()
}
#[cfg(target_os = "android")]
pub fn observe_android_listening(app: tauri::AppHandle) {
    let profile_path = app.state::<Database>().1.join("active-profile");
    let handle = app.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Sample {
            scope: String,
            track_id: String,
            seconds: Option<f64>,
            position: Option<f64>,
            observed_at: Option<i64>,
            collection_ref: Option<String>,
        }
        if let Ok(sample) = body.deserialize::<Sample>() {
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(seconds) = sample.seconds {
                    let _ = record(&handle, &sample.scope, &sample.track_id, seconds).await;
                }
                if let (Some(position), Some(observed_at)) = (sample.position, sample.observed_at) {
                    save_position(
                        &handle,
                        &sample.scope,
                        &sample.track_id,
                        position,
                        observed_at,
                        sample.collection_ref.as_deref(),
                    );
                }
            });
        }
        Ok(())
    });
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            tauri_plugin_android_player::observe_listening(&app, &profile_path, channel).await
        {
            eprintln!("Android listening observation failed: {error}");
        }
    });
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn save_position(
    app: &tauri::AppHandle,
    scope: &str,
    id: &str,
    seconds: f64,
    observed_at: i64,
    collection_ref: Option<&str>,
) {
    let db = app.state::<Database>();
    if let Ok(connection) = db.0.lock() {
        if profile(&db) == scope {
            let _ = crate::infrastructure::repositories::library::LibraryRepository::save_playback_position(
                &connection, id, seconds, observed_at,
            );
            if let Some(reference) = collection_ref
                && crate::infrastructure::repositories::collections::save_progress(
                    &connection,
                    reference,
                    id,
                    seconds,
                    observed_at,
                )
                .unwrap_or(false)
            {
                use tauri::Emitter;
                let _ = app.emit("collection-progress-changed", reference);
            }
        }
    };
}

#[tauri::command]
pub fn listening_scope(database: State<'_, Database>) -> String {
    profile(&database)
}
pub async fn record(
    app: &tauri::AppHandle,
    expected: &str,
    id: &str,
    seconds: f64,
) -> Result<(), String> {
    if !seconds.is_finite() || seconds <= 0.0 || seconds > 300.0 {
        return Err("收听时长无效".into());
    }
    let state = app.state::<crate::sync::SyncState>();
    let _gate = state.gate.lock().await;
    let db = app.state::<Database>();
    if profile(&db) != expected {
        return Ok(());
    }
    let mut c = db.0.lock().map_err(|_| "数据库正忙")?;
    if !c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tracks WHERE id=?1)",
            [id],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO listening_daily(day,track_id,seconds) VALUES(date('now','localtime'),?1,?2) ON CONFLICT(day,track_id) DO UPDATE SET seconds=seconds+excluded.seconds",params![id,seconds]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO listening_totals(track_id,seconds) VALUES(?1,?2) ON CONFLICT(track_id) DO UPDATE SET seconds=seconds+excluded.seconds",params![id,seconds]).map_err(|e|e.to_string())?;
    tx.execute("INSERT INTO listening_days(day,seconds) VALUES(date('now','localtime'),?1) ON CONFLICT(day) DO UPDATE SET seconds=seconds+excluded.seconds",[seconds]).map_err(|e|e.to_string())?;
    tx.execute(
        "DELETE FROM listening_daily WHERE day<date('now','localtime','-90 days')",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn listening_record(
    app: tauri::AppHandle,
    scope: String,
    track_id: String,
    seconds: f64,
) -> Result<(), CommandError> {
    record(&app, &scope, &track_id, seconds)
        .await
        .map_err(CommandError::database)
}
#[tauri::command]
pub fn listening_statistics(database: State<'_, Database>) -> Result<Value, CommandError> {
    let c = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    let run = || -> rusqlite::Result<Value> {
        let week=c.query_row("SELECT COALESCE(SUM(seconds),0),COUNT(DISTINCT track_id),COUNT(DISTINCT day) FROM listening_daily WHERE day>=date('now','localtime','weekday 0','-6 days')",[],|r|Ok(json!({"seconds":r.get::<_,f64>(0)?,"tracks":r.get::<_,i64>(1)?,"days":r.get::<_,i64>(2)?})))?;
        let total=c.query_row("SELECT COALESCE(SUM(seconds),0),COUNT(*) FROM listening_totals",[],|r|Ok(json!({"seconds":r.get::<_,f64>(0)?,"tracks":r.get::<_,i64>(1)?,"days":c.query_row("SELECT COUNT(*) FROM listening_days",[],|r|r.get::<_,i64>(0))?})))?;
        let mut q=c.prepare("SELECT day,SUM(seconds) FROM listening_daily WHERE day>=date('now','localtime','weekday 0','-6 days') GROUP BY day ORDER BY day")?;
        let daily = q
            .query_map([], |r| {
                Ok(json!({"day":r.get::<_,String>(0)?,"seconds":r.get::<_,f64>(1)?}))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut tops = Vec::new();
        for weekly in [true, false] {
            let table = if weekly {
                "(SELECT track_id,SUM(seconds) seconds FROM listening_daily WHERE day>=date('now','localtime','weekday 0','-6 days') GROUP BY track_id)"
            } else {
                "listening_totals"
            };
            let mut q=c.prepare(&format!("SELECT s.track_id,s.seconds,COALESCE(m.title,t.title,'已移除的歌曲'),COALESCE(m.artist,t.artist,''),COALESCE(m.cover_url,t.cover_url,'') FROM {table} s LEFT JOIN tracks t ON t.id=s.track_id LEFT JOIN metadata_overrides m ON m.track_id=t.id ORDER BY s.seconds DESC,s.track_id LIMIT 20"))?;
            tops.push(q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"seconds":r.get::<_,f64>(1)?,"title":r.get::<_,String>(2)?,"artist":r.get::<_,String>(3)?,"coverUrl":r.get::<_,String>(4)?})))?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
        Ok(json!({"week":week,"total":total,"daily":daily,"weekTop":tops[0],"totalTop":tops[1]}))
    };
    run().map_err(CommandError::database)
}

#[tauri::command]
pub async fn bili_creator_catalog(
    provider: State<'_, BilibiliProvider>,
    action: String,
    keyword: Option<String>,
    mid: Option<i64>,
    page: Option<u32>,
) -> Result<Value, CommandError> {
    provider
        .creator_catalog(
            &action,
            keyword.as_deref().unwrap_or(""),
            mid.unwrap_or(0),
            page.unwrap_or(1),
        )
        .await
        .map_err(CommandError::provider)
}
