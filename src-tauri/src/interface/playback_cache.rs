use crate::infrastructure::{
    database::{Database, account_session},
    repositories::library::{LibraryRepository, TrackRecord},
};
use crate::infrastructure::{media_proxy::MediaProxy, playback_cache::CacheStatus};
use tauri::State;

#[tauri::command]
pub async fn offline_playable_tracks(
    proxy: State<'_, MediaProxy>,
    database: State<'_, Database>,
) -> Result<Vec<TrackRecord>, String> {
    let cache = proxy.cache().ok().cloned();
    let (downloads, quality, session) = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        let err = |_: rusqlite::Error| "无法读取离线音乐";
        let mut statement = c
            .prepare("SELECT track_id,target_path FROM downloads WHERE status='completed'")
            .map_err(err)?;
        let downloads = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        (
            downloads,
            super::media::preferences(&c).map_err(err)?.audio_id,
            account_session(&c).map_err(err)?,
        )
    };
    let ids = tauri::async_runtime::spawn_blocking(move || {
        let mut ids: std::collections::BTreeSet<_> = cache
            .iter()
            .flat_map(|cache| cache.complete_track_ids(quality))
            .collect();
        ids.extend(
            downloads
                .into_iter()
                .filter(|(_, path)| {
                    std::fs::metadata(path).is_ok_and(|file| file.is_file() && file.len() > 0)
                })
                .map(|(id, _)| id),
        );
        ids
    })
    .await
    .map_err(|_| "无法读取离线音乐")?;
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    if account_session(&c).ok().as_ref() != Some(&session) {
        return Ok(Vec::new());
    }
    let tracks = ids
        .into_iter()
        .map(|id| LibraryRepository::get(&c, &id))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取离线歌曲信息")?;
    Ok(tracks.into_iter().flatten().collect())
}

#[tauri::command]
pub async fn playback_cache_status(proxy: State<'_, MediaProxy>) -> Result<CacheStatus, String> {
    let cache = proxy.cache()?.clone();
    tauri::async_runtime::spawn_blocking(move || cache.status())
        .await
        .map_err(|_| "无法读取播放缓存".to_owned())?
}
#[tauri::command]
pub async fn playback_cache_limit(
    proxy: State<'_, MediaProxy>,
    megabytes: u64,
) -> Result<CacheStatus, String> {
    let cache = proxy.cache()?.clone();
    tauri::async_runtime::spawn_blocking(move || cache.set_limit(megabytes))
        .await
        .map_err(|_| "无法保存播放缓存设置".to_owned())?
}
#[tauri::command]
pub async fn playback_cache_clear(proxy: State<'_, MediaProxy>) -> Result<CacheStatus, String> {
    let cache = proxy.cache()?.clone();
    tauri::async_runtime::spawn_blocking(move || cache.clear())
        .await
        .map_err(|_| "无法清理播放缓存".to_owned())?
}
