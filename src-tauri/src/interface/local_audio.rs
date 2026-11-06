use crate::infrastructure::database::Database;
use crate::infrastructure::repositories::library::{LibraryRepository, TrackRecord};
use crate::interface::error::CommandError;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::path::Path;
use tauri::State;

pub(crate) fn audio_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    added: usize,
    already_imported: usize,
    failed: Vec<String>,
}

#[tauri::command]
pub fn local_audio_import(
    database: State<'_, Database>,
    paths: Vec<String>,
) -> Result<ImportResult, CommandError> {
    if cfg!(target_os = "android") {
        return Err(CommandError::validation("本地歌曲导入目前支持桌面端"));
    }
    if paths.len() > 500 {
        return Err(CommandError::validation("一次最多导入 500 个文件"));
    }
    let mut result = ImportResult {
        added: 0,
        already_imported: 0,
        failed: Vec::new(),
    };
    let mut connection = database.0.lock().map_err(CommandError::database)?;
    let tx = connection.transaction().map_err(CommandError::database)?;
    for path in paths {
        let filename = Path::new(&path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("未知文件");
        let Ok(canonical) = std::fs::canonicalize(&path) else {
            result.failed.push(format!("{filename}：文件无法访问"));
            continue;
        };
        if audio_mime(&canonical).is_none()
            || !canonical
                .metadata()
                .is_ok_and(|m| m.is_file() && m.len() > 0)
        {
            result
                .failed
                .push(format!("{filename}：请选择可读取的 MP3、M4A 或 WAV 文件"));
            continue;
        }
        let Some(canonical_path) = canonical.to_str() else {
            result.failed.push(format!("{filename}：无法识别文件路径"));
            continue;
        };
        if tx
            .query_row(
                "SELECT 1 FROM local_audio WHERE path=?1",
                [canonical_path],
                |_| Ok(()),
            )
            .optional()
            .map_err(CommandError::database)?
            .is_some()
        {
            result.already_imported += 1;
            continue;
        }
        let id = format!("local:{}", uuid::Uuid::new_v4());
        let title = Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("本地歌曲");
        tx.execute("INSERT INTO source_items(id,provider,bvid,cid,source_title) VALUES(?1,'local',?1,0,?2)", params![id,title]).map_err(CommandError::database)?;
        tx.execute(
            "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,?2)",
            params![id, title],
        )
        .map_err(CommandError::database)?;
        tx.execute(
            "INSERT INTO local_audio(track_id,path) VALUES(?1,?2)",
            params![id, canonical_path],
        )
        .map_err(CommandError::database)?;
        result.added += 1;
    }
    tx.commit().map_err(CommandError::database)?;
    Ok(result)
}

#[tauri::command]
pub fn local_audio_list(database: State<'_, Database>) -> Result<Vec<TrackRecord>, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    let mut query = connection
        .prepare(&format!(
            "{} WHERE s.provider='local' ORDER BY t.created_at DESC,t.id",
            LibraryRepository::select_sql()
        ))
        .map_err(CommandError::database)?;
    query
        .query_map([], LibraryRepository::map_row)
        .map_err(CommandError::database)?
        .collect::<rusqlite::Result<_>>()
        .map_err(CommandError::database)
}
