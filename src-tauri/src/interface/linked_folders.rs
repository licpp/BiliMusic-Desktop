use crate::infrastructure::database::{Database, account_session};
use crate::infrastructure::providers::bilibili::{
    BilibiliProvider, FavoriteFolder, FavoritePage, FavoriteVideo, ProviderError, RequestPriority,
};
use crate::infrastructure::repositories::{auth::AuthRepository, playlists::PlaylistRecord};
use crate::interface::error::CommandError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use tauri::{State, ipc::Channel};

static UPDATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const FOLDER_FRESH_SECONDS: i64 = 300;

#[derive(Default)]
struct FolderOperation {
    lock: tokio::sync::Mutex<()>,
    completed_refreshes: AtomicU64,
}

// Serialize changes to the same folder, without making an opened folder wait
// for every page of an unrelated bulk import. Provider reads remain globally paced.
fn folder_update(
    database: &Database,
    folder_id: i64,
) -> Result<Arc<FolderOperation>, CommandError> {
    type Locks = std::collections::HashMap<(String, i64), Weak<FolderOperation>>;
    static LOCKS: std::sync::OnceLock<std::sync::Mutex<Locks>> = std::sync::OnceLock::new();
    let path = database
        .0
        .lock()
        .map_err(CommandError::database)?
        .path()
        .unwrap_or_default()
        .to_owned();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(CommandError::database)?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = (path, folder_id);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(FolderOperation::default());
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFolder {
    folder_id: i64,
    name: String,
    refreshed_at: i64,
    videos: Vec<FavoriteVideo>,
}

fn read(connection: &Connection, folder_id: i64) -> Result<Option<LinkedFolder>, CommandError> {
    let data: Option<(String, i64, String)> = connection
        .query_row(
            "SELECT name,refreshed_at,videos_json FROM linked_bili_folders WHERE folder_id=?1",
            [folder_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(CommandError::database)?;
    data.map(|(name, refreshed_at, videos)| {
        Ok(LinkedFolder {
            folder_id,
            name,
            refreshed_at,
            videos: serde_json::from_str(&videos).map_err(CommandError::database)?,
        })
    })
    .transpose()
}

pub(super) fn list_as_playlists(
    connection: &Connection,
) -> Result<Vec<PlaylistRecord>, CommandError> {
    let mut query = connection
        .prepare(
            "SELECT folder_id,name,json_array_length(videos_json),
                NULLIF(json_extract(videos_json,'$[0].cover'),''),COALESCE(o.added_at,0)
         FROM linked_bili_folders f LEFT JOIN linked_bili_folder_order o USING(folder_id) ORDER BY o.added_at DESC,f.folder_id DESC",
        )
        .map_err(CommandError::database)?;
    query
        .query_map([], |row| {
            let folder_id: i64 = row.get(0)?;
            Ok(PlaylistRecord {
                id: format!("bili-folder:{folder_id}"),
                name: row.get(1)?,
                description: "关联 B 站收藏夹".into(),
                cover_url: row.get(3)?,
                track_count: row.get(2)?,
                is_system: false,
                added_at: row.get(4)?,
                bili_folder_id: Some(folder_id),
            })
        })
        .map_err(CommandError::database)?
        .collect::<rusqlite::Result<_>>()
        .map_err(CommandError::database)
}

struct FolderSession {
    runtime: String,
    cookie: String,
}

fn session(connection: &Connection) -> Result<FolderSession, CommandError> {
    let cookie = AuthRepository::get_cookie(connection, "bilibili")
        .map_err(CommandError::database)?
        .ok_or_else(|| CommandError::bilibili(ProviderError::NotAuthenticated))?;
    let runtime = account_session(connection).map_err(CommandError::database)?;
    Ok(FolderSession { runtime, cookie })
}

async fn owned_folder(
    database: &Database,
    folder_id: i64,
    active: &FolderSession,
    priority: RequestPriority,
) -> Result<(BilibiliProvider, i64, FavoriteFolder), CommandError> {
    // Use a fixed session for the whole operation, even if another account logs in.
    let provider = BilibiliProvider::new().map_err(CommandError::provider)?;
    provider
        .set_session_cookie(Some(active.cookie.clone()))
        .await;
    provider
        .check_favorite_requests(priority)
        .await
        .map_err(CommandError::bilibili)?;
    let uid = provider
        .account_profile_with_priority(priority)
        .await
        .map_err(CommandError::bilibili)?
        .user_id
        .ok_or_else(|| CommandError::bilibili(ProviderError::NotAuthenticated))?;
    check_folder_session(database, active)?;
    let folder = provider
        .favorite_folders_for_with_priority(uid, priority)
        .await
        .map_err(CommandError::bilibili)?
        .into_iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| CommandError::validation("此收藏夹已不可用，或不属于当前账号"))?;
    Ok((provider, uid, folder))
}

fn check_folder_session(database: &Database, active: &FolderSession) -> Result<(), CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    super::account::check_account_session(&connection, &active.runtime)
}

fn continued_priority(priority: RequestPriority) -> RequestPriority {
    match priority {
        RequestPriority::Resume => RequestPriority::Background,
        other => other,
    }
}

fn ensure_active(
    connection: &Connection,
    active: &FolderSession,
    folder_id: i64,
    uid: i64,
) -> Result<(), CommandError> {
    super::account::check_account_session(connection, &active.runtime)?;
    let owner: Option<i64> = connection
        .query_row(
            "SELECT owner_uid FROM linked_bili_folders WHERE folder_id=?1",
            [folder_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(CommandError::database)?;
    if owner.is_some_and(|owner| owner != uid) {
        return Err(CommandError::validation("收藏夹关联属于其他账号"));
    }
    Ok(())
}

#[tauri::command]
pub async fn bili_linked_create(
    database: State<'_, Database>,
    name: String,
) -> Result<PlaylistRecord, CommandError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(CommandError::validation("B 站歌单名称需为 1 到 40 个字符"));
    }
    let _operation = UPDATE.lock().await;
    let active = session(&*database.0.lock().map_err(CommandError::database)?)?;
    let provider = BilibiliProvider::new().map_err(CommandError::provider)?;
    provider
        .set_session_cookie(Some(active.cookie.clone()))
        .await;
    let uid = provider
        .account_profile()
        .await
        .map_err(CommandError::bilibili)?
        .user_id
        .ok_or_else(|| CommandError::validation("请先登录 B 站账号"))?;
    check_folder_session(&database, &active)?;
    let folder = provider
        .create_favorite_folder(name)
        .await
        .map_err(CommandError::bilibili)?;
    let connection = database.0.lock().map_err(CommandError::database)?;
    ensure_active(&connection, &active, folder.id, uid)?;
    let id = folder.id;
    save_folder(&connection, folder, uid, vec![])?;
    list_as_playlists(&connection)?
        .into_iter()
        .find(|item| item.bili_folder_id == Some(id))
        .ok_or_else(|| CommandError::database("未能读取新建歌单"))
}

#[tauri::command]
pub fn bili_linked_folder(
    database: State<'_, Database>,
    folder_id: i64,
    expected_account_session: String,
) -> Result<Option<LinkedFolder>, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    super::account::check_account_session(&connection, &expected_account_session)?;
    read(&connection, folder_id)
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedMatchedCover {
    track_id: String,
    bvid: String,
    cover_url: String,
    single_part: bool,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
}

fn matched_covers(
    connection: &Connection,
    bvids: &[String],
) -> Result<Vec<LinkedMatchedCover>, CommandError> {
    let bvids = serde_json::to_string(bvids).map_err(CommandError::database)?;
    let mut query = connection
        .prepare_cached(
            "SELECT t.id, s.bvid, COALESCE(m.cover_url, ''),
                    COALESCE(sc.part_count = 1, 0) AND NOT EXISTS (
                      SELECT 1 FROM source_items other
                      WHERE other.provider = s.provider AND other.bvid = s.bvid
                        AND other.cid > 0 AND other.cid <> s.cid
                    ), m.title, m.artist, m.album
             FROM (SELECT DISTINCT value FROM json_each(?1)) requested
             CROSS JOIN source_items s ON s.provider = 'bilibili' AND s.bvid = requested.value AND s.cid > 0
             JOIN tracks t ON t.source_item_id = s.id AND t.id = 'bilibili:' || s.bvid || ':' || s.cid
             JOIN metadata_overrides m ON m.track_id = t.id
             LEFT JOIN source_title_cache sc ON sc.track_id = t.id
             WHERE m.title IS NOT NULL OR m.artist IS NOT NULL OR m.album IS NOT NULL OR NULLIF(trim(m.cover_url), '') IS NOT NULL",
        )
        .map_err(CommandError::database)?;
    query
        .query_map([bvids], |row| {
            Ok(LinkedMatchedCover {
                track_id: row.get(0)?,
                bvid: row.get(1)?,
                cover_url: row.get(2)?,
                single_part: row.get(3)?,
                title: row.get(4)?,
                artist: row.get(5)?,
                album: row.get(6)?,
            })
        })
        .map_err(CommandError::database)?
        .collect::<rusqlite::Result<_>>()
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn bili_linked_matched_covers(
    database: State<'_, Database>,
    bvids: Vec<String>,
    expected_account_session: String,
) -> Result<Vec<LinkedMatchedCover>, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    super::account::check_account_session(&connection, &expected_account_session)?;
    matched_covers(&connection, &bvids)
}

async fn pull_videos(
    database: &Database,
    active: &FolderSession,
    provider: &BilibiliProvider,
    folder_id: i64,
    priority: RequestPriority,
    progress: impl FnMut(usize),
) -> Result<Vec<FavoriteVideo>, CommandError> {
    pull_video_pages(
        |page| async move {
            check_folder_session(database, active)?;
            provider
                .favorite_videos_with_priority(folder_id, page, priority)
                .await
                .map_err(CommandError::bilibili)
        },
        progress,
    )
    .await
}

async fn pull_video_pages<Fut>(
    mut request: impl FnMut(u32) -> Fut,
    mut progress: impl FnMut(usize),
) -> Result<Vec<FavoriteVideo>, CommandError>
where
    Fut: std::future::Future<Output = Result<FavoritePage, CommandError>>,
{
    let mut videos = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for page in 1..=500 {
        let result = request(page).await?;
        let items = result.medias.unwrap_or_default();
        if items.is_empty() && result.has_more {
            return Err(CommandError::validation("收藏夹返回不完整，请稍后刷新"));
        }
        for video in items {
            if super::commands::valid_bvid(&video.bvid) && seen.insert(video.bvid.clone()) {
                videos.push(video);
            }
        }
        progress(videos.len());
        if !result.has_more {
            return Ok(videos);
        }
    }
    Err(CommandError::validation("收藏夹超过可读取的页数"))
}

fn save_folder(
    connection: &Connection,
    folder: FavoriteFolder,
    uid: i64,
    videos: Vec<FavoriteVideo>,
) -> Result<LinkedFolder, CommandError> {
    let tx = connection
        .unchecked_transaction()
        .map_err(CommandError::database)?;
    let encoded = serde_json::to_string(&videos).map_err(CommandError::database)?;
    tx.execute(
        "INSERT INTO linked_bili_folders(folder_id,owner_uid,name,videos_json,refreshed_at)
         VALUES(?1,?2,?3,?4,unixepoch()) ON CONFLICT(folder_id) DO UPDATE
         SET name=excluded.name,videos_json=excluded.videos_json,refreshed_at=excluded.refreshed_at",
        params![folder.id, uid, folder.title, encoded],
    ).map_err(CommandError::database)?;
    tx.execute("INSERT OR IGNORE INTO linked_bili_folder_order(folder_id,added_at) VALUES(?1,(julianday('now')-2440587.5)*86400)", [folder.id]).map_err(CommandError::database)?;
    let saved = read(&tx, folder.id)?.ok_or_else(|| CommandError::database("未能保存收藏夹"))?;
    tx.commit().map_err(CommandError::database)?;
    Ok(saved)
}

#[tauri::command]
pub async fn bili_linked_refresh(
    database: State<'_, Database>,
    folder_id: i64,
    link: bool,
    expected_account_session: String,
    background: bool,
    on_progress: Channel<usize>,
) -> Result<LinkedFolder, CommandError> {
    refresh_folder(
        &database,
        folder_id,
        link,
        &expected_account_session,
        background,
        |count| {
            let _ = on_progress.send(count);
        },
    )
    .await
}

async fn refresh_folder(
    database: &Database,
    folder_id: i64,
    link: bool,
    expected_account_session: &str,
    background: bool,
    progress: impl FnMut(usize),
) -> Result<LinkedFolder, CommandError> {
    let update = folder_update(database, folder_id)?;
    let requested_after = update.completed_refreshes.load(Ordering::Relaxed);
    let _operation = update.lock.lock().await;
    let (active, link_order) = {
        let connection = database.0.lock().map_err(CommandError::database)?;
        super::account::check_account_session(&connection, expected_account_session)?;
        let matching_refresh_completed =
            update.completed_refreshes.load(Ordering::Relaxed) != requested_after;
        if !link {
            let Some(cached) = read(&connection, folder_id)? else {
                return Err(CommandError::validation("收藏夹已解除关联"));
            };
            let now = connection
                .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
                .map_err(CommandError::database)?;
            if matching_refresh_completed || (background && is_fresh(&cached, now)) {
                return Ok(cached);
            }
        }
        (
            session(&connection)?,
            read_link_order(&connection, folder_id)?,
        )
    };
    let priority = if background {
        RequestPriority::Background
    } else {
        RequestPriority::Resume
    };
    let (provider, uid, folder) = owned_folder(database, folder_id, &active, priority).await?;
    let videos = pull_videos(
        database,
        &active,
        &provider,
        folder_id,
        continued_priority(priority),
        progress,
    )
    .await?;
    let connection = database.0.lock().map_err(CommandError::database)?;
    ensure_active(&connection, &active, folder_id, uid)?;
    if read_link_order(&connection, folder_id)? != link_order
        || (!link && read(&connection, folder_id)?.is_none())
    {
        return Err(CommandError::validation("收藏夹关联已变更，请刷新"));
    }
    let saved = save_folder(&connection, folder, uid, videos)?;
    update.completed_refreshes.fetch_add(1, Ordering::Relaxed);
    Ok(saved)
}

fn is_fresh(snapshot: &LinkedFolder, now: i64) -> bool {
    snapshot.refreshed_at > 0
        && (0..FOLDER_FRESH_SECONDS).contains(&now.saturating_sub(snapshot.refreshed_at))
}

fn read_link_order(connection: &Connection, folder_id: i64) -> Result<Option<f64>, CommandError> {
    connection
        .query_row(
            "SELECT added_at FROM linked_bili_folder_order WHERE folder_id=?1",
            [folder_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(CommandError::database)
}

// A newly synced link initially has no Bilibili cache. Hydrate a bounded batch
// after sync; failed/offline folders remain linked and can be retried on opening.
pub(crate) async fn hydrate_synced_links(
    database: &Database,
    expected_account_session: &str,
) -> Result<usize, String> {
    let folders = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        super::account::check_account_session(&c, expected_account_session)
            .map_err(|e| e.message)?;
        let mut q=c.prepare("SELECT folder_id FROM linked_bili_folders WHERE refreshed_at=0 ORDER BY folder_id LIMIT 5").map_err(|e|e.to_string())?;
        q.query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    let mut count = 0;
    for id in folders {
        // Do not start a new request against an account selected mid-hydration.
        match refresh_folder(database, id, false, expected_account_session, true, |_| {}).await {
            Ok(_) => count += 1,
            Err(error)
                if matches!(
                    error.code,
                    "bili_rate_limited" | "bili_verification_required" | "bili_auth_required"
                ) || error.message == "ACCOUNT_SESSION_EXPIRED" =>
            {
                break;
            }
            Err(_) => {}
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn bili_linked_change(
    database: State<'_, Database>,
    folder_id: i64,
    bvid: String,
    add: bool,
    expected_account_session: String,
) -> Result<LinkedFolder, CommandError> {
    if !super::commands::valid_bvid(&bvid) {
        return Err(CommandError::validation("请输入有效的 BV 号"));
    }
    let update = folder_update(&database, folder_id)?;
    let _operation = update.lock.lock().await;
    let active = {
        let connection = database.0.lock().map_err(CommandError::database)?;
        super::account::check_account_session(&connection, &expected_account_session)?;
        session(&connection)?
    };
    let priority = RequestPriority::Foreground;
    let (provider, uid, folder) = owned_folder(&database, folder_id, &active, priority).await?;
    let cached_aid = {
        let connection = database.0.lock().map_err(CommandError::database)?;
        ensure_active(&connection, &active, folder_id, uid)?;
        let cached = read(&connection, folder_id)?
            .ok_or_else(|| CommandError::validation("请先关联此收藏夹"))?;
        cached
            .videos
            .iter()
            .find(|video| video.bvid == bvid)
            .map(|video| video.aid)
            .filter(|id| *id > 0)
    };
    let aid = match cached_aid {
        Some(id) => id,
        None => {
            provider
                .video_parts(&bvid)
                .await
                .map_err(CommandError::bilibili)?
                .aid
        }
    };
    check_folder_session(&database, &active)?;
    provider
        .change_favorite_video(folder_id, aid, add)
        .await
        .map_err(CommandError::bilibili)?;

    // The membership endpoint can lag briefly after a successful write.
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let videos = pull_videos(&database, &active, &provider, folder_id, priority, |_| {})
            .await
            .map_err(|mut cause| {
                cause.message = format!("B 站已接受操作，刷新列表失败：{}", cause.message);
                cause
            })?;
        if videos.iter().any(|video| video.bvid == bvid) == add {
            let connection = database.0.lock().map_err(CommandError::database)?;
            ensure_active(&connection, &active, folder_id, uid)?;
            if read(&connection, folder_id)?.is_none() {
                return Err(CommandError::validation("收藏夹已解除关联"));
            }
            let updated = save_folder(&connection, folder, uid, videos)?;
            update.completed_refreshes.fetch_add(1, Ordering::Relaxed);
            return Ok(updated);
        }
    }
    Err(CommandError::provider(
        "B 站已接受操作，收藏夹列表仍在更新，请稍后刷新",
    ))
}

#[tauri::command]
pub async fn bili_linked_remove_selected(
    database: State<'_, Database>,
    folder_id: i64,
    bvids: Vec<String>,
    expected_account_session: String,
) -> Result<LinkedRemoval, CommandError> {
    let bvids = bvids.into_iter().collect::<std::collections::BTreeSet<_>>();
    if bvids.is_empty()
        || bvids.len() > 50
        || bvids.iter().any(|bvid| !super::commands::valid_bvid(bvid))
    {
        return Err(CommandError::validation("每次可从 B 站移除 1 至 50 个视频"));
    }
    let update = folder_update(&database, folder_id)?;
    let _operation = update.lock.lock().await;
    let active = {
        let connection = database.0.lock().map_err(CommandError::database)?;
        super::account::check_account_session(&connection, &expected_account_session)?;
        session(&connection)?
    };
    let priority = RequestPriority::Foreground;
    let (provider, uid, folder) = owned_folder(&database, folder_id, &active, priority).await?;
    let cached = {
        let connection = database.0.lock().map_err(CommandError::database)?;
        super::account::check_account_session(&connection, &expected_account_session)?;
        ensure_active(&connection, &active, folder_id, uid)?;
        read(&connection, folder_id)?.ok_or_else(|| CommandError::validation("请先关联此收藏夹"))?
    };
    let aids = cached
        .videos
        .iter()
        .map(|video| (video.bvid.as_str(), video.aid))
        .collect::<std::collections::HashMap<_, _>>();
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    let mut deferred = None;
    for bvid in bvids {
        if let Some(message) = &deferred {
            failed.push(LinkedRemovalFailure {
                bvid,
                message: String::clone(message),
            });
            continue;
        }
        {
            let connection = database.0.lock().map_err(CommandError::database)?;
            super::account::check_account_session(&connection, &expected_account_session)?;
            ensure_active(&connection, &active, folder_id, uid)?;
            if read(&connection, folder_id)?.is_none() {
                return Err(CommandError::validation("收藏夹已解除关联"));
            }
        }
        // A missing membership already satisfies a removal. A cached resource
        // without an aid cannot safely be sent as a mutation.
        let result = match aids.get(bvid.as_str()).copied() {
            Some(aid) if aid > 0 => provider
                .change_favorite_video(folder_id, aid, false)
                .await
                .map_err(|cause| {
                    let restricted = cause.is_request_restricted();
                    let message = CommandError::bilibili(cause).message;
                    if restricted {
                        deferred = Some(message.clone());
                    }
                    message
                }),
            Some(_) => Err("未获取到视频编号".into()),
            None => Ok(()),
        };
        match result {
            Ok(()) => removed.push(bvid),
            Err(message) => failed.push(LinkedRemovalFailure { bvid, message }),
        }
    }
    let refreshed = if removed.is_empty() || deferred.is_some() {
        None
    } else {
        // Refresh once. Membership reads can lag behind a successful mutation.
        pull_videos(&database, &active, &provider, folder_id, priority, |_| {})
            .await
            .ok()
    };
    let connection = database.0.lock().map_err(CommandError::database)?;
    super::account::check_account_session(&connection, &expected_account_session)?;
    ensure_active(&connection, &active, folder_id, uid)?;
    let current = read(&connection, folder_id)?
        .ok_or_else(|| CommandError::validation("收藏夹已解除关联"))?;
    let folder = if removed.is_empty() {
        current
    } else if let Some(mut videos) = refreshed {
        videos.retain(|video| !removed.contains(&video.bvid));
        let updated = save_folder(&connection, folder, uid, videos)?;
        update.completed_refreshes.fetch_add(1, Ordering::Relaxed);
        updated
    } else {
        // Apply the confirmed removals without claiming a complete refresh.
        let mut current = current;
        current
            .videos
            .retain(|video| !removed.contains(&video.bvid));
        let encoded = serde_json::to_string(&current.videos).map_err(CommandError::database)?;
        connection
            .execute(
                "UPDATE linked_bili_folders SET videos_json=?2 WHERE folder_id=?1",
                params![folder_id, encoded],
            )
            .map_err(CommandError::database)?;
        current
    };
    Ok(LinkedRemoval {
        folder,
        removed,
        failed,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRemoval {
    folder: LinkedFolder,
    removed: Vec<String>,
    failed: Vec<LinkedRemovalFailure>,
}

#[derive(Serialize)]
struct LinkedRemovalFailure {
    bvid: String,
    message: String,
}

#[tauri::command]
pub fn bili_linked_unlink(
    database: State<'_, Database>,
    folder_id: i64,
) -> Result<(), CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    connection
        .execute(
            "DELETE FROM linked_bili_folders WHERE folder_id=?1",
            [folder_id],
        )
        .map_err(CommandError::database)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refreshes_serialize_per_folder_without_blocking_other_folders() {
        let db = Database(
            std::sync::Mutex::new(Connection::open_in_memory().unwrap()),
            std::path::PathBuf::new(),
        );
        let first = folder_update(&db, 1).unwrap();
        let guard = first.lock.lock().await;
        let same = folder_update(&db, 1).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &same));
        assert!(same.lock.try_lock().is_err());
        let other = folder_update(&db, 2).unwrap();
        assert!(other.lock.try_lock().is_ok());
        drop(guard);
        assert!(same.lock.try_lock().is_ok());
    }

    fn favorite_page(bvid: &str, has_more: bool) -> FavoritePage {
        serde_json::from_value(serde_json::json!({
            "has_more": has_more,
            "medias": [{ "bvid": bvid }]
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn interrupted_pagination_keeps_the_previous_snapshot_and_restarts_at_page_one() {
        use std::cell::RefCell;

        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let folder = FavoriteFolder {
            id: 7,
            title: "Test".into(),
            media_count: 2,
        };
        let old = favorite_page("BV1GJ411x7h7", false).medias.unwrap();
        let snapshot = save_folder(&c, folder.clone(), 42, old).unwrap();
        let old_date = snapshot.refreshed_at;
        let requests = RefCell::new(Vec::new());
        let progress = RefCell::new(Vec::new());
        let failed = pull_video_pages(
            |page| {
                requests.borrow_mut().push(page);
                std::future::ready(match page {
                    1 => Ok(favorite_page("BV1v5wyzBESJ", true)),
                    2 => Err(CommandError::validation("限流")),
                    _ => panic!("Unexpected page"),
                })
            },
            |count| progress.borrow_mut().push(count),
        )
        .await;
        assert!(failed.is_err());
        assert_eq!(&*progress.borrow(), &[1]);
        let cached = read(&c, 7).unwrap().unwrap();
        assert_eq!(cached.refreshed_at, old_date);
        assert_eq!(cached.videos[0].bvid, "BV1GJ411x7h7");

        let resumed = pull_video_pages(
            |page| {
                requests.borrow_mut().push(page);
                let bvid = match page {
                    1 => "BV1uU3v62ENe",
                    2 => "BV1v5wyzBESJ",
                    _ => panic!("Unexpected page"),
                };
                std::future::ready(Ok(favorite_page(bvid, page == 1)))
            },
            |_| {},
        )
        .await
        .unwrap();
        let saved = save_folder(&c, folder, 42, resumed).unwrap();
        assert_eq!(&*requests.borrow(), &[1, 2, 1, 2]);
        assert_eq!(
            saved
                .videos
                .iter()
                .map(|v| v.bvid.as_str())
                .collect::<Vec<_>>(),
            ["BV1uU3v62ENe", "BV1v5wyzBESJ"]
        );
    }

    #[tokio::test]
    async fn stale_refresh_session_cannot_even_reuse_a_snapshot_of_the_same_account() {
        let connection = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&connection).unwrap();
        let db = Database(std::sync::Mutex::new(connection), std::path::PathBuf::new());
        let old_account_session = {
            let connection = db.0.lock().unwrap();
            save_folder(
                &connection,
                FavoriteFolder {
                    id: 7,
                    title: "Test".into(),
                    media_count: 0,
                },
                42,
                vec![],
            )
            .unwrap();
            let old_account_session = account_session(&connection).unwrap();
            connection
                .execute_batch("DROP TABLE temp.account_session")
                .unwrap();
            old_account_session
        };
        let error = refresh_folder(&db, 7, false, &old_account_session, true, |_| {})
            .await
            .err()
            .unwrap();
        assert_eq!(error.message, "ACCOUNT_SESSION_EXPIRED");
        let current_session = account_session(&db.0.lock().unwrap()).unwrap();
        let cached = refresh_folder(&db, 7, false, &current_session, true, |_| {})
            .await
            .unwrap();
        assert!(cached.refreshed_at > 0);
    }

    #[test]
    fn refreshing_a_linked_playlist_preserves_when_it_was_added() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        for id in [1, 2] {
            save_folder(
                &c,
                FavoriteFolder {
                    id,
                    title: format!("Folder {id}"),
                    media_count: 0,
                },
                42,
                vec![],
            )
            .unwrap();
            c.execute(
                "UPDATE linked_bili_folder_order SET added_at=?1 WHERE folder_id=?1",
                [id],
            )
            .unwrap();
        }
        save_folder(
            &c,
            FavoriteFolder {
                id: 1,
                title: "Renamed and refreshed".into(),
                media_count: 0,
            },
            42,
            vec![],
        )
        .unwrap();
        let lists = list_as_playlists(&c).unwrap();
        assert_eq!(lists[0].bili_folder_id, Some(2));
        assert_eq!(lists[1].added_at, 1.0);
        assert_eq!(lists[1].name, "Renamed and refreshed");
        c.execute("DELETE FROM linked_bili_folders WHERE folder_id=1", [])
            .unwrap();
        save_folder(
            &c,
            FavoriteFolder {
                id: 1,
                title: "Linked again".into(),
                media_count: 0,
            },
            42,
            vec![],
        )
        .unwrap();
        assert_eq!(list_as_playlists(&c).unwrap()[0].bili_folder_id, Some(1));
    }

    #[test]
    fn playlist_cover_tracks_the_first_cached_video() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        let save = |videos: &str| {
            connection.execute(
                "INSERT INTO linked_bili_folders(folder_id,owner_uid,name,videos_json,refreshed_at)
                 VALUES(1,2,'Test',?1,0) ON CONFLICT(folder_id) DO UPDATE SET videos_json=excluded.videos_json",
                [videos],
            ).unwrap();
            list_as_playlists(&connection).unwrap().remove(0).cover_url
        };
        assert_eq!(
            save(r#"[{"cover":"https://example.com/first.jpg"},{"cover":"https://example.com/next.jpg"}]"#).as_deref(),
            Some("https://example.com/first.jpg")
        );
        assert_eq!(
            save(r#"[{"cover":""},{"cover":"https://example.com/next.jpg"}]"#),
            None
        );
        assert_eq!(save("[]"), None);
    }

    #[test]
    fn matched_covers_keep_multipart_artwork_on_its_exact_part() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let single = "BV1GJ411x7h7";
        let multi = "BV1v5wyzBESJ";
        let legacy = "BV1uU3v62ENe";
        let unrelated = "BV1Thsr68Edj";
        let add = |bvid: &str, cid: i64, count: Option<i64>, cover: Option<&str>| {
            let id = format!("bilibili:{bvid}:{cid}");
            c.execute(
                "INSERT INTO source_items(id, provider, bvid, cid) VALUES(?1, 'bilibili', ?2, ?3)",
                params![id, bvid, cid],
            )
            .unwrap();
            c.execute(
                "INSERT INTO tracks(id, source_item_id, title, cover_url) VALUES(?1, ?1, '源视频', 'https://example.com/video.jpg')",
                [&id],
            )
            .unwrap();
            if let Some(count) = count {
                c.execute(
                    "INSERT INTO source_title_cache(track_id, video_title, part_title, part_count) VALUES(?1, '源视频', '分 P', ?2)",
                    params![id, count],
                )
                .unwrap();
            }
            if let Some(cover) = cover {
                c.execute(
                    "INSERT INTO metadata_overrides(track_id, cover_url) VALUES(?1, ?2)",
                    params![id, cover],
                )
                .unwrap();
            }
        };
        let single_art = "https://example.com/single.jpg";
        let part_art = "https://example.com/part.jpg";
        add(single, 1, Some(1), Some(single_art));
        add(single, 0, None, Some(part_art));
        add(multi, 2, Some(3), Some(part_art));
        add(multi, 3, Some(3), None);
        add(legacy, 4, None, Some(part_art));
        add(unrelated, 1, Some(1), Some(part_art));
        let found = matched_covers(
            &c,
            &[single.into(), multi.into(), legacy.into(), single.into()],
        )
        .unwrap()
        .into_iter()
        .map(|cover| {
            (
                cover.bvid,
                (cover.track_id, cover.cover_url, cover.single_part),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            found,
            std::collections::BTreeMap::from([
                (
                    single.to_owned(),
                    (format!("bilibili:{single}:1"), single_art.to_owned(), true)
                ),
                (
                    multi.to_owned(),
                    (format!("bilibili:{multi}:2"), part_art.to_owned(), false)
                ),
                (
                    legacy.to_owned(),
                    (format!("bilibili:{legacy}:4"), part_art.to_owned(), false)
                ),
            ])
        );

        add(single, 5, Some(2), None);
        let result = matched_covers(&c, &[single.into()]).unwrap();
        assert_eq!(result.len(), 1);
        assert!(!result[0].single_part);
        assert!(matched_covers(&c, &[]).unwrap().is_empty());

        c.execute(
            "INSERT INTO metadata_overrides(track_id,title,artist,album) VALUES(?1,'更正歌名','歌手','专辑')",
            [format!("bilibili:{multi}:3")],
        )
        .unwrap();
        let result = matched_covers(&c, &[multi.into()]).unwrap();
        let edited_id = format!("bilibili:{multi}:3");
        let part = result.iter().find(|part| part.track_id == edited_id).unwrap();
        assert_eq!(part.title.as_deref(), Some("更正歌名"));
        assert_eq!(part.artist.as_deref(), Some("歌手"));
        assert_eq!(part.album.as_deref(), Some("专辑"));
        assert!(part.cover_url.is_empty());
        assert!(!part.single_part);
    }
}
