//! Installer plans are created by trusted release checks, never by frontend URLs.
use super::updates::{self, DownloadPackage, UpdateRelease};
use std::{path::PathBuf, time::Duration};
use tauri::{Manager, State, ipc::Channel};
use tokio::sync::Mutex;
#[derive(Default)]
pub struct UpdateState(Mutex<Session>);
#[derive(Default)]
struct Session {
    release: Option<UpdateRelease>,
    plan: Option<Plan>,
    bytes: Option<Vec<u8>>,
    path: Option<PathBuf>,
}
enum Plan {
    Android(DownloadPackage),
    #[cfg(all(desktop, not(target_env = "ohos")))]
    Desktop(tauri_plugin_updater::Update),
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    phase: &'static str,
    received: u64,
    total: Option<u64>,
}
impl Progress {
    fn send(channel: &Channel<Self>, phase: &'static str, received: u64, total: Option<u64>) {
        let _ = channel.send(Self {
            phase,
            received,
            total,
        });
    }
}
impl UpdateState {
    pub async fn check(&self, app: &tauri::AppHandle) -> Result<UpdateRelease, String> {
        let mut session = self.0.try_lock().map_err(|_| "更新操作正在进行，请稍候")?;
        if session.bytes.is_some() || session.path.is_some() {
            return session.release.clone().ok_or("更新信息已失效".into());
        }
        let large = app.config().identifier == "app.bilimusic.large";
        let platform = updates::installed_platform(large);
        let checked = updates::fetch_selection(platform).await;
        #[cfg(all(desktop, not(target_env = "ohos")))]
        if let Some(target) = platform.and_then(updates::desktop_target) {
            use tauri_plugin_updater::UpdaterExt;
            for endpoint in updates::UPDATER_ENDPOINTS {
                let updater = app
                    .updater_builder()
                    .endpoints(vec![endpoint.parse().map_err(|_| "更新地址配置无效")?])
                    .map_err(|e| e.to_string())?
                    .target(target)
                    // Tauri verifies the signature. The per-target build is checked below
                    // after deserialization, where the plugin exposes the original JSON.
                    .version_comparator(|current, remote| {
                        remote.version.cmp_precedence(&current).is_ge()
                    })
                    .timeout(Duration::from_secs(5))
                    .build()
                    .map_err(|e| e.to_string())?;
                if let Ok(Some(mut update)) = updater.check().await {
                    let Some(build) = updates::desktop_build(&update.raw_json, target) else {
                        continue;
                    };
                    if !updates::allowed_download(update.download_url.as_str())
                        || update.signature.is_empty()
                        || !updates::compare_release(
                            &update.version,
                            build,
                            &app.package_info().version,
                        )
                        .is_some_and(|order| order.is_gt())
                        || !updates::desktop_matches_catalog(&checked, &update.version, build)
                    {
                        continue;
                    }
                    update.timeout = Some(Duration::from_secs(600));
                    let release = UpdateRelease {
                        version: update.version.clone(),
                        build,
                        current_build: updates::current_build(),
                        available: true,
                        installable: true,
                        request_id: Some(uuid::Uuid::new_v4().to_string()),
                        platform: platform.map(str::to_owned),
                        size: None,
                    };
                    session.plan = Some(Plan::Desktop(update));
                    session.release = Some(release.clone());
                    return Ok(release);
                }
            }
        }
        #[allow(unused_mut)]
        let (mut release, package) = checked?;
        session.plan = None;
        #[cfg(target_os = "android")]
        if updates::compare_release(&release.version, release.build, &app.package_info().version)
            .is_some_and(|order| order.is_gt())
        {
            if let Some(package) = package {
                release.installable = true;
                release.request_id = Some(uuid::Uuid::new_v4().to_string());
                session.plan = Some(Plan::Android(package));
            }
        }
        #[cfg(not(target_os = "android"))]
        let _ = package;
        session.release = Some(release.clone());
        Ok(release)
    }
}
fn valid_request(session: &Session, id: &str) -> Result<(), String> {
    if session
        .release
        .as_ref()
        .and_then(|r| r.request_id.as_deref())
        != Some(id)
    {
        Err("更新信息已失效，请重新检查更新".into())
    } else {
        Ok(())
    }
}
fn verify_download(data: &[u8], package: &DownloadPackage) -> Result<(), String> {
    let digest = ring::digest::digest(&ring::digest::SHA256, data);
    let actual = digest
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if data.len() as u64 != package.size || !actual.eq_ignore_ascii_case(&package.sha256) {
        return Err("安装包校验失败，请重新下载".into());
    }
    Ok(())
}
async fn download_apk(
    package: &DownloadPackage,
    on_progress: &Channel<Progress>,
) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| "无法初始化下载服务")?;
    let mut last = "安装包下载失败，请检查网络后重试".to_owned();
    for channel in &package.channels {
        let Some(url) = channel
            .url
            .as_deref()
            .filter(|u| updates::allowed_download(u))
        else {
            continue;
        };
        let attempt = async {
            Progress::send(on_progress, "downloading", 0, Some(package.size));
            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|_| "连接下载源失败")?
                .error_for_status()
                .map_err(|_| "下载源暂不可用")?;
            if response
                .content_length()
                .is_some_and(|size| size != package.size)
            {
                return Err("下载源返回了错误的文件".to_owned());
            }
            let mut data = Vec::new();
            let mut last_progress = std::time::Instant::now();
            while let Some(chunk) = response.chunk().await.map_err(|_| "安装包下载中断")? {
                if data.len() as u64 + chunk.len() as u64 > package.size {
                    return Err("下载文件大小异常".into());
                }
                data.extend_from_slice(&chunk);
                if last_progress.elapsed() >= Duration::from_millis(100)
                    || data.len() as u64 == package.size
                {
                    Progress::send(
                        on_progress,
                        "downloading",
                        data.len() as u64,
                        Some(package.size),
                    );
                    last_progress = std::time::Instant::now();
                }
            }
            Progress::send(
                on_progress,
                "verifying",
                data.len() as u64,
                Some(package.size),
            );
            verify_download(&data, package)?;
            Ok(data)
        }
        .await;
        match attempt {
            Ok(data) => return Ok(data),
            Err(error) => last = error,
        }
    }
    Err(last)
}
#[tauri::command]
pub async fn app_download_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
    request_id: String,
    on_progress: Channel<Progress>,
) -> Result<(), String> {
    let mut session = state.0.try_lock().map_err(|_| "更新操作正在进行，请稍候")?;
    valid_request(&session, &request_id)?;
    if session.bytes.is_some() || session.path.is_some() {
        Progress::send(&on_progress, "ready", 0, None);
        return Ok(());
    }
    let plan = session.plan.as_ref().ok_or("当前版本需前往官网下载")?;
    match plan {
        Plan::Android(package) => {
            let data = download_apk(package, &on_progress).await?;
            let folder = app
                .path()
                .app_cache_dir()
                .map_err(|_| "无法读取更新缓存目录")?
                .join("updates");
            tokio::fs::create_dir_all(&folder)
                .await
                .map_err(|_| "无法创建更新缓存")?;
            // Cache only one installer; stale sessions cannot select an old file.
            if let Ok(mut entries) = tokio::fs::read_dir(&folder).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    if entry.path().extension().is_some_and(|ext| ext == "apk") {
                        let _ = tokio::fs::remove_file(entry.path()).await;
                    }
                }
            }
            let path = folder.join(format!("{request_id}.apk"));
            tokio::fs::write(&path, &data)
                .await
                .map_err(|_| "无法保存安装包，请检查可用空间")?;
            // Statistics are best effort and include successful app downloads only.
            let package = package.clone();
            tauri::async_runtime::spawn(record_download(
                package.version,
                package.platform,
                "ota".into(),
            ));
            session.path = Some(path);
        }
        #[cfg(all(desktop, not(target_env = "ohos")))]
        Plan::Desktop(update) => {
            let mut update = update.clone();
            let mut bytes = None;
            let original = update.download_url.to_string();
            let mirror = if let Some(rest) =
                original.strip_prefix("https://github.com/licpp/BiliMusic-Desktop/")
            {
                format!("https://gitee.com/yoaker/BiliMusic-Desktop/{rest}")
            } else {
                original.replace(
                    "https://gitee.com/yoaker/BiliMusic-Desktop/",
                    "https://github.com/licpp/BiliMusic-Desktop/",
                )
            };
            let mut last = String::new();
            for url in [&original, &mirror] {
                update.download_url = url.parse().map_err(|_| "下载地址无效")?;
                let mut received = 0;
                let mut last_progress = std::time::Instant::now();
                Progress::send(&on_progress, "downloading", 0, None);
                match update
                    .download(
                        |chunk, total| {
                            received += chunk as u64;
                            if last_progress.elapsed() >= Duration::from_millis(100)
                                || total == Some(received)
                            {
                                Progress::send(&on_progress, "downloading", received, total);
                                last_progress = std::time::Instant::now();
                            }
                        },
                        || Progress::send(&on_progress, "verifying", 0, None),
                    )
                    .await
                {
                    Ok(data) => {
                        bytes = Some(data);
                        break;
                    }
                    Err(error) => last = error.to_string(),
                }
            }
            session.bytes = Some(bytes.ok_or_else(|| format!("更新下载或签名校验失败：{last}"))?);
            let release = session.release.as_ref().unwrap();
            tauri::async_runtime::spawn(record_download(
                release.version.clone(),
                release.platform.clone().unwrap_or_default(),
                "ota".into(),
            ));
        }
    }
    Progress::send(&on_progress, "ready", 0, None);
    Ok(())
}
#[tauri::command]
pub async fn app_install_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
    request_id: String,
) -> Result<String, String> {
    let session = state.0.try_lock().map_err(|_| "更新操作正在进行，请稍候")?;
    valid_request(&session, &request_id)?;
    match session.plan.as_ref().ok_or("更新信息已失效")? {
        #[cfg(all(desktop, not(target_env = "ohos")))]
        Plan::Desktop(update) => {
            update
                .install(session.bytes.as_ref().ok_or("请先完成下载")?)
                .map_err(|e| format!("安装更新失败：{e}"))?;
            app.restart();
        }
        Plan::Android(package) => {
            #[cfg(target_os = "android")]
            {
                let path = session.path.as_ref().ok_or("请先完成下载")?;
                let data = tokio::fs::read(path)
                    .await
                    .map_err(|_| "安装包已清理，请重启应用后重新下载")?;
                verify_download(&data, package)?;
                let code = updates::android_version_code(&package.version, package.build);
                return tauri_plugin_android_player::install_update(
                    &app,
                    path,
                    &package.version,
                    code,
                )
                .await;
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, package);
                Err("当前平台不支持 APK 更新".into())
            }
        }
    }
}
async fn record_download(version: String, platform: String, source: String) {
    let Ok(client) = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(3))
        .build()
    else {
        return;
    };
    let _ = client
        .post("https://bilimusic.cn/api/v1/update-download")
        .json(&serde_json::json!({"version":version,"platform":platform,"source":source}))
        .send()
        .await;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_or_truncated_apk_never_reaches_installer() {
        let bytes = b"test apk";
        let hash = ring::digest::digest(&ring::digest::SHA256, bytes)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let package = DownloadPackage {
            version: "1.0.0".into(),
            build: 1,
            platform: "android".into(),
            file: "app.apk".into(),
            size: bytes.len() as u64,
            sha256: hash,
            channels: vec![],
        };
        assert!(verify_download(bytes, &package).is_ok());
        assert!(verify_download(b"test apx", &package).is_err());
        assert!(verify_download(b"test", &package).is_err());
    }
    #[test]
    fn stale_check_cannot_install_another_plan() {
        let session = Session::default();
        assert!(valid_request(&session, "old").is_err());
    }
}
