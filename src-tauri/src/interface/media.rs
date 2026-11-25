use super::error::CommandError;
use crate::infrastructure::{
    database::{Database, account_session},
    providers::bilibili::*,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    background: Option<bool>,
) -> Result<MediaOptions, CommandError> {
    let priority = if background.unwrap_or(false) {
        RequestPriority::Background
    } else {
        RequestPriority::Foreground
    };
    provider
        .media_options(&bvid, cid, priority)
        .await
        .map_err(CommandError::bilibili)
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
        .map_err(CommandError::bilibili)
}
#[tauri::command]
pub async fn bili_season_cover(
    provider: State<'_, BilibiliProvider>,
    mid: i64,
    season_id: i64,
) -> Result<String, CommandError> {
    if mid <= 0 || season_id <= 0 {
        return Err(CommandError::validation("合集标识无效"));
    }
    provider
        .season_preview_cover(mid, season_id)
        .await
        .map_err(CommandError::bilibili)
}
#[tauri::command]
pub async fn bili_video_chapters(
    provider: State<'_, BilibiliProvider>,
    bvid: String,
    cid: i64,
) -> Result<Vec<VideoChapter>, CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 {
        return Err(CommandError::validation("视频分 P 标识无效"));
    }
    provider
        .video_chapters(&bvid, cid)
        .await
        .map_err(CommandError::bilibili)
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
        .map_err(CommandError::bilibili)
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
        .map_err(CommandError::bilibili)?;
    if lines.is_empty() {
        return Err(CommandError::validation("这份字幕没有可显示的内容"));
    }
    Ok(lines)
}
pub fn profile(database: &Database) -> String {
    std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default()
}
#[cfg(target_os = "android")]
pub use observe_native_listening as observe_android_listening;
#[cfg(target_env = "ohos")]
pub use observe_native_listening as observe_ohos_listening;
#[cfg(target_os = "android")]
use tauri_plugin_android_player as native_listening;
#[cfg(target_env = "ohos")]
use tauri_plugin_ohos_player as native_listening;

#[cfg(any(target_os = "android", target_env = "ohos"))]
pub fn observe_native_listening(app: tauri::AppHandle) {
    let profile_path = app.state::<Database>().1.join("active-profile");
    let handle = app.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Sample {
            account_session: String,
            track_id: String,
            seconds: Option<f64>,
            session_id: Option<String>,
            position: Option<f64>,
            observed_at: Option<i64>,
            collection_ref: Option<String>,
        }
        if let Ok(sample) = body.deserialize::<Sample>() {
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(seconds) = sample.seconds {
                    let _ = record(
                        &handle,
                        &sample.account_session,
                        &sample.track_id,
                        seconds,
                        sample.observed_at,
                        sample.session_id.as_deref(),
                    )
                    .await;
                }
                if let (Some(position), Some(observed_at)) = (sample.position, sample.observed_at) {
                    save_position(
                        &handle,
                        &sample.account_session,
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
        if let Err(error) = native_listening::observe_listening(&app, &profile_path, channel).await
        {
            eprintln!("Native listening observation failed: {error}");
        }
    });
}

#[cfg(any(target_os = "android", target_os = "ios", target_env = "ohos"))]
pub fn save_position(
    app: &tauri::AppHandle,
    expected_session: &str,
    id: &str,
    seconds: f64,
    observed_at: i64,
    collection_ref: Option<&str>,
) {
    let db = app.state::<Database>();
    if let Ok(connection) = db.0.lock() {
        if playback_account_matches(&connection, expected_session).unwrap_or(false) {
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
pub fn listening_scope(database: State<'_, Database>) -> Result<String, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    account_session(&connection).map_err(CommandError::database)
}

pub(crate) fn playback_account_matches(
    connection: &Connection,
    expected_session: &str,
) -> rusqlite::Result<bool> {
    Ok(account_session(connection)? == expected_session)
}

pub async fn record(
    app: &tauri::AppHandle,
    expected_session: &str,
    id: &str,
    seconds: f64,
    observed_at: Option<i64>,
    session_id: Option<&str>,
) -> Result<(), String> {
    if !seconds.is_finite() || seconds <= 0.0 || seconds > 300.0 {
        return Err("收听时长无效".into());
    }
    let observed_at = observed_at.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    });
    let state = app.state::<crate::sync::SyncState>();
    let _gate = state.account_gate.lock().await;
    let db = app.state::<Database>();
    let mut c = db.0.lock().map_err(|_| "数据库正忙")?;
    if !playback_account_matches(&c, expected_session).map_err(|error| error.to_string())? {
        return Ok(());
    }
    let active_profile = profile(&db);
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
    crate::sync::statistics::record(
        &tx,
        &db.1,
        &active_profile,
        id,
        seconds,
        Some(observed_at as f64 / 1000.0),
        session_id,
    )?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn listening_record(
    app: tauri::AppHandle,
    scope: String,
    track_id: String,
    seconds: f64,
    observed_at: Option<i64>,
    session_id: Option<String>,
) -> Result<(), CommandError> {
    record(
        &app,
        &scope,
        &track_id,
        seconds,
        observed_at,
        session_id.as_deref(),
    )
    .await
    .map_err(CommandError::database)
}
#[tauri::command]
pub fn listening_statistics(database: State<'_, Database>) -> Result<Value, CommandError> {
    let c = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    crate::sync::statistics::query(&c, &database.1, &profile(&database))
        .map_err(CommandError::database)
}

#[tauri::command]
pub async fn listening_hydrate_tags(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
) -> Result<usize, CommandError> {
    crate::sync::statistics::hydrate_tags(&database, &provider)
        .await
        .map_err(CommandError::database)
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
        .map_err(CommandError::bilibili)
}

#[cfg(test)]
mod playback_account_tests {
    use super::*;

    #[test]
    fn returning_to_the_same_profile_rejects_samples_from_the_first_visit() {
        let dir = std::env::temp_dir().join(format!(
            "bilimusic-playback-account-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&dir).unwrap();
        let db = Database(
            std::sync::Mutex::new(Connection::open_in_memory().unwrap()),
            dir.clone(),
        );
        db.switch(Some(42), Some("SESSDATA=first")).unwrap();
        let first = account_session(&db.0.lock().unwrap()).unwrap();
        db.switch(Some(43), Some("SESSDATA=second")).unwrap();
        let other = account_session(&db.0.lock().unwrap()).unwrap();
        db.switch(Some(42), Some("SESSDATA=third")).unwrap();
        {
            let connection = db.0.lock().unwrap();
            let current = account_session(&connection).unwrap();
            assert_eq!(profile(&db), "42");
            assert!(!playback_account_matches(&connection, &first).unwrap());
            assert!(!playback_account_matches(&connection, &other).unwrap());
            assert!(playback_account_matches(&connection, &current).unwrap());
        }
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
