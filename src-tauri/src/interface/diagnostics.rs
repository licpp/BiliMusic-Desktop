use serde::{Deserialize, Serialize};
use tauri::Webview;

#[cfg(any(target_os = "android", target_os = "ios", target_env = "ohos"))]
use tauri::Manager;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEnvironment {
    os_name: Option<String>,
    os_version: Option<String>,
    os_build: Option<String>,
    api_level: Option<u32>,
    device_model: Option<String>,
    architecture: Option<String>,
    webview_version: Option<String>,
    webview_package: Option<String>,
}

#[tauri::command]
pub async fn diagnostic_environment(webview: Webview) -> DiagnosticEnvironment {
    #[cfg(target_os = "android")]
    let native = tauri_plugin_android_player::diagnostic_environment(webview.app_handle()).await;
    #[cfg(target_os = "ios")]
    let native = tauri_plugin_ios_player::diagnostic_environment(webview.app_handle()).await;
    #[cfg(target_env = "ohos")]
    let native = tauri_plugin_ohos_player::diagnostic_environment(webview.app_handle()).await;
    #[cfg(any(target_os = "android", target_os = "ios", target_env = "ohos"))]
    let mut environment: DiagnosticEnvironment = native
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    #[cfg(desktop)]
    let mut environment = tauri::async_runtime::spawn_blocking(desktop_environment)
        .await
        .unwrap_or_default();

    environment.architecture = Some(std::env::consts::ARCH.into());
    #[cfg(target_os = "windows")]
    {
        environment.webview_version = windows_webview_version(webview).await;
    }
    #[cfg(any(target_os = "ios", all(desktop, not(target_os = "windows"))))]
    {
        environment.webview_version = tauri::webview_version().ok();
    }
    #[cfg(all(desktop, not(target_os = "windows")))]
    drop(webview);
    environment
}

#[cfg(target_os = "windows")]
fn desktop_environment() -> DiagnosticEnvironment {
    use winreg::{
        RegKey,
        enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
    };

    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        KEY_READ | KEY_WOW64_64KEY,
    ) else {
        return DiagnosticEnvironment::default();
    };
    let build = key.get_value::<String, _>("CurrentBuildNumber").ok();
    let client = key
        .get_value::<String, _>("InstallationType")
        .ok()
        .as_deref()
        == Some("Client");
    let os_name = match build.as_deref().and_then(|value| value.parse::<u32>().ok()) {
        Some(build) if client && build >= 22000 => "Windows 11",
        Some(build) if client && build >= 10240 => "Windows 10",
        _ => "Windows",
    };
    let os_build = match (build, key.get_value::<u32, _>("UBR")) {
        (Some(build), Ok(revision)) => Some(format!("{build}.{revision}")),
        (build, _) => build,
    };
    DiagnosticEnvironment {
        os_name: Some(os_name.into()),
        os_version: key
            .get_value("DisplayVersion")
            .or_else(|_| key.get_value("ReleaseId"))
            .ok(),
        os_build,
        ..Default::default()
    }
}

#[cfg(target_os = "windows")]
async fn windows_webview_version(webview: Webview) -> Option<String> {
    use windows::{Win32::System::Com::CoTaskMemFree, core::PWSTR};

    let (send, receive) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |view| {
            let mut version = PWSTR::null();
            // The active WebView2 environment allocates this string with the COM allocator.
            let result = unsafe {
                let result = view.environment().BrowserVersionString(&mut version);
                let value = if result.is_ok() && !version.is_null() {
                    version.to_string().ok()
                } else {
                    None
                };
                CoTaskMemFree(Some(version.0.cast()));
                value
            };
            let _ = send.send(result);
        })
        .ok()?;
    receive.await.ok().flatten()
}

#[cfg(target_os = "macos")]
fn desktop_environment() -> DiagnosticEnvironment {
    let output = std::process::Command::new("/usr/bin/sw_vers").output();
    let output = output.ok().filter(|result| result.status.success());
    let Some(output) = output else {
        return DiagnosticEnvironment::default();
    };
    let values = String::from_utf8_lossy(&output.stdout);
    let read = |key| {
        values.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name == key).then(|| value.trim().to_owned())
        })
    };
    DiagnosticEnvironment {
        os_version: read("ProductVersion"),
        os_build: read("BuildVersion"),
        ..Default::default()
    }
}

#[cfg(all(desktop, not(any(target_os = "macos", target_os = "windows"))))]
fn desktop_environment() -> DiagnosticEnvironment {
    let values = std::fs::read_to_string("/etc/os-release")
        .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
        .unwrap_or_default();
    let read = |key| {
        values.lines().find_map(|line| {
            let (name, value) = line.split_once('=')?;
            (name == key).then(|| value.trim_matches(['\'', '"']).to_owned())
        })
    };
    DiagnosticEnvironment {
        os_name: read("NAME"),
        os_version: read("VERSION_ID"),
        ..Default::default()
    }
}

use crate::infrastructure::{
    database::{Database, account_session},
    diagnostics::{Area, Diagnostics, Input, Outcome, Record, Step},
};
use tauri::State;

fn checked_profile(database: &Database, expected: &str) -> Result<String, &'static str> {
    let conn = database.0.lock().map_err(|_| "诊断记录暂不可用")?;
    if account_session(&conn).map_err(|_| "诊断记录暂不可用")? != expected {
        return Err("账号已切换");
    }
    match std::fs::read_to_string(database.1.join("active-profile")) {
        Ok(profile) if profile.bytes().all(|byte| byte.is_ascii_digit()) => Ok(profile),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        _ => Err("无法读取当前诊断账号"),
    }
}

#[tauri::command]
pub fn diagnostics_record(
    database: State<'_, Database>,
    diagnostics: State<'_, Diagnostics>,
    expected_account_session: Option<String>,
    event: Input,
) -> Result<(), &'static str> {
    let profile = match event.area {
        Area::Startup if event.step == Step::WebviewReady && event.outcome == Outcome::Failed => {
            if let Some(code @ ("script_error" | "promise_rejection" | "render_error")) =
                event.code.as_deref()
            {
                diagnostics.device_failure(
                    Step::WebviewReady,
                    None,
                    code.into(),
                    crate::infrastructure::diagnostics::now_ms(),
                );
            }
            return Ok(());
        }
        Area::Startup | Area::Sync | Area::Download => return Err("诊断事件无效"),
        _ => Some(checked_profile(
            &database,
            expected_account_session.as_deref().unwrap_or_default(),
        )?),
    };
    diagnostics.record(profile, event);
    Ok(())
}

#[tauri::command]
pub async fn diagnostics_recent(
    database: State<'_, Database>,
    diagnostics: State<'_, Diagnostics>,
    expected_account_session: String,
    operation: Option<String>,
    area: Option<Area>,
) -> Result<Vec<Record>, &'static str> {
    let profile = checked_profile(&database, &expected_account_session)?;
    let records = diagnostics
        .snapshot_filtered(profile, operation, area)
        .await?;
    checked_profile(&database, &expected_account_session)?;
    Ok(records)
}

#[tauri::command]
pub async fn diagnostics_clear(
    database: State<'_, Database>,
    diagnostics: State<'_, Diagnostics>,
    expected_account_session: String,
) -> Result<(), &'static str> {
    let profile = checked_profile(&database, &expected_account_session)?;
    if !diagnostics.clear(profile).await? {
        return Err("无法清空诊断记录");
    }
    checked_profile(&database, &expected_account_session)?;
    Ok(())
}

#[tauri::command]
pub fn diagnostics_ready(_app: tauri::AppHandle, diagnostics: State<'_, Diagnostics>) {
    if !diagnostics.webview_ready() {
        return;
    }
    #[cfg(target_os = "android")]
    {
        let diagnostics = diagnostics.inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Some(info) = tauri_plugin_android_player::diagnostic_environment(&_app).await {
                if let (Some(reason), Some(at)) =
                    (info["lastExitReason"].as_u64(), info["lastExitAt"].as_u64())
                {
                    diagnostics.device_failure(
                        Step::ProcessExit,
                        None,
                        format!("android_exit:{reason}"),
                        at,
                    );
                }
            }
        });
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn diagnostics_save_report(
    webview: Webview,
    app: tauri::AppHandle,
    database: State<'_, Database>,
    diagnostics: State<'_, Diagnostics>,
    expected_account_session: String,
    operation: Option<String>,
    area: Option<Area>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let profile = checked_profile(&database, &expected_account_session)?;
    let environment = diagnostic_environment(webview).await;
    let (reply, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name("BiliMusic-diagnostics.json")
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = reply.send(path);
        });
    let Some(path) = receive.await.map_err(|_| "无法打开保存窗口")? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|_| "保存位置无效")?;
    checked_profile(&database, &expected_account_session)?;
    let mut records = diagnostics
        .snapshot_filtered(profile, operation, area)
        .await?;
    checked_profile(&database, &expected_account_session)?;
    records.reverse();
    let report = serde_json::json!({
        "schemaVersion": 1,
        "version": env!("CARGO_PKG_VERSION"),
        "build": env!("BILIMUSIC_BUILD_NUMBER"),
        "environment": environment,
        "exportedAtMs": crate::infrastructure::diagnostics::now_ms(),
        "records": records,
    });
    let json = serde_json::to_vec_pretty(&report).map_err(|_| "无法生成诊断报告")?;
    tokio::fs::write(path, json)
        .await
        .map_err(|_| "无法保存诊断报告")?;
    Ok(true)
}

#[cfg(target_os = "windows")]
pub fn observe_windows_webview(webview: tauri::WebviewWindow, diagnostics: Diagnostics) {
    use crate::infrastructure::diagnostics::{Engine, now_ms};
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
        ProcessFailedEventHandler,
    };
    let _ = webview.with_webview(move |view| unsafe {
        let Ok(core) = view.controller().CoreWebView2() else {
            return;
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                if args.ProcessFailedKind(&mut kind).is_ok() {
                    diagnostics.device_failure(
                        Step::WebviewProcess,
                        Some(Engine::Webview2),
                        format!("webview_process:{}", kind.0),
                        now_ms(),
                    );
                }
            }
            Ok(())
        }));
        // WebView2 holds the handler until its main controller closes.
        let mut token = 0;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}
