// N-API is only the transport. Recording and merging statistics use the same
// Rust repository and WebDAV protocol as Android, iOS, macOS and Windows.
#[napi_derive_ohos::napi]
pub fn bilimusic_ohos_state(payload: String) {
    tauri_plugin_ohos_player::publish_state(payload);
}

#[napi_derive_ohos::napi]
pub fn bilimusic_ohos_listening(payload: String) {
    tauri_plugin_ohos_player::publish_listening(payload);
}
