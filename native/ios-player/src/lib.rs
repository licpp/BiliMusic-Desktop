use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_ios_player);
struct Credentials<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub async fn diagnostic_environment<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<serde_json::Value> {
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async("diagnostic_environment", serde_json::json!({}))
        .await
        .ok()
}

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
            serde_json::json!({ "key": key, "value": value, "remove": remove }),
        )
        .map_err(|_| "无法访问 iOS 钥匙串")?;
    Ok(result
        .get("value")
        .and_then(|v| v.as_str())
        .map(str::to_owned))
}

pub async fn export_download<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &std::path::Path,
) -> Result<(), String> {
    let _: serde_json::Value = app
        .state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async("export_download", serde_json::json!({ "path": path }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn netease_web_login<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Option<(String, String)>, String> {
    let response: serde_json::Value = app
        .state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async("netease_web_login", serde_json::json!({}))
        .await
        .map_err(|_| "无法打开网易云登录页".to_owned())?;
    if response.is_null() {
        return Ok(None);
    }
    let music_u = response
        .get("musicU")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "网易云登录没有返回有效会话".to_owned())?;
    let csrf = response
        .get("csrf")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    Ok(Some((music_u.to_owned(), csrf.to_owned())))
}

pub async fn cancel_netease_web_login<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    app.state::<Credentials<R>>()
        .0
        .run_mobile_plugin_async("cancel_netease_web_login", serde_json::json!({}))
        .await
        .map_err(|_| "无法关闭网易云登录页".to_owned())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ios-player")
        .setup(|app, api| {
            app.manage(Credentials(
                api.register_ios_plugin(init_plugin_ios_player)?,
            ));
            Ok(())
        })
        .build()
}
