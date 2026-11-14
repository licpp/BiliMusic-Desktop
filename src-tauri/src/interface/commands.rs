use crate::domain::track::SourceIdentity;
use crate::infrastructure::database::Database;
use crate::infrastructure::media_proxy::MediaProxy;
use crate::infrastructure::providers::bilibili::{
    AccountProfile, BilibiliProvider, CommentItem, CommentPage, DanmakuItem, FavoriteFolder,
    FavoritePage, PlaybackSource, QrLogin, QrLoginStatus, SearchPage, VideoPart, VideoParts,
    VideoSource,
};
use crate::infrastructure::providers::lrclib::{LrclibProvider, LyricCandidate};
use crate::infrastructure::providers::music_catalog::{CatalogCandidate, MusicCatalogProvider};
use crate::infrastructure::repositories::auth::AuthRepository;
use crate::infrastructure::repositories::downloads::{DownloadRecord, DownloadRepository};
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
use tokio::io::AsyncWriteExt;

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
pub fn collection_progress(
    database: State<'_, Database>,
    reference: String,
) -> Result<
    Option<crate::infrastructure::repositories::collections::CollectionProgress>,
    CommandError,
> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    crate::infrastructure::repositories::collections::progress(&connection, &reference)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn playback_position(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    track_id: String,
    seconds: Option<f64>,
    observed_at: Option<i64>,
    scope: Option<String>,
    collection_ref: Option<String>,
) -> Result<f64, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    if let (Some(seconds), Some(observed_at), Some(scope)) = (seconds, observed_at, scope) {
        if super::media::profile(&database) != scope {
            return Ok(0.0);
        }
        LibraryRepository::save_playback_position(&connection, &track_id, seconds, observed_at)
            .map_err(CommandError::database)?;
        if let Some(reference) = collection_ref
            && crate::infrastructure::repositories::collections::save_progress(
                &connection,
                &reference,
                &track_id,
                seconds,
                observed_at,
            )
            .map_err(CommandError::database)?
        {
            use tauri::Emitter;
            let _ = app.emit("collection-progress-changed", reference);
        }
    }
    LibraryRepository::playback_position(&connection, &track_id).map_err(CommandError::database)
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
pub async fn bili_search_suggestions(
    provider: State<'_, BilibiliProvider>,
    keyword: String,
) -> Result<Vec<String>, CommandError> {
    provider
        .search_suggestions(&keyword)
        .await
        .map_err(CommandError::provider)
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
    name: String,
) -> Result<PlaylistRecord, CommandError> {
    if name.trim().is_empty() || name.chars().count() > 80 {
        return Err(CommandError::validation("歌单名称需为 1 到 80 个字符"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
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
pub fn playlist_add_track(
    database: State<'_, Database>,
    playlist_id: String,
    track_id: String,
) -> Result<(), CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    PlaylistRepository::add_track(&connection, &playlist_id, &track_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_add_tracks(
    database: State<'_, Database>,
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
    playlist_id: String,
    track_id: String,
) -> Result<(), CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    PlaylistRepository::remove_track(&connection, &playlist_id, &track_id)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_remove_tracks(
    database: State<'_, Database>,
    playlist_id: String,
    track_ids: Vec<String>,
) -> Result<(), CommandError> {
    let mut connection = database.0.lock().map_err(CommandError::database)?;
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
    playlist_id: String,
) -> Result<(), CommandError> {
    if playlist_id == FAVORITES_PLAYLIST_ID {
        return Err(CommandError::validation("默认歌单不能删除"));
    }
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    PlaylistRepository::delete(&connection, &playlist_id).map_err(CommandError::database)
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
pub async fn bili_video_pagelist(
    provider: State<'_, BilibiliProvider>,
    bvid: String,
) -> Result<Vec<VideoPart>, CommandError> {
    if !valid_bvid(&bvid) {
        return Err(CommandError::validation("无效的 BV 号"));
    }
    provider
        .video_pagelist(&bvid)
        .await
        .map_err(CommandError::provider)
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
        .map_err(CommandError::provider)?;
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
    bvid: String,
    cid: i64,
) -> Result<(), CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 {
        return Err(CommandError::validation("无效的播放源标识"));
    }
    provider
        .warm_playback(&bvid, cid)
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_video_source(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    bvid: String,
    cid: i64,
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
    let mut source = provider
        .video_source_with_quality(&bvid, cid, quality.video_height)
        .await
        .map_err(CommandError::provider)?;
    media_proxy
        .ensure_running()
        .await
        .map_err(|_| CommandError::provider("本机视频服务恢复失败，请稍后重试"))?;
    source.video_url = media_proxy
        .register_stream(
            source.video_url,
            std::mem::take(&mut source.backup_urls),
            source.mime_type.clone(),
        )
        .await;
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
    provider.danmaku(cid).await.map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_qr_login_generate(
    provider: State<'_, BilibiliProvider>,
) -> Result<QrLogin, CommandError> {
    provider
        .qr_login_generate()
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_qr_login_poll(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    key: String,
    sync: State<'_, crate::sync::SyncState>,
) -> Result<QrLoginStatus, CommandError> {
    let _gate = sync.gate.lock().await;
    let _account = sync.account_gate.lock().await;
    if key.trim().is_empty() {
        return Err(CommandError::validation("二维码登录标识为空"));
    }
    let status = provider
        .qr_login_poll(&key)
        .await
        .map_err(CommandError::provider)?;
    if let Some(cookie) = &status.cookie_header {
        sync.interrupt();
        let profile = provider
            .account_profile()
            .await
            .map_err(CommandError::provider)?;
        let uid = profile
            .user_id
            .filter(|_| profile.logged_in)
            .ok_or_else(|| CommandError::validation("无法验证登录账号"))?;
        database
            .switch(Some(uid), Some(cookie))
            .map_err(CommandError::database)?;
    }
    Ok(status)
}

#[tauri::command]
pub async fn bili_account_profile(
    provider: State<'_, BilibiliProvider>,
) -> Result<AccountProfile, CommandError> {
    provider
        .account_profile()
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_favorite_folders(
    provider: State<'_, BilibiliProvider>,
) -> Result<Vec<FavoriteFolder>, CommandError> {
    provider
        .favorite_folders()
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_favorite_videos(
    provider: State<'_, BilibiliProvider>,
    folder_id: i64,
    page: u32,
) -> Result<FavoritePage, CommandError> {
    if folder_id <= 0 || page == 0 {
        return Err(CommandError::validation("无效的收藏夹或页码"));
    }
    provider
        .favorite_videos(folder_id, page)
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn bili_logout(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    sync: State<'_, crate::sync::SyncState>,
) -> Result<(), CommandError> {
    sync.interrupt();
    let _gate = sync.gate.lock().await;
    let _account = sync.account_gate.lock().await;
    provider.set_session_cookie(None).await;
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    AuthRepository::clear(&connection, "bilibili").map_err(CommandError::database)?;
    drop(connection);
    database.switch(None, None).map_err(CommandError::database)
}

#[tauri::command]
pub async fn bili_comment_emotes(
    provider: State<'_, BilibiliProvider>,
) -> Result<serde_json::Value, CommandError> {
    provider
        .comment_emotes()
        .await
        .map_err(CommandError::provider)
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
        .map_err(CommandError::provider)
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
        .map_err(CommandError::provider)
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
        .map_err(CommandError::provider)
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
        .map_err(CommandError::provider)
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
    let key = serde_json::to_string(&(
        "multi-source-v2",
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
                    .map(|candidates| (candidates, fresh))
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
        Ok(candidates) => {
            if !candidates.is_empty() {
                if let Ok(json) = serde_json::to_string(&candidates) {
                    if json.len() <= 2_000_000 {
                        if let Ok(connection) = database.0.lock() {
                            let _ = LyricsRepository::cache_search(&connection, &key, &json);
                        }
                    }
                }
            }
            Ok(LyricSearchResult {
                candidates,
                warning: None,
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

#[tauri::command]
pub fn downloads_list(database: State<'_, Database>) -> Result<Vec<DownloadRecord>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    DownloadRepository::list(&connection).map_err(CommandError::database)
}

#[tauri::command]
pub fn download_remove(
    database: State<'_, Database>,
    download_id: String,
) -> Result<(), CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    DownloadRepository::remove(&connection, &download_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPlan {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_url: Option<String>,
}
impl PlaybackPlan {
    fn direct(url: String) -> Self {
        Self {
            url,
            upgrade_url: None,
        }
    }
}

#[tauri::command]
pub async fn track_playback_url(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
    refresh: Option<bool>,
    prefer_online: Option<bool>,
) -> Result<String, CommandError> {
    playback_plan(
        database,
        provider,
        media_proxy,
        track_id,
        refresh,
        prefer_online,
        false,
    )
    .await
    .map(|plan| plan.url)
}

#[tauri::command]
pub async fn track_playback_plan(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
    refresh: Option<bool>,
) -> Result<PlaybackPlan, CommandError> {
    playback_plan(
        database,
        provider,
        media_proxy,
        track_id,
        refresh,
        None,
        true,
    )
    .await
}

async fn playback_plan(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
    refresh: Option<bool>,
    prefer_online: Option<bool>,
    progressive: bool,
) -> Result<PlaybackPlan, CommandError> {
    media_proxy
        .ensure_running()
        .await
        .map_err(|_| CommandError::provider("本机音频服务恢复失败，请稍后重试"))?;
    let (track, paths) = {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        let track = LibraryRepository::get(&connection, &track_id)
            .map_err(CommandError::database)?
            .ok_or_else(|| CommandError::validation("歌曲不存在"))?;
        let mut statement = connection.prepare("SELECT target_path FROM downloads WHERE track_id=?1 AND status='completed' ORDER BY updated_at DESC").map_err(CommandError::database)?;
        let paths = statement
            .query_map([&track_id], |row| row.get::<_, String>(0))
            .map_err(CommandError::database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)?;
        (track, paths)
    };
    for path in paths
        .into_iter()
        .filter(|_| !prefer_online.unwrap_or(false))
    {
        let path = std::path::PathBuf::from(path);
        if tokio::fs::metadata(&path)
            .await
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        {
            return Ok(PlaybackPlan::direct(media_proxy.register_local(path).await));
        }
    }
    let quality = {
        let c = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        crate::interface::media::preferences(&c).map_err(CommandError::database)?
    };
    if refresh.unwrap_or(false) {
        media_proxy
            .refresh_connections()
            .await
            .map_err(CommandError::provider)?;
        provider.invalidate_playback(&track.bvid, track.cid).await;
    }
    if !refresh.unwrap_or(false) {
        let cached = if progressive {
            media_proxy
                .complete_cached_audio(&track_id, quality.audio_id)
                .await
        } else {
            media_proxy.cached_audio(&track_id, quality.audio_id).await
        };
        if let Some(url) = cached {
            return Ok(PlaybackPlan::direct(url));
        }
    }
    let sources = if progressive {
        provider
            .playback_startup_sources(&track.bvid, track.cid, quality.audio_id)
            .await
    } else {
        provider
            .playback_source_with_quality(&track.bvid, track.cid, quality.audio_id)
            .await
            .map(|source| (source, None))
    };
    let (source, initial) = match sources {
        Ok(source) => source,
        Err(error) => {
            if prefer_online.unwrap_or(false) {
                return Err(CommandError::provider(error));
            }
            if let Some(url) = media_proxy.cached_audio(&track_id, quality.audio_id).await {
                return Ok(PlaybackPlan::direct(url));
            }
            return Err(CommandError::provider(error));
        }
    };
    let target_bandwidth = source.bandwidth;
    let target = media_proxy
        .register_audio(&track_id, &track.bvid, track.cid, quality.audio_id, source)
        .await;
    if let Some(initial) = initial {
        let target = media_proxy.guard_upgrade(&target, target_bandwidth).await;
        let url = media_proxy
            .register_audio(
                &track_id,
                &track.bvid,
                track.cid,
                initial.quality_id,
                initial,
            )
            .await;
        Ok(PlaybackPlan {
            url,
            upgrade_url: Some(target),
        })
    } else {
        Ok(PlaybackPlan::direct(target))
    }
}

#[tauri::command]
pub fn library_save_track(
    database: State<'_, Database>,
    track: TrackInput,
) -> Result<TrackRecord, CommandError> {
    validate_track(&track)?;
    let mut connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    LibraryRepository::upsert(&mut connection, &track).map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_rename(
    database: State<'_, Database>,
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
    PlaylistRepository::rename(&connection, &playlist_id, &name).map_err(CommandError::database)
}

#[tauri::command]
pub fn mobile_download_directory(app: tauri::AppHandle) -> Result<String, CommandError> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(CommandError::database)?
        .join("downloads");
    std::fs::create_dir_all(&directory).map_err(CommandError::database)?;
    Ok(directory.to_string_lossy().into_owned())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn mobile_export_download(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    download_id: String,
) -> Result<(), CommandError> {
    use rusqlite::OptionalExtension;
    use tauri::Manager;
    let target: String = {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        connection
            .query_row(
                "SELECT target_path FROM downloads WHERE id=?1 AND status='completed'",
                [&download_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(CommandError::database)?
            .ok_or_else(|| CommandError::validation("找不到已下载的歌曲"))?
    };
    let directory = app
        .path()
        .app_data_dir()
        .map_err(CommandError::database)?
        .join("downloads")
        .canonicalize()
        .map_err(CommandError::database)?;
    let path = std::path::PathBuf::from(target)
        .canonicalize()
        .map_err(CommandError::database)?;
    if !path.starts_with(directory) || !path.is_file() {
        return Err(CommandError::validation("下载文件不可用"));
    }
    tauri_plugin_ios_player::export_download(&app, &path)
        .await
        .map_err(CommandError::database)
}

#[tauri::command]
pub async fn download_track(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    track_id: String,
    bvid: String,
    cid: i64,
    title: String,
    target_directory: String,
    skip_existing: Option<bool>,
    audio_id: Option<u32>,
    export_format: Option<String>,
) -> Result<bool, CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 || track_id != format!("bilibili:{bvid}:{cid}") {
        return Err(CommandError::validation("无效的下载歌曲标识"));
    }
    let directory = std::path::PathBuf::from(target_directory)
        .canonicalize()
        .map_err(|_| CommandError::validation("下载目录不存在或不可访问"))?;
    if !directory.is_dir() {
        return Err(CommandError::validation("下载位置不是目录"));
    }
    #[cfg(any(target_os = "android", target_os = "ios", target_env = "ohos"))]
    {
        use tauri::Manager;
        let allowed = app
            .path()
            .app_data_dir()
            .map_err(CommandError::database)?
            .join("downloads")
            .canonicalize()
            .map_err(CommandError::database)?;
        if directory != allowed {
            return Err(CommandError::validation("移动端下载仅写入应用私有目录"));
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios", target_env = "ohos")))]
    let _ = app;
    let expected_profile = crate::interface::media::profile(&database);
    let requested_audio = audio_id.unwrap_or(0);
    if requested_audio > 40000 {
        return Err(CommandError::validation("不支持的下载音质"));
    }
    let export_format = export_format.as_deref().unwrap_or("auto");
    if !["auto", "original", "flac"].contains(&export_format) {
        return Err(CommandError::validation("不支持的下载格式"));
    }
    {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        if LibraryRepository::get(&connection, &track_id)
            .map_err(CommandError::database)?
            .is_none()
        {
            return Err(CommandError::validation("请先播放歌曲再下载"));
        }
        if skip_existing.unwrap_or(false) {
            let mut query = connection
                .prepare(
                    "SELECT target_path FROM downloads WHERE track_id=?1 AND status='completed'",
                )
                .map_err(CommandError::database)?;
            let paths = query
                .query_map([&track_id], |row| row.get::<_, String>(0))
                .map_err(CommandError::database)?;
            for path in paths {
                if std::fs::metadata(path.map_err(CommandError::database)?)
                    .is_ok_and(|m| m.is_file() && m.len() > 0)
                {
                    return Ok(false);
                }
            }
        }
        let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM downloads WHERE track_id=?1 AND status IN ('queued','downloading'))", [&track_id], |row| row.get(0)).map_err(CommandError::database)?;
        if active {
            return Err(CommandError::validation("这首歌曲正在下载中"));
        }
    }
    let source = provider
        .playback_source_with_quality(&bvid, cid, requested_audio)
        .await
        .map_err(CommandError::provider)?;
    if requested_audio != 0 && source.quality_id != requested_audio {
        return Err(CommandError::validation(
            "当前视频或账号无法获取所选音质，请重新选择",
        ));
    }
    let lossless = source.codecs.eq_ignore_ascii_case("flac");
    if export_format == "flac" && !lossless {
        return Err(CommandError::validation(
            "当前音源没有可用的无损音轨，请选择 AAC 或其他视频",
        ));
    }
    let original_extension = audio_download_extension(&source.mime_type, &source.codecs)
        .ok_or_else(|| CommandError::validation("这个音频格式暂不支持下载"))?;
    let extract_flac = lossless && original_extension == "m4a" && export_format != "original";
    let extension = if extract_flac {
        "flac"
    } else {
        original_extension
    };
    let quality_tag = if lossless {
        "HiRes".to_owned()
    } else {
        format!("AAC-{}k", (source.bandwidth + 500) / 1000)
    };
    let target = directory.join(format!(
        "{}-{}-{}-{}.{}",
        safe_filename(&title),
        bvid,
        cid,
        quality_tag,
        extension
    ));
    let download_id = uuid::Uuid::new_v4().to_string();
    let temporary = target.with_extension(format!("{download_id}.part"));
    let converted = target.with_extension(format!("{download_id}.flac.part"));
    {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        if expected_profile != crate::interface::media::profile(&database) {
            return Err(CommandError::validation("账号已切换，请重新下载"));
        }
        let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM downloads WHERE track_id=?1 AND status IN ('queued','downloading'))", [&track_id], |row| row.get(0)).map_err(CommandError::database)?;
        if active {
            return Err(CommandError::validation("这首歌曲正在下载中"));
        }
        DownloadRepository::create(
            &connection,
            &download_id,
            &track_id,
            &target.to_string_lossy(),
        )
        .map_err(CommandError::database)?;
    }
    let result: Result<i64, Box<dyn std::error::Error + Send + Sync>> = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .user_agent("Mozilla/5.0 Resonance/0.1")
            .build()?;
        let urls = std::iter::once(source.audio_url)
            .chain(source.backup_urls)
            .collect::<Vec<_>>();
        let (mut response, _) =
            crate::infrastructure::media_proxy::fetch_upstream(&client, &urls, None)
                .await
                .map_err(std::io::Error::other)?;
        let total = response.content_length().map(|value| value as i64);
        if let Ok(connection) = database.0.lock() {
            let _ = DownloadRepository::progress(&connection, &download_id, 0, total);
        }
        let mut file = tokio::fs::File::create(&temporary).await?;
        let mut received = 0_i64;
        let mut last_reported = 0_i64;
        while let Some(chunk) = response.chunk().await? {
            file.write_all(&chunk).await?;
            received += chunk.len() as i64;
            if received - last_reported >= 512 * 1024 {
                if let Ok(connection) = database.0.lock() {
                    let _ =
                        DownloadRepository::progress(&connection, &download_id, received, total);
                }
                last_reported = received;
            }
        }
        if received == 0 || total.is_some_and(|total| received != total) {
            return Err(std::io::Error::other("音频下载不完整，请重新下载").into());
        }
        file.flush().await?;
        drop(file);
        if extract_flac {
            let input = temporary.clone();
            let output = converted.clone();
            received = tokio::task::spawn_blocking(move || {
                crate::infrastructure::flac_export::export(&input, &output)
            })
            .await?? as i64;
            tokio::fs::rename(&converted, &target).await?;
            let _ = tokio::fs::remove_file(&temporary).await;
        } else {
            tokio::fs::rename(&temporary, &target).await?;
        }
        Ok(received)
    }
    .await;
    match result {
        Ok(received) => {
            let connection = database
                .0
                .lock()
                .map_err(|_| CommandError::database("数据库正忙"))?;
            DownloadRepository::complete(&connection, &download_id, received)
                .map(|_| true)
                .map_err(CommandError::database)
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary).await;
            let _ = tokio::fs::remove_file(&converted).await;
            if let Ok(connection) = database.0.lock() {
                let _ = DownloadRepository::fail(&connection, &download_id, &error.to_string());
            }
            Err(CommandError::provider(format!("下载失败: {error}")))
        }
    }
}

// Preserve the source container. Bilibili Hi-Res is usually FLAC inside MP4:
// renaming those bytes to .flac or .mp3 does not convert the audio.
fn audio_download_extension(mime: &str, codecs: &str) -> Option<&'static str> {
    match mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "audio/mp4" | "video/mp4" | "application/mp4" => Some("m4a"),
        "audio/flac" | "audio/x-flac" => Some("flac"),
        "audio/aac" | "audio/x-aac" => Some("aac"),
        "audio/mpeg" => Some("mp3"),
        "" if codecs.starts_with("mp4a") || codecs.eq_ignore_ascii_case("flac") => Some("m4a"),
        _ => None,
    }
}

fn safe_filename(title: &str) -> String {
    let value: String = title
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) && !character.is_control()
        })
        .take(80)
        .collect();
    let value = value.trim().trim_matches('.');
    if value.is_empty() {
        "未命名歌曲".into()
    } else {
        value.into()
    }
}

pub(super) fn valid_bvid(value: &str) -> bool {
    value.len() >= 10
        && value.len() <= 16
        && value.starts_with("BV")
        && value.chars().all(|char| char.is_ascii_alphanumeric())
}

fn validate_track(track: &TrackInput) -> Result<(), CommandError> {
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

#[cfg(test)]
mod tests {
    #[test]
    fn download_extension_preserves_the_container_even_for_lossless_audio() {
        assert_eq!(
            super::audio_download_extension("audio/mp4", "fLaC"),
            Some("m4a")
        );
        assert_eq!(
            super::audio_download_extension("audio/mp4; codecs=mp4a.40.2", "mp4a.40.2"),
            Some("m4a")
        );
        assert_eq!(
            super::audio_download_extension("audio/flac", "flac"),
            Some("flac")
        );
        assert_eq!(
            super::audio_download_extension("audio/aac", "mp4a.40.2"),
            Some("aac")
        );
        assert_eq!(
            super::audio_download_extension("text/html", "mp4a.40.2"),
            None
        );
    }
    #[test]
    fn filename_removes_cross_platform_reserved_characters() {
        assert_eq!(super::safe_filename("a/b:c*?\"<>|"), "abc");
        assert_eq!(super::safe_filename("..."), "未命名歌曲");
    }
}

#[tauri::command]
pub async fn app_check_update()
-> Result<crate::infrastructure::updates::UpdateRelease, CommandError> {
    crate::infrastructure::updates::check_update()
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn app_open_download_page(app: tauri::AppHandle) -> Result<(), CommandError> {
    #[cfg(target_env = "ohos")]
    return tauri_plugin_ohos_player::open_url(&app, crate::infrastructure::updates::DOWNLOAD_PAGE)
        .await
        .map_err(CommandError::provider);
    #[cfg(not(target_env = "ohos"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(crate::infrastructure::updates::DOWNLOAD_PAGE, None::<&str>)
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
pub fn collections_change(
    database: State<'_, Database>,
    action: String,
    id: Option<String>,
    name: Option<String>,
    item: Option<crate::infrastructure::repositories::collections::Collection>,
) -> Result<(), String> {
    let mut c = database.0.lock().map_err(|_| "数据库正忙")?;
    crate::infrastructure::repositories::collections::change(
        &mut c,
        &action,
        id.as_deref().unwrap_or(""),
        name.as_deref().unwrap_or(""),
        item,
    )
}
