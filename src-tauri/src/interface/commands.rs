use crate::domain::track::SourceIdentity;
use crate::infrastructure::database::Database;
use crate::infrastructure::media_proxy::MediaProxy;
use crate::infrastructure::providers::bilibili::{
    AccountProfile, BilibiliProvider, CommentItem, CommentPage, DanmakuItem, FavoriteFolder,
    FavoritePage, PlaybackSource, QrLogin, QrLoginStatus, SearchPage, VideoParts, VideoSource,
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
pub fn playlists_list(database: State<'_, Database>) -> Result<Vec<PlaylistRecord>, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    PlaylistRepository::list(&connection).map_err(CommandError::database)
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
    source.audio_url = media_proxy
        .register_stream(
            source.audio_url,
            source.backup_urls.clone(),
            source.mime_type.clone(),
        )
        .await;
    source.backup_urls.clear();
    Ok(source)
}

#[tauri::command]
pub async fn bili_video_source(
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    bvid: String,
    cid: i64,
) -> Result<VideoSource, CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 {
        return Err(CommandError::validation("无效的视频源标识"));
    }
    let mut source = provider
        .video_source(&bvid, cid)
        .await
        .map_err(CommandError::provider)?;
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
) -> Result<QrLoginStatus, CommandError> {
    if key.trim().is_empty() {
        return Err(CommandError::validation("二维码登录标识为空"));
    }
    let status = provider
        .qr_login_poll(&key)
        .await
        .map_err(CommandError::provider)?;
    if let Some(cookie) = &status.cookie_header {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        AuthRepository::save_cookie(&connection, "bilibili", cookie)
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
) -> Result<(), CommandError> {
    provider.set_session_cookie(None).await;
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    AuthRepository::clear(&connection, "bilibili").map_err(CommandError::database)
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
) -> Result<Vec<CatalogCandidate>, CommandError> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return Err(CommandError::validation("请先填写歌曲名和歌手"));
    }
    provider
        .search(title.trim(), artist.trim())
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
    if !["lrclib", "netease", "local"].contains(&lyrics.provider.as_str()) {
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
pub async fn track_playback_url(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
) -> Result<String, CommandError> {
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
    for path in paths {
        let path = std::path::PathBuf::from(path);
        if tokio::fs::metadata(&path)
            .await
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        {
            return Ok(media_proxy.register_local(path).await);
        }
    }
    let source = provider
        .playback_source(&track.bvid, track.cid)
        .await
        .map_err(CommandError::provider)?;
    Ok(media_proxy
        .register_stream(source.audio_url, source.backup_urls, source.mime_type)
        .await)
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
pub async fn download_track(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    track_id: String,
    bvid: String,
    cid: i64,
    title: String,
    target_directory: String,
) -> Result<(), CommandError> {
    if !valid_bvid(&bvid) || cid <= 0 || track_id != format!("bilibili:{bvid}:{cid}") {
        return Err(CommandError::validation("无效的下载歌曲标识"));
    }
    let directory = std::path::PathBuf::from(target_directory)
        .canonicalize()
        .map_err(|_| CommandError::validation("下载目录不存在或不可访问"))?;
    if !directory.is_dir() {
        return Err(CommandError::validation("下载位置不是目录"));
    }
    let target = directory.join(format!("{}-{}-{}.m4a", safe_filename(&title), bvid, cid));
    let download_id = uuid::Uuid::new_v4().to_string();
    let temporary = target.with_extension(format!("{download_id}.part"));
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
        let source = provider.playback_source(&bvid, cid).await?;
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
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&temporary, &target).await?;
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
                .map_err(CommandError::database)
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary).await;
            if let Ok(connection) = database.0.lock() {
                let _ = DownloadRepository::fail(&connection, &download_id, &error.to_string());
            }
            Err(CommandError::provider(format!("下载失败: {error}")))
        }
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

fn valid_bvid(value: &str) -> bool {
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
    fn filename_removes_cross_platform_reserved_characters() {
        assert_eq!(super::safe_filename("a/b:c*?\"<>|"), "abc");
        assert_eq!(super::safe_filename("..."), "未命名歌曲");
    }
}
