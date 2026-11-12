// N-API is only the transport. Recording and merging statistics use the same
// Rust repository and WebDAV protocol as Android, iOS, macOS and Windows.
static APP: std::sync::Mutex<Option<tauri::AppHandle>> = std::sync::Mutex::new(None);

pub fn initialize(app: tauri::AppHandle) {
    *APP.lock().unwrap() = Some(app);
}

pub async fn put_webdav(
    url: &str,
    username: &str,
    password: &str,
    payload: &[u8],
) -> Result<reqwest::StatusCode, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let app = APP
        .lock()
        .unwrap()
        .clone()
        .ok_or("鸿蒙同步上传接口未初始化")?;
    let authorization = format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    );
    let response =
        tauri_plugin_ohos_player::put_webdav(&app, url, authorization, STANDARD.encode(payload))
            .await?;
    let status = response.get("status").and_then(|s| s.as_u64()).unwrap_or(0);
    if status == 0 {
        let code = response
            .get("errorCode")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        return Err(format!(
            "坚果云上传连接中断（鸿蒙网络错误 {code}），本机数据已保留"
        ));
    }
    u16::try_from(status)
        .ok()
        .and_then(|s| reqwest::StatusCode::from_u16(s).ok())
        .ok_or_else(|| "坚果云上传响应无效".into())
}

#[napi_derive_ohos::napi]
pub fn bilimusic_ohos_state(payload: String) {
    tauri_plugin_ohos_player::publish_state(payload);
}

#[napi_derive_ohos::napi]
pub fn bilimusic_ohos_listening(payload: String) {
    tauri_plugin_ohos_player::publish_listening(payload);
}
