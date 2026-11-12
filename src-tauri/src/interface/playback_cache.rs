use crate::infrastructure::{media_proxy::MediaProxy, playback_cache::CacheStatus};
use tauri::State;

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
