use super::error::CommandError;
use crate::infrastructure::database::Database;
use crate::infrastructure::providers::bilibili::{BilibiliProvider, valid_bvid};
use crate::infrastructure::repositories::downloads::{
    DownloadRecord, DownloadRepository, RemoveDownloadError,
};
use crate::infrastructure::repositories::library::LibraryRepository;
use crate::infrastructure::repositories::loudness::LoudnessRepository;
use tauri::State;
use tokio::io::AsyncWriteExt;

#[tauri::command]
pub async fn downloads_list(
    database: State<'_, Database>,
) -> Result<Vec<DownloadRecord>, CommandError> {
    let mut records = {
        let connection = database.0.lock().map_err(CommandError::database)?;
        DownloadRepository::list_with_tracks(&connection).map_err(CommandError::database)?
    };
    tokio::task::spawn_blocking(move || {
        for record in &mut records {
            record.check_file();
        }
        records
    })
    .await
    .map_err(CommandError::database)
}

#[derive(serde::Serialize)]
struct DownloadRemovalFailure {
    id: String,
    message: String,
}

#[derive(serde::Serialize)]
pub struct DownloadRemovalResult {
    failed: Vec<DownloadRemovalFailure>,
}

#[tauri::command]
pub async fn download_remove_many(
    database: State<'_, Database>,
    download_ids: Vec<String>,
    expected_account_session: String,
) -> Result<DownloadRemovalResult, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    super::account::check_account_session(&connection, &expected_account_session)?;
    Ok(remove_downloads(&connection, download_ids))
}

fn remove_downloads(connection: &rusqlite::Connection, ids: Vec<String>) -> DownloadRemovalResult {
    let mut seen = std::collections::HashSet::new();
    let failed = ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .filter_map(|id| {
            let message = match DownloadRepository::remove(connection, &id).err()? {
                RemoveDownloadError::Database(error) => error.to_string(),
                RemoveDownloadError::InProgress => "文件正在下载，请完成后再删除".into(),
                RemoveDownloadError::FileUnavailable => {
                    "无法删除下载文件，请确认文件未被占用并重试".into()
                }
            };
            Some(DownloadRemovalFailure { id, message })
        })
        .collect();
    DownloadRemovalResult { failed }
}

#[tauri::command]
pub fn mobile_download_directory(app: tauri::AppHandle) -> Result<String, CommandError> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(CommandError::database)?
        .join("downloads");
    std::fs::create_dir_all(&directory).map_err(CommandError::database)?;
    Ok(directory.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn android_download_destination(
    app: tauri::AppHandle,
    action: String,
) -> Result<serde_json::Value, CommandError> {
    tauri_plugin_android_player::download_destination(&app, &action)
        .await
        .map_err(CommandError::provider)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn mobile_export_download(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    download_id: String,
) -> Result<(), CommandError> {
    use rusqlite::OptionalExtension;
    use tauri::Manager;
    let target: String = {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        connection
            .query_row(
                "SELECT target_path FROM downloads WHERE id=?1 AND status='completed'",
                [&download_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(CommandError::database)?
            .ok_or_else(|| CommandError::validation("找不到已下载的歌曲"))?
    };
    let directory = app
        .path()
        .app_data_dir()
        .map_err(CommandError::database)?
        .join("downloads")
        .canonicalize()
        .map_err(CommandError::database)?;
    let path = std::path::PathBuf::from(target)
        .canonicalize()
        .map_err(CommandError::database)?;
    if !path.starts_with(directory) || !path.is_file() {
        return Err(CommandError::validation("下载文件不可用"));
    }
    #[cfg(target_os = "ios")]
    return tauri_plugin_ios_player::export_download(&app, &path)
        .await
        .map_err(CommandError::database);
    #[cfg(target_os = "android")]
    tauri_plugin_android_player::save_download(&app, &path)
        .await
        .map_err(CommandError::provider)
}

#[tauri::command]
pub async fn download_track(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    track_id: String,
    bvid: String,
    cid: i64,
    title: String,
    target_directory: String,
    skip_existing: Option<bool>,
    audio_id: Option<u32>,
    export_format: Option<String>,
) -> Result<bool, CommandError> {
    use crate::infrastructure::diagnostics::{Area, Outcome, Step, Trace};
    let (expected_profile, expected_session) = {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        (
            crate::interface::media::profile(&database),
            crate::infrastructure::database::account_session(&connection)
                .map_err(CommandError::database)?,
        )
    };
    let mut trace = Trace::for_profile(&app, expected_profile.clone(), Area::Download);
    trace.event.bvid = Some(bvid.clone());
    trace.event.cid = u64::try_from(cid).ok();
    trace.event.requested_quality = audio_id;
    let mut stage = Step::Destination;
    trace.emit(stage, Outcome::Started, None);
    let operation = async {
    if !valid_bvid(&bvid) || cid <= 0 || track_id != format!("bilibili:{bvid}:{cid}") {
        return Err(CommandError::validation("无效的下载歌曲标识"));
    }
    let directory = std::path::PathBuf::from(target_directory)
        .canonicalize()
        .map_err(|_| CommandError::validation("下载目录不存在或不可访问"))?;
    if !directory.is_dir() {
        return Err(CommandError::validation("下载位置不是目录"));
    }
    #[cfg(any(target_os = "android", target_os = "ios", target_env = "ohos"))]
    {
        use tauri::Manager;
        let allowed = app
            .path()
            .app_data_dir()
            .map_err(CommandError::database)?
            .join("downloads")
            .canonicalize()
            .map_err(CommandError::database)?;
        if directory != allowed {
            return Err(CommandError::validation("移动端下载仅写入应用私有目录"));
        }
    }
    #[cfg(target_os = "android")]
    if !tauri_plugin_android_player::download_destination(&app, "status")
        .await
        .map_err(CommandError::provider)?
        .get("available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(CommandError::validation("请先选择或重新授权下载目录"));
    }

    let requested_audio = audio_id.unwrap_or(0);
    if requested_audio > 40000 {
        return Err(CommandError::validation("不支持的下载音质"));
    }
    let export_format = export_format.as_deref().unwrap_or("auto");
    if !["auto", "original", "flac"].contains(&export_format) {
        return Err(CommandError::validation("不支持的下载格式"));
    }
    let existing_file = {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        super::account::check_account_session(&connection, &expected_session)?;
        if LibraryRepository::get(&connection, &track_id)
            .map_err(CommandError::database)?
            .is_none()
        {
            return Err(CommandError::validation("请先播放歌曲再下载"));
        }
        let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM downloads WHERE track_id=?1 AND status IN ('queued','downloading'))", [&track_id], |row| row.get(0)).map_err(CommandError::database)?;
        if active {
            return Err(CommandError::validation("这首歌曲正在下载中"));
        }
        if skip_existing.unwrap_or(false) {
            DownloadRepository::existing_file(&connection, &track_id).map_err(CommandError::database)?
        } else {
            None
        }
    };
    #[cfg(not(target_os = "android"))]
    if existing_file.is_some() {
        return Ok(false);
    }
    #[cfg(target_os = "android")]
    if let Some(path) = existing_file.as_deref().map(std::path::Path::new)
        .filter(|path| path.parent() == Some(directory.as_path()))
    {
        trace.emit(stage, Outcome::Succeeded, None);
        stage = Step::Export;
        trace.emit(stage, Outcome::Started, None);
        let saved = tauri_plugin_android_player::restore_download(&app, path)
            .await
            .map_err(CommandError::provider)?;
        let connection = database.0.lock().map_err(CommandError::database)?;
        super::account::check_account_session(&connection, &expected_session)?;
        return Ok(saved);
    }
    trace.emit(stage, Outcome::Succeeded, None);
    stage = Step::Source;
    trace.emit(stage, Outcome::Started, None);
    let source = provider
        .playback_source_with_quality(&bvid, cid, requested_audio)
        .await
        .map_err(CommandError::bilibili)?;
    if requested_audio != 0 && source.quality_id != requested_audio {
        return Err(CommandError::validation(
            "当前视频或账号无法获取所选音质，请重新选择",
        ));
    }
    let loudness = provider.cached_loudness(&bvid, cid).await;
    trace.event.actual_quality = Some(source.quality_id);
    trace.event.codec = Some(source.codecs.clone());
    let lossless = source.codecs.eq_ignore_ascii_case("flac");
    if export_format == "flac" && !lossless {
        return Err(CommandError::validation(
            "当前音源没有可用的无损音轨，请选择 AAC 或其他视频",
        ));
    }
    let original_extension = audio_download_extension(&source.mime_type, &source.codecs)
        .ok_or_else(|| CommandError::validation("这个音频格式暂不支持下载"))?;
    let extract_flac = lossless && original_extension == "m4a" && export_format != "original";
    let extension = if extract_flac {
        "flac"
    } else {
        original_extension
    };
    let quality_tag = if lossless {
        "HiRes".to_owned()
    } else {
        format!("AAC-{}k", (source.bandwidth + 500) / 1000)
    };
    let target = directory.join(format!(
        "{}-{}-{}-{}.{}",
        safe_filename(&title),
        bvid,
        cid,
        quality_tag,
        extension
    ));
    let download_id = uuid::Uuid::new_v4().to_string();
    let temporary = target.with_extension(format!("{download_id}.part"));
    let converted = target.with_extension(format!("{download_id}.flac.part"));
    {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        super::account::check_account_session(&connection, &expected_session)?;
        let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM downloads WHERE track_id=?1 AND status IN ('queued','downloading'))", [&track_id], |row| row.get(0)).map_err(CommandError::database)?;
        if active {
            return Err(CommandError::validation("这首歌曲正在下载中"));
        }
        DownloadRepository::create(
            &connection,
            &download_id,
            &track_id,
            &target.to_string_lossy(),
        )
        .map_err(CommandError::database)?;
    }
    trace.emit(stage, Outcome::Succeeded, None);
    stage = Step::Transfer;
    trace.emit(stage, Outcome::Started, None);
    let result: Result<i64, Box<dyn std::error::Error + Send + Sync>> = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .user_agent("Mozilla/5.0 Resonance/0.1")
            .build()?;
        let urls = std::iter::once(source.audio_url)
            .chain(source.backup_urls)
            .collect::<Vec<_>>();
        let (mut response, _) =
            crate::infrastructure::media_proxy::fetch_upstream(&client, &urls, None)
                .await
                .map_err(std::io::Error::other)?;
        trace.event.http = Some(response.status().as_u16());
        let total = response.content_length().map(|value| value as i64);
        if let Ok(connection) = database.0.lock() {
            let _ = DownloadRepository::progress(&connection, &download_id, 0, total);
        }
        let mut file = tokio::fs::File::create(&temporary).await?;
        let mut received = 0_i64;
        let mut last_reported = 0_i64;
        while let Some(chunk) = response.chunk().await? {
            file.write_all(&chunk).await?;
            received += chunk.len() as i64;
            if received - last_reported >= 512 * 1024 {
                if let Ok(connection) = database.0.lock() {
                    let _ =
                        DownloadRepository::progress(&connection, &download_id, received, total);
                }
                last_reported = received;
            }
        }
        if received == 0 || total.is_some_and(|total| received != total) {
            return Err(std::io::Error::other("音频下载不完整，请重新下载").into());
        }
        file.flush().await?;
        drop(file);
        trace.event.bytes = Some(received as u64);
        if extract_flac {
            trace.emit(stage, Outcome::Succeeded, None);
            stage = Step::Convert;
            trace.emit(stage, Outcome::Started, None);
            let input = temporary.clone();
            let output = converted.clone();
            received = tokio::task::spawn_blocking(move || {
                crate::infrastructure::flac_export::export(&input, &output)
            })
            .await?? as i64;
            tokio::fs::rename(&converted, &target).await?;
            let _ = tokio::fs::remove_file(&temporary).await;
        } else {
            tokio::fs::rename(&temporary, &target).await?;
        }
        #[cfg(target_os = "android")]
        {
            trace.emit(stage, Outcome::Succeeded, None);
            stage = Step::Export;
            trace.emit(stage, Outcome::Started, None);
            tauri_plugin_android_player::save_download(&app, &target)
                .await
                .map_err(std::io::Error::other)?;
        }
        Ok(received)
    }
    .await;
    match result {
        Ok(received) => {
            trace.emit(stage, Outcome::Succeeded, None);
            stage = Step::Database;
            trace.emit(stage, Outcome::Started, None);
            let connection = database
                .0
                .lock()
                .map_err(|_| CommandError::database("数据库正忙"))?;
            DownloadRepository::complete(&connection, &download_id, received)
                .map_err(CommandError::database)?;
            if let Some(descriptor) = loudness.as_ref() {
                let _ = LoudnessRepository::save_for_session(
                    &connection,
                    &expected_session,
                    descriptor,
                );
            }
            Ok(true)
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary).await;
            let _ = tokio::fs::remove_file(&converted).await;
            if let Ok(connection) = database.0.lock() {
                let _ = DownloadRepository::fail(&connection, &download_id, &error.to_string());
            }
            Err(CommandError::provider(format!("下载失败: {error}")))
        }
    }
    }.await;
    match &operation {
        Ok(true) => trace.emit(stage, Outcome::Succeeded, None),
        Ok(false) => trace.emit(stage, Outcome::Skipped, None),
        Err(error) => trace.emit(
            stage,
            Outcome::Failed,
            Some(match (stage, error.code) {
                (Step::Destination, "invalid_input") => "permission_denied",
                (Step::Convert, _) => "convert_failed",
                (Step::Export, _) => "export_failed",
                (Step::Transfer, _) => "transfer_failed",
                (_, code) => code,
            }),
        ),
    }
    operation
}

// Preserve the source container. Bilibili Hi-Res is usually FLAC inside MP4:
// renaming those bytes to .flac or .mp3 does not convert the audio.
fn audio_download_extension(mime: &str, codecs: &str) -> Option<&'static str> {
    match mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "audio/mp4" | "video/mp4" | "application/mp4" => Some("m4a"),
        "audio/flac" | "audio/x-flac" => Some("flac"),
        "audio/aac" | "audio/x-aac" => Some("aac"),
        "audio/mpeg" => Some("mp3"),
        "" if codecs.starts_with("mp4a") || codecs.eq_ignore_ascii_case("flac") => Some("m4a"),
        _ => None,
    }
}

fn safe_filename(title: &str) -> String {
    let value: String = title
        .chars()
        .filter(|character| {
            !matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            ) && !character.is_control()
        })
        .take(80)
        .collect();
    let value = value.trim().trim_matches('.');
    if value.is_empty() {
        "未命名歌曲".into()
    } else {
        value.into()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn removing_all_downloads_leaves_only_active_and_reports_its_id_once() {
        use super::{DownloadRepository, remove_downloads};
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&connection).unwrap();
        connection.execute_batch("INSERT INTO source_items(id,provider,bvid,cid) VALUES ('source','bilibili','BVTEST00001',1); INSERT INTO tracks(id,source_item_id,title) VALUES ('track','source','歌曲');").unwrap();
        let path =
            std::env::temp_dir().join(format!("bilimusic-test-{}.m4a", uuid::Uuid::new_v4()));
        let missing = path.with_extension("missing");
        let active = path.with_extension("part");
        std::fs::write(&path, b"fixture").unwrap();
        for (id, target) in [
            ("saved", &path),
            ("failed", &missing),
            ("active", &active),
            ("missing", &missing),
        ] {
            DownloadRepository::create(&connection, id, "track", target.to_str().unwrap()).unwrap();
        }
        DownloadRepository::complete(&connection, "saved", 7).unwrap();
        DownloadRepository::complete(&connection, "missing", 7).unwrap();
        DownloadRepository::fail(&connection, "failed", "fixture").unwrap();

        let result = remove_downloads(
            &connection,
            ["active", "saved", "missing", "failed", "active"]
                .into_iter()
                .map(String::from)
                .collect(),
        );
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].id, "active");
        assert!(!path.exists());
        let records = DownloadRepository::list(&connection).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "active");
    }

    #[test]
    fn download_extension_preserves_the_container_even_for_lossless_audio() {
        assert_eq!(
            super::audio_download_extension("audio/mp4", "fLaC"),
            Some("m4a")
        );
        assert_eq!(
            super::audio_download_extension("audio/mp4; codecs=mp4a.40.2", "mp4a.40.2"),
            Some("m4a")
        );
        assert_eq!(
            super::audio_download_extension("audio/flac", "flac"),
            Some("flac")
        );
        assert_eq!(
            super::audio_download_extension("audio/aac", "mp4a.40.2"),
            Some("aac")
        );
        assert_eq!(
            super::audio_download_extension("text/html", "mp4a.40.2"),
            None
        );
    }
    #[test]
    fn filename_removes_cross_platform_reserved_characters() {
        assert_eq!(super::safe_filename("a/b:c*?\"<>|"), "abc");
        assert_eq!(super::safe_filename("..."), "未命名歌曲");
    }
}
