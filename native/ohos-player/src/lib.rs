use serde_json::Value;
use std::sync::Mutex;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

static STATE: Mutex<Option<tauri::ipc::Channel<Value>>> = Mutex::new(None);
static LISTENING: Mutex<Option<tauri::ipc::Channel<Value>>> = Mutex::new(None);

pub fn publish_state(payload: String) {
    if let Ok(value) = serde_json::from_str::<Value>(&payload) {
        let channel = STATE.lock().unwrap().clone();
        if let Some(channel) = channel {
            let _ = channel.send(value);
        }
    }
}

pub fn publish_listening(payload: String) {
    if let Ok(value) = serde_json::from_str::<Value>(&payload) {
        let channel = LISTENING.lock().unwrap().clone();
        if let Some(channel) = channel {
            let _ = channel.send(value);
        }
    }
}

#[tauri::command]
fn observe(handler: tauri::ipc::Channel<Value>) {
    *STATE.lock().unwrap() = Some(handler);
}

struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn secret<R: Runtime>(
    app: &tauri::AppHandle<R>,
    key: &str,
    value: Option<&str>,
    remove: bool,
) -> Result<Option<String>, String> {
    let result: serde_json::Value = app
        .state::<Native<R>>()
        .0
        .run_mobile_plugin(
            "secret",
            serde_json::json!({ "key": key, "value": value, "remove": remove }),
        )
        .map_err(|_| "无法访问鸿蒙安全存储")?;
    Ok(result
        .get("value")
        .and_then(|v| v.as_str())
        .map(str::to_owned))
}

pub async fn observe_listening<R: Runtime>(
    app: &tauri::AppHandle<R>,
    profile_path: &std::path::Path,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    *LISTENING.lock().unwrap() = Some(channel);
    app.state::<Native<R>>()
        .0
        .run_mobile_plugin_async::<Value>(
            "observe_listening",
            serde_json::json!({ "profilePath": profile_path }),
        )
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub async fn open_url<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) -> Result<(), String> {
    app.state::<Native<R>>()
        .0
        .run_mobile_plugin_async::<Value>("open_url", serde_json::json!({"url": url}))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ohos-player")
        .invoke_handler(tauri::generate_handler![observe])
        .setup(|app, api| {
            app.manage(Native(api.register_ohos_plugin()?));
            Ok(())
        })
        .build()
}
