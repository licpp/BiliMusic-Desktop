use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
use tauri::Manager;
#[cfg(target_os = "android")]
struct Credentials<R: Runtime>(tauri::plugin::PluginHandle<R>);
#[cfg(target_os = "android")]
pub fn secret<R: Runtime>(app: &tauri::AppHandle<R>, key: &str, value: Option<&str>, remove: bool) -> Result<Option<String>, String> {
    let result: serde_json::Value = app.state::<Credentials<R>>().0.run_mobile_plugin("secret",serde_json::json!({"key":key,"value":value,"remove":remove})).map_err(|_|"无法访问 Android 安全存储")?;
    Ok(result.get("value").and_then(|v|v.as_str()).map(str::to_owned))
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-player")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            _app.manage(Credentials(api.register_android_plugin("app.bilimusic.player", "PlayerPlugin")?));
            Ok(())
        })
        .build()
}
