use super::account::check_account_session;
use crate::domain::track::SourceIdentity;
use crate::infrastructure::database::Database;
use crate::infrastructure::media_proxy::MediaProxy;
pub(super) use crate::infrastructure::providers::bilibili::valid_bvid;
use crate::infrastructure::providers::bilibili::{
    BilibiliProvider, CommentItem, CommentPage, DanmakuItem, FeedPage, PlaybackSource,
    ProviderError, RequestPriority, SearchPage, VideoPart, VideoParts, VideoSource,
};
use crate::infrastructure::providers::lrclib::{LrclibProvider, LyricCandidate};
use crate::infrastructure::providers::music_catalog::{CatalogCandidate, MusicCatalogProvider};
use crate::infrastructure::repositories::collections::{self, Collection};
use crate::infrastructure::repositories::library::{
    LibraryRepository, MetadataPatch, TrackInput, TrackRecord,
};
use crate::infrastructure::repositories::lyrics::{
    LyricsRepository, SaveLyricsInput, StoredLyrics,
};
use crate::infrastructure::repositories::playlists::{
    FAVORITES_PLAYLIST_ID, PlaylistRecord, PlaylistRepository,
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
        tracks: count("tracks t JOIN source_items s ON s.id=t.source_item_id WHERE s.provider='bilibili'").map_err(|error| error.to_string())?,
        playlists: count("playlists").map_err(|error| error.to_string())?,
        favorites: count("favorites f JOIN tracks t ON t.id=f.track_id JOIN source_items s ON s.id=t.source_item_id WHERE s.provider='bilibili'").map_err(|error| error.to_string())?,
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
    saved_only: Option<bool>,
) -> Result<Vec<TrackRecord>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    if saved_only.unwrap_or(false) {
        LibraryRepository::saved(&connection, 500).map_err(CommandError::database)
    } else {
        LibraryRepository::list(&connection, favorites_only.unwrap_or(false), 500)
            .map_err(CommandError::database)
    }
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
    expected_account_session: String,
    track_id: String,
) -> Result<bool, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
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
    expected_account_session: String,
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
    check_account_session(&connection, &expected_account_session)?;
    LibraryRepository::update_metadata(&connection, &track_id, &patch)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn library_history_presence(
    database: State<'_, Database>,
    expected_account_session: String,
) -> Result<crate::sync::HistoryPresence, CommandError> {
    crate::sync::history_presence(&database, &expected_account_session)
        .map_err(|error| CommandError::new("sync_error", error, true))
}

#[tauri::command]
pub async fn library_remove_history(
    database: State<'_, Database>,
    sync: State<'_, crate::sync::SyncState>,
    expected_account_session: String,
    track_ids: Vec<String>,
) -> Result<usize, CommandError> {
    validate_history_ids(&track_ids)?;
    crate::sync::remove_history(&database, &sync, &track_ids, &expected_account_session)
        .await
        .map_err(|error| CommandError::new("sync_error", error, true))
}

fn validate_history_ids(ids: &[String]) -> Result<(), CommandError> {
    if ids.is_empty() {
        return Err(CommandError::validation("请先选择要删除的播放记录"));
    }
    if ids.len() > 1000 {
        return Err(CommandError::validation("一次最多删除 1000 条播放记录"));
    }
    Ok(())
}

#[tauri::command]
pub async fn bili_search_suggestions(
    provider: State<'_, BilibiliProvider>,
    keyword: String,
) -> Result<Vec<String>, CommandError> {
    provider
        .search_suggestions(&keyword)
        .await
        .map_err(CommandError::bilibili)
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
    let session =
        database.0.lock().ok().and_then(|connection| {
            crate::infrastructure::database::account_session(&connection).ok()
        });
    let result = provider
        .search(keyword, page.unwrap_or(1), page_size.unwrap_or(20))
        .await;
    if let Some(session) = session
        && let Ok(connection) = database.0.lock()
    {
        check_account_session(&connection, &session)?;
        if result.is_ok() {
            let _ = SearchHistoryRepository::record(&connection, keyword);
        }
    }
    result.map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_personalized_feed(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    expected_account_session: String,
    page: u32,
) -> Result<FeedPage, CommandError> {
    let check_session = || {
        let connection = database.0.lock().map_err(CommandError::database)?;
        check_account_session(&connection, &expected_account_session)
    };
    check_session()?;
    let result = provider.personalized_feed(page).await;
    check_session()?;
    result.map_err(CommandError::bilibili)
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
pub fn search_history_clear(
    database: State<'_, Database>,
    expected_account_session: String,
) -> Result<(), CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    SearchHistoryRepository::clear(&connection).map_err(CommandError::database)
}

#[tauri::command]
pub fn playlists_list(database: State<'_, Database>) -> Result<Vec<PlaylistRecord>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    let mut playlists = PlaylistRepository::list(&connection).map_err(CommandError::database)?;
    playlists.extend(super::linked_folders::list_as_playlists(&connection)?);
    playlists.sort_by(|a, b| {
        b.is_system
            .cmp(&a.is_system)
            .then_with(|| b.added_at.total_cmp(&a.added_at))
    });
    Ok(playlists)
}

#[tauri::command]
pub fn playlist_create(
    database: State<'_, Database>,
    expected_account_session: String,
    name: String,
) -> Result<PlaylistRecord, CommandError> {
    if name.trim().is_empty() || name.chars().count() > 80 {
        return Err(CommandError::validation("歌单名称需为 1 到 80 个字符"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    PlaylistRepository::create(&connection, &uuid::Uuid::new_v4().to_string(), &name)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_tracks(
    database: State<'_, Database>,
    playlist_id: String,
) -> Result<Vec<TrackRecord>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    PlaylistRepository::tracks(&connection, &playlist_id).map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_reorder(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
    expected: Vec<String>,
    ordered: Vec<String>,
) -> Result<(), CommandError> {
    let mut connection = database.0.lock().map_err(CommandError::database)?;
    check_account_session(&connection, &expected_account_session)?;
    if !PlaylistRepository::reorder(
        &mut connection,
        &database.1,
        &playlist_id,
        &expected,
        &ordered,
    )
    .map_err(CommandError::database)?
    {
        return Err(CommandError::validation("歌单顺序已变化，请重新整理"));
    }
    Ok(())
}

#[tauri::command]
pub fn playlist_replace_video(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
    previous: String,
    track: TrackInput,
    keep_existing: Option<bool>,
) -> Result<bool, CommandError> {
    validate_track(&track)?;
    let mut connection = database.0.lock().map_err(CommandError::database)?;
    check_account_session(&connection, &expected_account_session)?;
    match PlaylistRepository::replace_video(
        &mut connection,
        &database.1,
        &playlist_id,
        &previous,
        &track,
        keep_existing,
    )
    .map_err(CommandError::database)?
    {
        None => Ok(true),
        Some("duplicate") => Ok(false),
        Some(_) => Err(CommandError::validation(
            "歌单条目已变化，请重新打开歌曲操作",
        )),
    }
}

#[tauri::command]
pub fn playlist_add_track(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
    track_id: String,
) -> Result<(), CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    PlaylistRepository::add_track(&connection, &playlist_id, &track_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_add_tracks(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
    track_ids: Vec<String>,
    append: Option<bool>,
) -> Result<(), CommandError> {
    if track_ids.len() > 10_000 {
        return Err(CommandError::database("一次最多添加 10000 首歌曲"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    PlaylistRepository::add_tracks(
        &connection,
        &playlist_id,
        &track_ids,
        append.unwrap_or(false),
    )
    .map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_remove_track(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
    track_id: String,
) -> Result<(), CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    PlaylistRepository::remove_track(&connection, &playlist_id, &track_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_remove_tracks(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<(), CommandError> {
    let mut connection = database.0.lock().map_err(CommandError::database)?;
    check_account_session(&connection, &expected_account_session)?;
    let transaction = connection.transaction().map_err(CommandError::database)?;
    for track_id in track_ids {
        PlaylistRepository::remove_track(&transaction, &playlist_id, &track_id)
            .map_err(CommandError::database)?;
    }
    transaction.commit().map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_delete(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
) -> Result<(), CommandError> {
    if playlist_id == FAVORITES_PLAYLIST_ID {
        return Err(CommandError::validation("默认歌单不能删除"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    PlaylistRepository::delete(&connection, &playlist_id).map_err(CommandError::database)
}

#[tauri::command]
pub async fn bili_video_parts(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    bvid: String,
    background: Option<bool>,
    resume: Option<bool>,
    refresh: Option<bool>,
) -> Result<VideoParts, CommandError> {
    if !valid_bvid(&bvid) {
        return Err(CommandError::validation("无效的 BV 号"));
    }
    let session = database
        .0
        .lock()
        .ok()
        .and_then(|c| crate::infrastructure::database::account_session(&c).ok());
    let detail = provider
        .video_parts_request(
            &bvid,
            video_request_priority(background, resume),
            refresh.unwrap_or(false),
        )
        .await
        .map_err(|error| match error {
            // A not-found result from the authoritative details endpoint can
            // be skipped here without labeling playurl failures as expired.
            ProviderError::Api { code: -404, .. } => {
                CommandError::new("source_unavailable", "B 站视频暂不可用", false)
            }
            error => CommandError::audio_source(error),
        })?;
    if let Ok(connection) = database.0.lock() {
        if session.is_some()
            && crate::infrastructure::database::account_session(&connection).ok() == session
        {
            // Cache source names separately from user edits; never create history or favorites.
            let _ = crate::sync::cache_source_titles(&connection, &detail);
        }
    }
    Ok(detail)
}

fn video_request_priority(background: Option<bool>, resume: Option<bool>) -> RequestPriority {
    if resume.unwrap_or(false) {
        RequestPriority::Resume
    } else if background.unwrap_or(false) {
        RequestPriority::Background
    } else {
        RequestPriority::Foreground
    }
}

#[tauri::command]
pub async fn bili_video_pagelist(
    provider: State<'_, BilibiliProvider>,
    bvid: String,
    background: Option<bool>,
    resume: Option<bool>,
) -> Result<Vec<VideoPart>, CommandError> {
    if !valid_bvid(&bvid) {
        return Err(CommandError::validation("无效的 BV 号"));
    }
    provider
        .video_pagelist_with_priority(&bvid, video_request_priority(background, resume))
        .await
        .map_err(CommandError::audio_source)
}

#[tauri::command]
pub async fn bili_playback_source(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    bvid: String,
    cid: i64,
) -> Result<PlaybackSource, CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 {
        return Err(CommandError::validation("无效的播放源标识"));
    }
    let quality = {
        let c = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        crate::interface::media::preferences(&c).map_err(CommandError::database)?
    };
    let mut source = provider
        .playback_source_with_quality(&bvid, cid, quality.audio_id)
        .await
        .map_err(CommandError::bilibili)?;
    source.audio_url = media_proxy
        .register_audio(
            &format!("bilibili:{bvid}:{cid}"),
            &bvid,
            cid,
            quality.audio_id,
            source.clone(),
        )
        .await;
    source.backup_urls.clear();
    Ok(source)
}

#[tauri::command]
pub async fn bili_warm_playback(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    media_proxy: State<'_, MediaProxy>,
    bvid: String,
    cid: i64,
) -> Result<(), CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 {
        return Err(CommandError::validation("无效的播放源标识"));
    }
    let quality = {
        let c = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        crate::interface::media::preferences(&c).map_err(CommandError::database)?
    };
    let (source, initial) = provider
        .playback_startup_sources_with_priority(
            &bvid,
            cid,
            quality.audio_id,
            RequestPriority::Background,
        )
        .await
        .map_err(CommandError::bilibili)?;
    let (quality, source) = initial
        .map(|s| (s.quality_id, s))
        .unwrap_or((quality.audio_id, source));
    let url = media_proxy
        .register_audio(
            &format!("bilibili:{bvid}:{cid}"),
            &bvid,
            cid,
            quality,
            source,
        )
        .await;
    media_proxy
        .preload_start(&url)
        .await
        .map_err(CommandError::provider)?;
    Ok(())
}

#[tauri::command]
pub async fn bili_video_source(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    bvid: String,
    cid: i64,
    refresh: Option<bool>,
    compatible: Option<bool>,
) -> Result<VideoSource, CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 {
        return Err(CommandError::validation("无效的视频源标识"));
    }
    let quality = {
        let c = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        crate::interface::media::preferences(&c).map_err(CommandError::database)?
    };
    if refresh.unwrap_or(false) {
        provider.invalidate_playback(&bvid, cid).await;
    }
    let mut source = provider
        .video_source_with_quality(
            &bvid,
            cid,
            quality.video_height,
            compatible.unwrap_or(false)
                || (cfg!(target_os = "android")
                    && app.config().identifier == "app.bilimusic.large"
                    && quality.video_height == 0),
        )
        .await
        .map_err(CommandError::bilibili)?;
    media_proxy
        .ensure_running()
        .await
        .map_err(|_| CommandError::provider("本机视频服务恢复失败，请稍后重试"))?;
    let url = media_proxy
        .register_stream(
            source.video_url,
            std::mem::take(&mut source.backup_urls),
            source.mime_type.clone(),
        )
        .await;
    source.video_url = media_proxy.platform_video_url(url, &source.codecs).await;
    Ok(source)
}

#[tauri::command]
pub async fn bili_danmaku(
    provider: State<'_, BilibiliProvider>,
    cid: i64,
) -> Result<Vec<DanmakuItem>, CommandError> {
    if cid <= 0 {
        return Err(CommandError::validation("无效的弹幕标识"));
    }
    provider.danmaku(cid).await.map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_comment_emotes(
    provider: State<'_, BilibiliProvider>,
) -> Result<serde_json::Value, CommandError> {
    provider
        .comment_emotes()
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_comments(
    provider: State<'_, BilibiliProvider>,
    aid: i64,
    next: Option<i64>,
) -> Result<CommentPage, CommandError> {
    if aid <= 0 {
        return Err(CommandError::validation("无效的视频 AV 标识"));
    }
    provider
        .comments(aid, next.unwrap_or(0))
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_comment_replies(
    provider: State<'_, BilibiliProvider>,
    aid: i64,
    root: i64,
    page: Option<u32>,
) -> Result<Vec<CommentItem>, CommandError> {
    if aid <= 0 || root <= 0 {
        return Err(CommandError::validation("无效的评论标识"));
    }
    provider
        .comment_replies(aid, root, page.unwrap_or(1))
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_comment_reply_page(
    provider: State<'_, BilibiliProvider>,
    aid: i64,
    root: String,
    page: u32,
) -> Result<CommentPage, CommandError> {
    let root = root
        .parse::<i64>()
        .ok()
        .filter(|root| *root > 0)
        .ok_or_else(|| CommandError::validation("无效的评论标识"))?;
    if aid <= 0 || page == 0 {
        return Err(CommandError::validation("无效的评论分页"));
    }
    provider
        .comment_reply_page(aid, root, page)
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_comment_like(
    provider: State<'_, BilibiliProvider>,
    aid: i64,
    reply_id: i64,
    liked: bool,
) -> Result<(), CommandError> {
    if aid <= 0 || reply_id <= 0 {
        return Err(CommandError::validation("无效的评论标识"));
    }
    provider
        .comment_like(aid, reply_id, liked)
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_comment_reply(
    provider: State<'_, BilibiliProvider>,
    aid: i64,
    message: String,
    root: Option<i64>,
    parent: Option<i64>,
) -> Result<(), CommandError> {
    let message = message.trim();
    if aid <= 0 || message.is_empty() || message.chars().count() > 1000 {
        return Err(CommandError::validation("回复内容需为 1 到 1000 个字符"));
    }
    provider
        .comment_reply(aid, message, root, parent)
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn lyrics_search(
    provider: State<'_, LrclibProvider>,
    database: State<'_, Database>,
    title: String,
    artist: Option<String>,
    force_refresh: Option<bool>,
) -> Result<LyricSearchResult, CommandError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CommandError::validation("歌曲名不能为空"));
    }
    // Refresh entries from the three-candidate search.
    let key = serde_json::to_string(&(
        "multi-source-v5",
        title.to_lowercase(),
        artist.as_deref().unwrap_or("").trim().to_lowercase(),
    ))
    .expect("query key");
    let cached = {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        LyricsRepository::cached_search(&connection, &key)
            .map_err(CommandError::database)?
            .and_then(|(json, fresh)| {
                serde_json::from_str::<Vec<LyricCandidate>>(&json)
                    .ok()
                    .map(|mut candidates| {
                        for candidate in &mut candidates {
                            candidate.normalize_domestic_timing();
                        }
                        (candidates, fresh)
                    })
            })
    };
    if !force_refresh.unwrap_or(false) {
        if let Some((candidates, true)) = &cached {
            return Ok(LyricSearchResult {
                candidates: candidates.clone(),
                warning: None,
            });
        }
    }
    match provider.search(title, artist.as_deref()).await {
        Ok(result) => {
            // Never retain a partial search as a fresh, all-source cache entry.
            if result.complete() && !result.candidates.is_empty() {
                if let Ok(json) = serde_json::to_string(&result.candidates) {
                    if json.len() <= 2_000_000 {
                        if let Ok(connection) = database.0.lock() {
                            let _ = LyricsRepository::cache_search(&connection, &key, &json);
                        }
                    }
                }
            }
            let warning = result.warning();
            Ok(LyricSearchResult {
                candidates: result.candidates,
                warning,
            })
        }
        Err(error) => {
            if let Some((candidates, _)) = cached {
                Ok(LyricSearchResult {
                    candidates,
                    warning: Some("在线歌词服务暂时不可用，已显示本地缓存的搜索结果".into()),
                })
            } else {
                Err(CommandError::provider(error))
            }
        }
    }
}

#[derive(Serialize)]
pub struct LyricSearchResult {
    candidates: Vec<LyricCandidate>,
    warning: Option<String>,
}

#[tauri::command]
pub async fn metadata_catalog_search(
    provider: State<'_, MusicCatalogProvider>,
    title: String,
    artist: String,
    source: Option<String>,
) -> Result<Vec<CatalogCandidate>, CommandError> {
    if title.trim().is_empty() {
        return Err(CommandError::validation("请先填写歌曲名"));
    }
    let source = source.as_deref().unwrap_or("auto");
    if !["auto", "netease", "qq", "itunes", "musicbrainz"].contains(&source) {
        return Err(CommandError::validation("不支持的歌曲信息来源"));
    }
    provider
        .search(title.trim(), artist.trim(), source)
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
pub fn lyrics_complete_selected(
    database: State<'_, Database>,
    track_id: String,
    expected: StoredLyrics,
    raw_text: String,
    parsed_json: String,
) -> Result<Option<StoredLyrics>, CommandError> {
    if raw_text.len() > 2_000_000 || parsed_json.len() > 2_000_000 {
        return Err(CommandError::validation("歌词内容过大"));
    }
    serde_json::from_str::<serde_json::Value>(&parsed_json)
        .map_err(|_| CommandError::validation("歌词解析数据无效"))?;
    let c = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    if crate::infrastructure::database::account_session(&c).map_err(CommandError::database)?
        != expected.account_session
    {
        return Ok(None);
    }
    LyricsRepository::complete(&c, &track_id, &expected, &raw_text, &parsed_json)
        .map_err(CommandError::database)?;
    LyricsRepository::get(&c, &track_id).map_err(CommandError::database)
}

#[tauri::command]
pub async fn lyrics_restore_selected(
    provider: State<'_, LrclibProvider>,
    lyric_provider: String,
    id: i64,
) -> Result<Option<LyricCandidate>, CommandError> {
    provider
        .selected(&lyric_provider, id)
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub fn lyrics_save(
    database: State<'_, Database>,
    expected_account_session: String,
    track_id: String,
    lyrics: SaveLyricsInput,
    manual: Option<bool>,
) -> Result<StoredLyrics, CommandError> {
    if lyrics.raw_text.len() > 2_000_000 || lyrics.parsed_json.len() > 2_000_000 {
        return Err(CommandError::validation("歌词内容过大"));
    }
    if !["lrclib", "netease", "qq", "local"].contains(&lyrics.provider.as_str()) {
        return Err(CommandError::validation("不支持的歌词来源"));
    }
    serde_json::from_str::<serde_json::Value>(&lyrics.parsed_json)
        .map_err(|_| CommandError::validation("歌词解析数据无效"))?;
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    if LibraryRepository::get(&connection, &track_id)
        .map_err(CommandError::database)?
        .is_none()
    {
        return Err(CommandError::validation("歌曲尚未加入资料库"));
    }
    if !manual.unwrap_or(false) {
        if let Some(existing) =
            LyricsRepository::get(&connection, &track_id).map_err(CommandError::database)?
        {
            if existing.selected_manually || !existing.raw_text.is_empty() {
                return Ok(existing);
            }
        }
    }
    LyricsRepository::save(&connection, &track_id, &lyrics, manual.unwrap_or(false))
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn lyrics_save_with_metadata(
    database: State<'_, Database>,
    expected_account_session: String,
    track_id: String,
    expected_version: String,
    lyrics: SaveLyricsInput,
    metadata: MetadataPatch,
) -> Result<(StoredLyrics, TrackRecord), CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    check_account_session(&c, &expected_account_session)?;
    if super::batch_matching::pair_version(&c, &track_id)? != expected_version {
        return Err(CommandError::validation(
            "这首歌的歌词或资料刚刚更新，请重新选择",
        ));
    }
    super::batch_matching::save_manual_pair(&c, &track_id, metadata, &lyrics)
}

#[tauri::command]
pub fn lyrics_clear(
    database: State<'_, Database>,
    expected_account_session: String,
    expected: StoredLyrics,
) -> Result<StoredLyrics, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    check_account_session(&connection, &expected_account_session)?;
    check_account_session(&connection, &expected.account_session)?;
    LyricsRepository::clear_if_current(&connection, &expected)
        .map_err(CommandError::database)?
        .ok_or_else(|| CommandError::validation("歌词已更新，请重新打开后再移除"))
}

#[tauri::command]
pub fn lyrics_set_bias(
    database: State<'_, Database>,
    expected_account_session: String,
    track_id: String,
    bias_ms: i64,
    expected: StoredLyrics,
) -> Result<LyricBiasWrite, CommandError> {
    if bias_ms.unsigned_abs() > crate::infrastructure::repositories::lyrics::MAX_SAFE_BIAS_MS {
        return Err(CommandError::validation("歌词偏移数值无效"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    check_account_session(&connection, &expected.account_session)?;
    if expected.track_id != track_id {
        return Err(CommandError::validation("歌词与当前曲目不一致"));
    }
    if let Some(lyrics) =
        LyricsRepository::set_bias_if_current(&connection, &track_id, bias_ms, &expected)
            .map_err(CommandError::database)?
    {
        return Ok(LyricBiasWrite::Saved { lyrics });
    }
    let lyrics = LyricsRepository::get(&connection, &track_id).map_err(CommandError::database)?;
    Ok(LyricBiasWrite::Conflict { lyrics })
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LyricBiasWrite {
    Saved { lyrics: StoredLyrics },
    Conflict { lyrics: Option<StoredLyrics> },
}

#[tauri::command]
pub fn library_save_track(
    database: State<'_, Database>,
    expected_account_session: String,
    track: TrackInput,
) -> Result<TrackRecord, CommandError> {
    validate_track(&track)?;
    let mut connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    LibraryRepository::upsert(&mut connection, &track).map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_rename(
    database: State<'_, Database>,
    expected_account_session: String,
    playlist_id: String,
    name: String,
) -> Result<(), CommandError> {
    if playlist_id == FAVORITES_PLAYLIST_ID {
        return Err(CommandError::validation("默认歌单不能重命名"));
    }
    if name.trim().is_empty() || name.chars().count() > 80 {
        return Err(CommandError::validation("歌单名称需为 1 到 80 个字符"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    check_account_session(&connection, &expected_account_session)?;
    PlaylistRepository::rename(&connection, &playlist_id, &name).map_err(CommandError::database)
}

pub(crate) fn validate_track(track: &TrackInput) -> Result<(), CommandError> {
    let expected_id = SourceIdentity {
        provider: "bilibili".into(),
        bvid: track.bvid.clone(),
        cid: track.cid,
        page: track.page,
    }
    .stable_key();
    if !valid_bvid(&track.bvid) || track.cid <= 0 || track.id != expected_id {
        return Err(CommandError::validation("歌曲来源标识不一致"));
    }
    if track.title.trim().is_empty() || track.duration_seconds < 0 {
        return Err(CommandError::validation("歌曲信息不完整"));
    }
    Ok(())
}

#[tauri::command]
pub async fn app_check_update(
    app: tauri::AppHandle,
    state: State<'_, crate::infrastructure::update_install::UpdateState>,
) -> Result<crate::infrastructure::updates::UpdateRelease, CommandError> {
    state.check(&app).await.map_err(CommandError::provider)
}

#[tauri::command]
pub async fn app_open_download_page(app: tauri::AppHandle) -> Result<(), CommandError> {
    open_external_page(&app, crate::infrastructure::updates::DOWNLOAD_PAGE).await
}

#[tauri::command]
pub async fn app_open_release_notes(app: tauri::AppHandle) -> Result<(), CommandError> {
    open_external_page(&app, crate::infrastructure::updates::RELEASE_NOTES_PAGE).await
}

#[tauri::command]
pub async fn bili_open_verification_page(app: tauri::AppHandle) -> Result<(), CommandError> {
    open_external_page(&app, "https://www.bilibili.com/").await
}

async fn open_external_page(app: &tauri::AppHandle, url: &'static str) -> Result<(), CommandError> {
    #[cfg(target_env = "ohos")]
    return tauri_plugin_ohos_player::open_url(app, url)
        .await
        .map_err(CommandError::provider);
    #[cfg(not(target_env = "ohos"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(CommandError::provider)
    }
}

#[tauri::command]
pub fn collections_list(
    database: State<'_, Database>,
) -> Result<crate::infrastructure::repositories::collections::Collections, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    crate::infrastructure::repositories::collections::list(&c).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn collections_import_seasons(
    database: State<'_, Database>,
    expected_account_session: String,
    items: Vec<Collection>,
) -> Result<usize, CommandError> {
    let mut c = database.0.lock().map_err(CommandError::database)?;
    check_account_session(&c, &expected_account_session)?;
    collections::import_seasons(&mut c, &items).map_err(CommandError::database)
}
#[tauri::command]
pub fn collections_change(
    database: State<'_, Database>,
    action: String,
    id: Option<String>,
    name: Option<String>,
    item: Option<crate::infrastructure::repositories::collections::Collection>,
    expected_account_session: Option<String>,
) -> Result<(), String> {
    let mut c = database.0.lock().map_err(|_| "数据库正忙")?;
    if matches!(action.as_str(), "cache" | "importCreator") {
        let expected = expected_account_session
            .as_deref()
            .ok_or("账号已切换，请重试")?;
        check_account_session(&c, expected).map_err(|error| error.message)?;
    }
    crate::infrastructure::repositories::collections::change(
        &mut c,
        &action,
        id.as_deref().unwrap_or(""),
        name.as_deref().unwrap_or(""),
        item,
    )
}
