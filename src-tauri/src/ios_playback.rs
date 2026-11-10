//! Resolve native queue transitions even when WKWebView JavaScript is suspended.
use crate::infrastructure::{
    database::Database,
    media_proxy::MediaProxy,
    providers::bilibili::{BilibiliProvider, VideoParts},
    repositories::library::{LibraryRepository, TrackInput},
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

fn current_profile(app: &tauri::AppHandle) -> String {
    std::fs::read_to_string(app.state::<Database>().1.join("active-profile")).unwrap_or_default()
}

#[unsafe(no_mangle)]
pub extern "C" fn bilimusic_ios_profile() -> *mut c_char {
    APP.get()
        .and_then(|app| CString::new(current_profile(app)).ok())
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

/// Releases a string allocated by bilimusic_ios_profile, exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bilimusic_ios_free(raw: *mut c_char) {
    if !raw.is_null() {
        drop(unsafe { CString::from_raw(raw) });
    }
}

async fn resolve(app: &tauri::AppHandle, payload: Value) -> Result<Value, String> {
    let profile = payload["profile"]
        .as_str()
        .ok_or("播放账号已变更，请重新播放")?;
    let mut track = payload["track"].clone();
    // Account switches share this gate. Never record an old queue item in a new account.
    let sync = app.state::<crate::sync::SyncState>();
    let _gate = sync.gate.lock().await;
    if profile != current_profile(app) {
        return Err("播放账号已变更，请重新播放".into());
    }
    let entry_id = track["id"].as_str().unwrap_or_default().to_owned();
    let mut parts = Vec::new();
    if track["resolveParts"].as_bool() == Some(true) {
        let source = &track["source"];
        if let Some(bvid) = source["bvid"].as_str() {
            let provider = app.state::<BilibiliProvider>();
            let resolve_parts = async {
                let aid = source["aid"].as_i64().unwrap_or_default();
                if aid <= 0 {
                    return provider.video_parts(bvid).await;
                }
                let pages = provider.video_pagelist(bvid).await?;
                Ok(VideoParts {
                    bvid: bvid.to_owned(),
                    aid,
                    title: track["videoTitle"]
                        .as_str()
                        .or_else(|| track["title"].as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    cover_url: track["coverUrl"].as_str().unwrap_or_default().to_owned(),
                    uploader_id: source["uploaderId"].as_i64().unwrap_or_default(),
                    uploader_name: source["uploaderName"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    parts: pages,
                    season: None,
                })
            };
            if let Ok(Ok(video)) =
                tokio::time::timeout(std::time::Duration::from_secs(6), resolve_parts).await
            {
                parts = video.parts.iter().map(|part| json!({
                    "id": format!("bilibili:{}:{}", video.bvid, part.cid),
                    "source": {"provider":"bilibili", "bvid":video.bvid, "cid":part.cid,
                               "page":part.page, "aid":video.aid,
                               "uploaderId":video.uploader_id, "uploaderName":video.uploader_name},
                    "title":if video.parts.len() == 1 || part.title.is_empty() { &video.title } else { &part.title },
                    "videoTitle":video.title, "partCount":video.parts.len(),
                    "coverUrl":if video.cover_url.is_empty() { &part.cover_url } else { &video.cover_url },
                    "durationSeconds":part.duration_seconds, "liked":false,
                })).collect();
                if let Some(first) = parts.first() {
                    track = first.clone();
                }
            }
        }
    }
    if track["source"]["provider"] == "bilibili"
        && track["source"]["cid"].as_i64().unwrap_or_default() <= 0
    {
        return Err("无法读取合集中的这个视频".into());
    }
    let stored =
        library_record_play(app.state::<Database>(), input(&track)?).map_err(|e| e.message)?;
    let url = track_playback_url(
        app.state::<Database>(),
        app.state::<BilibiliProvider>(),
        app.state::<MediaProxy>(),
        stored.id.clone(),
        None,
    )
    .await
    .map_err(|e| e.message)?;
    track["title"] = json!(stored.title);
    track["artist"] = json!(stored.artist);
    track["album"] = json!(stored.album);
    track["coverUrl"] = json!(stored.cover_url);
    track["durationSeconds"] = json!(stored.duration_seconds);
    track["liked"] = json!(stored.liked);
    let position = if payload["restart"].as_bool() == Some(true)
        || payload["autoResume"].as_bool() == Some(false)
    {
        0.0
    } else {
        let db = app.state::<Database>();
        let connection = db.0.lock().map_err(|_| "数据库正忙")?;
        let saved =
            LibraryRepository::playback_position(&connection, &stored.id).unwrap_or_default();
        if saved.is_finite()
            && saved >= 1.0
            && (stored.duration_seconds == 0 || saved < stored.duration_seconds as f64 - 1.0)
        {
            saved
        } else {
            0.0
        }
    };
    Ok(json!({"url":url, "track":track, "position":position, "entryId":entry_id, "parts":parts}))
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

/// Native playback reports elapsed listening time without waiting for SQLite.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bilimusic_ios_listen(raw: *const c_char) {
    if raw.is_null() {
        return;
    }
    let bytes = unsafe { CStr::from_ptr(raw) }.to_bytes().to_vec();
    let Some(app) = APP.get().cloned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if let (Some(scope), Some(id)) = (value["profile"].as_str(), value["id"].as_str()) {
                if let Some(seconds) = value["seconds"].as_f64() {
                    let _ = crate::interface::media::record(&app, scope, id, seconds).await;
                }
                if let (Some(position), Some(observed_at)) =
                    (value["position"].as_f64(), value["observedAt"].as_i64())
                {
                    crate::interface::media::save_position(
                        &app,
                        scope,
                        id,
                        position,
                        observed_at,
                        value["collectionRef"].as_str(),
                    );
                }
            }
        }
    });
}
