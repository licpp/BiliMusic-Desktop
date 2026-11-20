//! A native channel, rather than a WebView event, resolves queue transitions.
use crate::infrastructure::database::Database;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::Manager;

pub fn initialize(app: tauri::AppHandle) {
    let profile_path = app.state::<Database>().1.join("active-profile");
    let handle = app.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        #[derive(Deserialize)]
        struct Request {
            request: i64,
            payload: Value,
        }
        if let Ok(request) = body.deserialize::<Request>() {
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                if request.payload["kind"] == "lyrics" {
                    let timeline = tokio::time::timeout(
                        std::time::Duration::from_secs(12),
                        crate::native_playback::lyrics::resolve(&app, &request.payload),
                    )
                    .await
                    .ok()
                    .flatten();
                    let result = json!({"kind":"lyrics", "timeline":timeline});
                    if let Err(error) =
                        tauri_plugin_android_player::resolved(&app, request.request, &result).await
                    {
                        eprintln!("Native lyric reply failed: {error}");
                    }
                    return;
                }
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    crate::native_playback::resolve(&app, request.payload),
                )
                .await;
                let result = crate::native_playback::resolution_response(
                    result.unwrap_or_else(|_| Err(crate::native_playback::resolution_timeout())),
                );
                if let Err(error) =
                    tauri_plugin_android_player::resolved(&app, request.request, &result).await
                {
                    eprintln!("Native playback reply failed: {error}");
                }
            });
        }
        Ok(())
    });
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            tauri_plugin_android_player::observe_playback(&app, &profile_path, channel).await
        {
            eprintln!("Native playback observation failed: {error}");
        }
    });
}
