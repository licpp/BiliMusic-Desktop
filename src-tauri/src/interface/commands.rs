use crate::infrastructure::database::Database;
use crate::infrastructure::media_proxy::MediaProxy;
use crate::infrastructure::providers::bilibili::{
    BilibiliProvider, PlaybackSource, SearchPage, VideoParts,
};
use crate::interface::error::CommandError;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    app: &'static str,
    database: &'static str,
    schema_version: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    tracks: i64,
    playlists: i64,
    favorites: i64,
}

#[tauri::command]
pub fn app_health(database: State<'_, Database>) -> Result<Health, String> {
    let connection = database.0.lock().map_err(|_| "database lock poisoned")?;
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(Health {
        app: "ready",
        database: "ready",
        schema_version,
    })
}

#[tauri::command]
pub fn library_summary(database: State<'_, Database>) -> Result<LibrarySummary, String> {
    let connection = database.0.lock().map_err(|_| "database lock poisoned")?;
    let count = |table: &str| {
        connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
    };
    Ok(LibrarySummary {
        tracks: count("tracks").map_err(|error| error.to_string())?,
        playlists: count("playlists").map_err(|error| error.to_string())?,
        favorites: count("favorites").map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
pub async fn bili_search(
    provider: State<'_, BilibiliProvider>,
    keyword: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<SearchPage, CommandError> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Err(CommandError::validation("请输入搜索关键词"));
    }
    provider
        .search(keyword, page.unwrap_or(1), page_size.unwrap_or(20))
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_video_parts(
    provider: State<'_, BilibiliProvider>,
    bvid: String,
) -> Result<VideoParts, CommandError> {
    if !valid_bvid(&bvid) {
        return Err(CommandError::validation("无效的 BV 号"));
    }
    provider
        .video_parts(&bvid)
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_playback_source(
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    bvid: String,
    cid: i64,
) -> Result<PlaybackSource, CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 {
        return Err(CommandError::validation("无效的播放源标识"));
    }
    let mut source = provider
        .playback_source(&bvid, cid)
        .await
        .map_err(CommandError::provider)?;
    source.audio_url = media_proxy.register(source.audio_url).await;
    source.backup_urls.clear();
    Ok(source)
}

fn valid_bvid(value: &str) -> bool {
    value.len() >= 10
        && value.len() <= 16
        && value.starts_with("BV")
        && value.chars().all(|char| char.is_ascii_alphanumeric())
}
