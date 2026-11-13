use crate::infrastructure::database::Database;
use crate::infrastructure::providers::bilibili::{BilibiliProvider, FavoriteFolder, FavoriteVideo};
use crate::infrastructure::repositories::{auth::AuthRepository, playlists::PlaylistRecord};
use crate::interface::error::CommandError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use tauri::State;

static UPDATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

fn session(connection: &Connection) -> Result<(String, String), CommandError> {
    let cookie = AuthRepository::get_cookie(connection, "bilibili")
        .map_err(CommandError::database)?
        .ok_or_else(|| CommandError::validation("请先登录 B 站账号"))?;
    Ok((connection.path().unwrap_or_default().to_owned(), cookie))
}

async fn owned_folder(
    database: &Database,
    folder_id: i64,
) -> Result<(BilibiliProvider, (String, String), i64, FavoriteFolder), CommandError> {
    let active = session(&*database.0.lock().map_err(CommandError::database)?)?;
    // Use a fixed session for the whole operation, even if another account logs in.
    let provider = BilibiliProvider::new().map_err(CommandError::provider)?;
    provider.set_session_cookie(Some(active.1.clone())).await;
    let uid = provider
        .account_profile()
        .await
        .map_err(CommandError::provider)?
        .user_id
        .ok_or_else(|| CommandError::validation("B 站登录已失效"))?;
    let folder = provider
        .favorite_folders_for(uid)
        .await
        .map_err(CommandError::provider)?
        .into_iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| CommandError::validation("此收藏夹已不可用，或不属于当前账号"))?;
    Ok((provider, active, uid, folder))
}

fn ensure_active(
    connection: &Connection,
    active: &(String, String),
    folder_id: i64,
    uid: i64,
) -> Result<(), CommandError> {
    if session(connection)? != *active {
        return Err(CommandError::validation("账号已切换，请重新操作"));
    }
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
    provider.set_session_cookie(Some(active.1.clone())).await;
    let uid = provider
        .account_profile()
        .await
        .map_err(CommandError::provider)?
        .user_id
        .ok_or_else(|| CommandError::validation("请先登录 B 站账号"))?;
    let folder = provider
        .create_favorite_folder(name)
        .await
        .map_err(CommandError::provider)?;
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
) -> Result<Option<LinkedFolder>, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    read(&connection, folder_id)
}

async fn pull_videos(
    provider: &BilibiliProvider,
    folder_id: i64,
) -> Result<Vec<FavoriteVideo>, CommandError> {
    let mut videos = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for page in 1..=500 {
        let result = provider
            .favorite_videos(folder_id, page)
            .await
            .map_err(CommandError::provider)?;
        let items = result.medias.unwrap_or_default();
        if items.is_empty() && result.has_more {
            return Err(CommandError::validation("收藏夹返回不完整，请稍后刷新"));
        }
        for video in items {
            if super::commands::valid_bvid(&video.bvid) && seen.insert(video.bvid.clone()) {
                videos.push(video);
            }
        }
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
    let is_new = read(connection, folder.id)?.is_none();
    let encoded = serde_json::to_string(&videos).map_err(CommandError::database)?;
    connection.execute(
        "INSERT INTO linked_bili_folders(folder_id,owner_uid,name,videos_json,refreshed_at)
         VALUES(?1,?2,?3,?4,unixepoch()) ON CONFLICT(folder_id) DO UPDATE
         SET name=excluded.name,videos_json=excluded.videos_json,refreshed_at=excluded.refreshed_at",
        params![folder.id, uid, folder.title, encoded],
    ).map_err(CommandError::database)?;
    if is_new {
        connection.execute("INSERT OR IGNORE INTO linked_bili_folder_order(folder_id,added_at) VALUES(?1,(julianday('now')-2440587.5)*86400)", [folder.id]).map_err(CommandError::database)?;
    }
    read(connection, folder.id)?.ok_or_else(|| CommandError::database("未能保存收藏夹"))
}

#[tauri::command]
pub async fn bili_linked_refresh(
    database: State<'_, Database>,
    folder_id: i64,
    link: bool,
) -> Result<LinkedFolder, CommandError> {
    refresh_folder(&database, folder_id, link).await
}
async fn refresh_folder(
    database: &Database,
    folder_id: i64,
    link: bool,
) -> Result<LinkedFolder, CommandError> {
    let _operation = UPDATE.lock().await;
    let (provider, active, uid, folder) = owned_folder(database, folder_id).await?;
    let videos = pull_videos(&provider, folder_id).await?;
    let connection = database.0.lock().map_err(CommandError::database)?;
    ensure_active(&connection, &active, folder_id, uid)?;
    if !link && read(&connection, folder_id)?.is_none() {
        return Err(CommandError::validation("收藏夹已解除关联"));
    }
    save_folder(&connection, folder, uid, videos)
}

// A newly synced link initially has no Bilibili cache. Hydrate a bounded batch
// after sync; failed/offline folders remain linked and can be retried on opening.
pub(crate) async fn hydrate_synced_links(database: &Database) -> Result<usize, String> {
    let (active, folders) = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        let active = session(&c).map_err(|e| e.message)?;
        let mut q=c.prepare("SELECT folder_id FROM linked_bili_folders WHERE refreshed_at=0 ORDER BY folder_id LIMIT 5").map_err(|e|e.to_string())?;
        let ids = q
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        (active, ids)
    };
    let mut count = 0;
    for id in folders {
        // Do not start a new request against an account selected mid-hydration.
        if session(&*database.0.lock().map_err(|_| "数据库正忙")?).map_err(|e| e.message)? != active
        {
            break;
        }
        if refresh_folder(database, id, false).await.is_ok() {
            count += 1;
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
) -> Result<LinkedFolder, CommandError> {
    if !super::commands::valid_bvid(&bvid) {
        return Err(CommandError::validation("请输入有效的 BV 号"));
    }
    let _operation = UPDATE.lock().await;
    let (provider, active, uid, folder) = owned_folder(&database, folder_id).await?;
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
                .map_err(CommandError::provider)?
                .aid
        }
    };
    provider
        .change_favorite_video(folder_id, aid, add)
        .await
        .map_err(CommandError::provider)?;

    // The membership endpoint can lag briefly after a successful write.
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let videos = pull_videos(&provider, folder_id).await.map_err(|cause| {
            CommandError::provider(format!("B 站已接受操作，刷新列表失败：{}", cause.message))
        })?;
        if videos.iter().any(|video| video.bvid == bvid) == add {
            let connection = database.0.lock().map_err(CommandError::database)?;
            ensure_active(&connection, &active, folder_id, uid)?;
            if read(&connection, folder_id)?.is_none() {
                return Err(CommandError::validation("收藏夹已解除关联"));
            }
            return save_folder(&connection, folder, uid, videos);
        }
    }
    Err(CommandError::provider(
        "B 站已接受操作，收藏夹列表仍在更新，请稍后刷新",
    ))
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
}
