use crate::{
    infrastructure::database::Database,
    sync::chapters::{self, SavedChapter, SavedChapters},
};
use tauri::State;

#[tauri::command]
pub fn get_saved_chapters(
    database: State<'_, Database>,
    bvid: String,
    cid: i64,
) -> Result<SavedChapters, String> {
    chapters::get(&database, &bvid, cid)
}

#[tauri::command]
pub fn save_chapters(
    database: State<'_, Database>,
    bvid: String,
    cid: i64,
    session: String,
    revision: String,
    chapters: Option<Vec<SavedChapter>>,
) -> Result<SavedChapters, String> {
    chapters::save(&database, &bvid, cid, &session, &revision, chapters)
}
