//! Resolve native queue transitions even when WKWebView JavaScript is suspended.
use crate::infrastructure::media_proxy::MediaProxy;
use serde_json::Value;
use std::{
    ffi::{CStr, CString, c_char},
    sync::OnceLock,
};
use tauri::Manager;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
pub fn initialize(app: tauri::AppHandle) {
    let _ = APP.set(app);
}
// Called on UIKit lifecycle transitions, independently of a suspended WebView.
#[unsafe(no_mangle)]
pub extern "C" fn bilimusic_ios_media_lifecycle(background_idle: bool) {
    let Some(app) = APP.get() else { return };
    app.state::<MediaProxy>()
        .set_background_idle(background_idle);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let proxy = app.state::<MediaProxy>();
        if background_idle {
            proxy.park_if_idle().await;
        }
        // Foreground reopening is lazy: the next explicit audio/video resolve probes
        // and repairs the listener. Merely opening the app must not resume playback.
    });
}

unsafe extern "C" {
    fn bilimusic_ios_resolved(request: i64, json: *const c_char);
}

#[unsafe(no_mangle)]
pub extern "C" fn bilimusic_ios_profile() -> *mut c_char {
    APP.get()
        .and_then(|app| crate::native_playback::current_profile(app).ok())
        .and_then(|profile| CString::new(profile).ok())
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
        let payload = serde_json::from_slice::<Value>(&track);
        if let Ok(event) = &payload {
            if event["kind"] == "diagnostic" {
                crate::native_playback::record_diagnostic(&app, event);
                return;
            }
        }
        let result = match &payload {
            Ok(track) => crate::native_playback::resolve(&app, track.clone()).await,
            Err(_) => Err(crate::interface::error::CommandError::validation(
                "歌曲信息无效",
            )),
        };
        let json = crate::native_playback::resolution_response(result);
        if let Ok(json) = CString::new(json.to_string()) {
            unsafe {
                bilimusic_ios_resolved(request, json.as_ptr());
            }
        }
        if let Ok(payload) = payload {
            if let Some(lyrics) =
                crate::native_playback::lyrics::follow_up(&app, &payload, &json).await
            {
                if let Ok(lyrics) = CString::new(lyrics.to_string()) {
                    unsafe { bilimusic_ios_resolved(request, lyrics.as_ptr()) };
                }
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
            if let (Some(scope), Some(id)) =
                (value["accountSession"].as_str(), value["id"].as_str())
            {
                if let Some(seconds) = value["seconds"].as_f64() {
                    let _ = crate::interface::media::record(
                        &app,
                        scope,
                        id,
                        seconds,
                        value["observedAt"].as_i64(),
                        value["sessionId"].as_str(),
                    )
                    .await;
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

#[unsafe(no_mangle)]
pub extern "C" fn bilimusic_ios_diagnostic_exit(kind: i32, at: u64) {
    use crate::infrastructure::diagnostics::{Diagnostics, Step};
    if let Some(app) = APP.get() {
        if let Some(diagnostics) = app.try_state::<Diagnostics>() {
            diagnostics.device_failure(Step::ProcessExit, None, format!("ios_crash:{kind}"), at);
        }
    }
}
