#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};
#[cfg(target_os = "android")]
struct Credentials<R: Runtime>(tauri::plugin::PluginHandle<R>);
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
