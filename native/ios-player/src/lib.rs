use tauri::{plugin::{Builder, TauriPlugin}, Manager, Runtime};

tauri::ios_plugin_binding!(init_plugin_ios_player);
struct Credentials<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn secret<R: Runtime>(app: &tauri::AppHandle<R>, key: &str, value: Option<&str>, remove: bool) -> Result<Option<String>, String> {
    let result: serde_json::Value = app.state::<Credentials<R>>().0.run_mobile_plugin("secret", serde_json::json!({ "key": key, "value": value, "remove": remove })).map_err(|_| "无法访问 iOS 钥匙串")?;
    Ok(result.get("value").and_then(|v| v.as_str()).map(str::to_owned))
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ios-player").setup(|app, api| {
        app.manage(Credentials(api.register_ios_plugin(init_plugin_ios_player)?));
        Ok(())
    }).build()
}
