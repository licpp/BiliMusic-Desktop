use crate::infrastructure::database::Database;
use crate::infrastructure::media_proxy::MediaProxy;
use crate::infrastructure::providers::bilibili::{
    BilibiliProvider, PlaybackSource, SearchPage, VideoParts,
};
use crate::infrastructure::providers::lrclib::{LrclibProvider, LyricCandidate};
use crate::infrastructure::repositories::library::{
    LibraryRepository, MetadataPatch, TrackInput, TrackRecord,
};
use crate::infrastructure::repositories::lyrics::{
    LyricsRepository, SaveLyricsInput, StoredLyrics,
};
use crate::infrastructure::repositories::search_history::SearchHistoryRepository;
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
pub fn library_record_play(
    database: State<'_, Database>,
    track: TrackInput,
) -> Result<TrackRecord, CommandError> {
    validate_track(&track)?;
    let mut connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    LibraryRepository::record_play(&mut connection, &track).map_err(CommandError::database)
}

#[tauri::command]
pub fn library_tracks(
    database: State<'_, Database>,
    favorites_only: Option<bool>,
) -> Result<Vec<TrackRecord>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    LibraryRepository::list(&connection, favorites_only.unwrap_or(false), 500)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn library_recent(database: State<'_, Database>) -> Result<Vec<TrackRecord>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    LibraryRepository::recent(&connection, 200).map_err(CommandError::database)
}

#[tauri::command]
pub fn library_toggle_favorite(
    database: State<'_, Database>,
    track_id: String,
) -> Result<bool, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    if LibraryRepository::get(&connection, &track_id)
        .map_err(CommandError::database)?
        .is_none()
    {
        return Err(CommandError::validation("歌曲尚未加入资料库"));
    }
    LibraryRepository::toggle_favorite(&connection, &track_id).map_err(CommandError::database)
}

#[tauri::command]
pub fn library_update_metadata(
    database: State<'_, Database>,
    track_id: String,
    patch: MetadataPatch,
) -> Result<TrackRecord, CommandError> {
    if patch.title.trim().is_empty() {
        return Err(CommandError::validation("歌曲名不能为空"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    LibraryRepository::update_metadata(&connection, &track_id, &patch)
        .map_err(CommandError::database)
}

#[tauri::command]
pub async fn bili_search(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    keyword: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<SearchPage, CommandError> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Err(CommandError::validation("请输入搜索关键词"));
    }
    let result = provider
        .search(keyword, page.unwrap_or(1), page_size.unwrap_or(20))
        .await
        .map_err(CommandError::provider)?;
    if let Ok(connection) = database.0.lock() {
        let _ = SearchHistoryRepository::record(&connection, keyword);
    }
    Ok(result)
}

#[tauri::command]
pub fn search_history_list(database: State<'_, Database>) -> Result<Vec<String>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    SearchHistoryRepository::list(&connection).map_err(CommandError::database)
}

#[tauri::command]
pub fn search_history_clear(database: State<'_, Database>) -> Result<(), CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    SearchHistoryRepository::clear(&connection).map_err(CommandError::database)
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

#[tauri::command]
pub async fn lyrics_search(
    provider: State<'_, LrclibProvider>,
    title: String,
    artist: Option<String>,
) -> Result<Vec<LyricCandidate>, CommandError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CommandError::validation("歌曲名不能为空"));
    }
    provider
        .search(title, artist.as_deref())
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub fn lyrics_get(
    database: State<'_, Database>,
    track_id: String,
) -> Result<Option<StoredLyrics>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    LyricsRepository::get(&connection, &track_id).map_err(CommandError::database)
}

#[tauri::command]
pub fn lyrics_save(
    database: State<'_, Database>,
    track_id: String,
    lyrics: SaveLyricsInput,
    manual: Option<bool>,
) -> Result<StoredLyrics, CommandError> {
    if lyrics.raw_text.len() > 2_000_000 || lyrics.parsed_json.len() > 2_000_000 {
        return Err(CommandError::validation("歌词内容过大"));
    }
    serde_json::from_str::<serde_json::Value>(&lyrics.parsed_json)
        .map_err(|_| CommandError::validation("歌词解析数据无效"))?;
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    if LibraryRepository::get(&connection, &track_id)
        .map_err(CommandError::database)?
        .is_none()
    {
        return Err(CommandError::validation("歌曲尚未加入资料库"));
    }
    LyricsRepository::save(&connection, &track_id, &lyrics, manual.unwrap_or(false))
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn lyrics_set_bias(
    database: State<'_, Database>,
    track_id: String,
    bias_ms: i64,
) -> Result<StoredLyrics, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    LyricsRepository::set_bias(&connection, &track_id, bias_ms).map_err(CommandError::database)
}

fn valid_bvid(value: &str) -> bool {
    value.len() >= 10
        && value.len() <= 16
        && value.starts_with("BV")
        && value.chars().all(|char| char.is_ascii_alphanumeric())
}

fn validate_track(track: &TrackInput) -> Result<(), CommandError> {
    let expected_id = format!("bilibili:{}:{}", track.bvid, track.cid);
    if !valid_bvid(&track.bvid) || track.cid <= 0 || track.id != expected_id {
        return Err(CommandError::validation("歌曲来源标识不一致"));
    }
    if track.title.trim().is_empty() || track.duration_seconds < 0 {
        return Err(CommandError::validation("歌曲信息不完整"));
    }
    Ok(())
}
