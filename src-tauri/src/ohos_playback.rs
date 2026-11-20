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
    let budget = crate::sync::request_budget::for_login(url, username)?;
    if let Some(budget) = &budget {
        budget.admit().await?;
    }
    let app = APP
        .lock()
        .unwrap()
        .clone()
        .ok_or("鸿蒙同步上传接口未初始化")?;
    let authorization = format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    );
    crate::sync::traffic::bridge_started(payload.len());
    let response = match tauri_plugin_ohos_player::put_webdav(
        &app,
        url,
        authorization,
        STANDARD.encode(payload),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            crate::sync::traffic::bridge_finished(None);
            return Err(error);
        }
    };
    let status = response.get("status").and_then(|s| s.as_u64()).unwrap_or(0);
    crate::sync::traffic::bridge_finished(u16::try_from(status).ok().filter(|s| *s != 0));
    if let Some(budget) = &budget {
        budget.response(
            status as u16,
            crate::sync::traffic::retry_after(response.get("retryAfter").and_then(|v| v.as_str())),
        )?;
    }
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

static RESOLVE_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[napi_derive_ohos::napi]
pub fn bilimusic_ohos_cancel_resolve() {
    RESOLVE_REQUEST.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}
#[napi_derive_ohos::napi]
pub fn bilimusic_ohos_resolve(request: u32, payload: String) {
    use std::sync::atomic::Ordering;
    let token = RESOLVE_REQUEST
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    let Some(app) = APP.lock().unwrap().clone() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let payload = serde_json::from_str::<serde_json::Value>(&payload);
        let result = match &payload {
            Ok(payload) => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    crate::native_playback::resolve_with_guard(&app, payload.clone(), || {
                        RESOLVE_REQUEST.load(Ordering::SeqCst) == token
                    }),
                )
                .await
                .unwrap_or_else(|_| Err(crate::native_playback::resolution_timeout()))
            }
            Err(_) => Err(crate::interface::error::CommandError::validation("无效的后台播放请求")),
        };
        if RESOLVE_REQUEST.load(Ordering::SeqCst) != token {
            return;
        }
        let data = crate::native_playback::resolution_response(result);
        let _ = tauri_plugin_ohos_player::resolved(&app, request, data.to_string()).await;
        if let Ok(payload) = payload {
            if let Some(lyrics) =
                crate::native_playback::lyrics::follow_up(&app, &payload, &data).await
            {
                if RESOLVE_REQUEST.load(Ordering::SeqCst) == token {
                    let _ =
                        tauri_plugin_ohos_player::resolved(&app, request, lyrics.to_string()).await;
                }
            }
        }
    });
}
