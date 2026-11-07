//! Resolve native queue transitions even when WKWebView JavaScript is suspended.
use crate::infrastructure::{
    database::Database, media_proxy::MediaProxy, providers::bilibili::BilibiliProvider,
    repositories::library::TrackInput,
};
use crate::interface::commands::{library_record_play, track_playback_url};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, c_char},
    sync::OnceLock,
};
use tauri::Manager;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
pub fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
}
unsafe extern "C" {
    fn bilimusic_ios_resolved(request: i64, json: *const c_char);
}

fn input(track: &Value) -> Result<TrackInput, String> {
    let source = &track["source"];
    serde_json::from_value(json!({
        "id": track["id"], "bvid": source["bvid"], "aid": source["aid"],
        "cid": source["cid"], "page": source["page"],
        "sourceTitle": track["title"], "title": track["title"],
        "artist": track["artist"], "album": track["album"], "coverUrl": track["coverUrl"],
        "durationSeconds": track["durationSeconds"].as_f64().unwrap_or(0.0).round() as i64,
        "uploaderId": source["uploaderId"], "uploaderName": source["uploaderName"]
    }))
    .map_err(|_| "歌曲信息无效".into())
}

async fn resolve(app: &tauri::AppHandle, mut track: Value) -> Result<Value, String> {
    // Account switches share this gate. Never record an old queue item in a new account.
    let sync = app.state::<crate::sync::SyncState>();
    let _gate = sync.gate.lock().await;
    let stored =
        library_record_play(app.state::<Database>(), input(&track)?).map_err(|e| e.message)?;
    let url = track_playback_url(
        app.state::<Database>(),
        app.state::<BilibiliProvider>(),
        app.state::<MediaProxy>(),
        stored.id.clone(),
    )
    .await
    .map_err(|e| e.message)?;
    track["title"] = json!(stored.title);
    track["artist"] = json!(stored.artist);
    track["album"] = json!(stored.album);
    track["coverUrl"] = json!(stored.cover_url);
    track["durationSeconds"] = json!(stored.duration_seconds);
    track["liked"] = json!(stored.liked);
    Ok(json!({"url":url, "track":track}))
}

/// Swift owns the input C string; copy it synchronously before starting asynchronous work.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bilimusic_ios_resolve(request: i64, raw: *const c_char) {
    if raw.is_null() {
        return;
    }
    let track = unsafe { CStr::from_ptr(raw) }.to_bytes().to_vec();
    let Some(app) = APP.get().cloned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let result = match serde_json::from_slice::<Value>(&track) {
            Ok(track) => {
                match tokio::time::timeout(std::time::Duration::from_secs(20), resolve(&app, track))
                    .await
                {
                    Ok(result) => result,
                    Err(_) => Err("加载超时，请重新播放".into()),
                }
            }
            Err(_) => Err("歌曲信息无效".into()),
        };
        let json = result.unwrap_or_else(|error| json!({"error":error}));
        if let Ok(json) = CString::new(json.to_string()) {
            unsafe {
                bilimusic_ios_resolved(request, json.as_ptr());
            }
        }
    });
}
