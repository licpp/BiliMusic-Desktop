#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
struct Credentials<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
pub async fn diagnostic_environment<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<serde_json::Value> {
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async("diagnostic_environment", serde_json::json!({}))
        .await
        .ok()
}

#[cfg(target_os = "android")]
pub fn secret<R: Runtime>(
    app: &tauri::AppHandle<R>,
    key: &str,
    value: Option<&str>,
    remove: bool,
) -> Result<Option<String>, String> {
    let result: serde_json::Value = app
        .state::<Credentials<R>>()
        .0
        .run_mobile_plugin(
            "secret",
            serde_json::json!({"key":key,"value":value,"remove":remove}),
        )
        .map_err(|_| "无法访问 Android 安全存储")?;
    Ok(result
        .get("value")
        .and_then(|v| v.as_str())
        .map(str::to_owned))
}
#[cfg(target_os = "android")]
pub async fn observe_listening<R: Runtime>(
    app: &tauri::AppHandle<R>,
    profile_path: &std::path::Path,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async::<()>(
            "observe_listening",
            serde_json::json!({
                "profilePath": profile_path, "channel": channel
            }),
        )
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub async fn observe_playback<R: Runtime>(
    app: &tauri::AppHandle<R>,
    profile_path: &std::path::Path,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async::<()>(
            "observe_playback",
            serde_json::json!({"profilePath":profile_path,"channel":channel}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
pub async fn resolved<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: i64,
    value: &serde_json::Value,
) -> Result<(), String> {
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async::<()>(
            "resolved",
            serde_json::json!({"request":request,"data":value.to_string()}),
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
pub async fn download_destination<R: Runtime>(
    app: &tauri::AppHandle<R>,
    action: &str,
) -> Result<serde_json::Value, String> {
    let command = match action {
        "status" => "download_destination",
        "choose" => "choose_download_destination",
        "reset" => "reset_download_destination",
        _ => return Err("无效的下载目录操作".into()),
    };
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async(command, serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
pub async fn save_download<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &std::path::Path,
) -> Result<(), String> {
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async::<()>("save_download", serde_json::json!({"path":path}))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
pub async fn restore_download<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &std::path::Path,
) -> Result<bool, String> {
    let result: serde_json::Value = app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async(
            "save_download",
            serde_json::json!({"path": path, "skipExisting": true}),
        )
        .await
        .map_err(|error| error.to_string())?;
    result
        .get("saved")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "保存文件返回状态无效".into())
}

#[cfg(target_os = "android")]
pub async fn install_update<R: Runtime>(app: &tauri::AppHandle<R>, path: &std::path::Path, version: &str, version_code: Option<u64>) -> Result<String, String> {
    let result: serde_json::Value = app.state::<Credentials<R>>().0
        .run_mobile_plugin_async("install_update", serde_json::json!({"path": path, "version": version, "versionCode": version_code}))
        .await.map_err(|e| e.to_string())?;
    result.get("status").and_then(|v| v.as_str()).map(str::to_owned).ok_or_else(|| "安装器返回状态无效".into())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-player")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            _app.manage(Credentials(
                api.register_android_plugin("app.bilimusic.player", "PlayerPlugin")?,
            ));
            Ok(())
        })
        .build()
}
