use crate::{
    infrastructure::{
        database::{Database, account_session},
        repositories::imported_entries::{self, Change, Entry, SeedRow},
    },
    interface::error::CommandError,
};
use serde::Serialize;
use tauri::State;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    session: String,
    entries: Vec<Entry>,
}
fn checked(c: &rusqlite::Connection, session: &str) -> Result<(), CommandError> {
    if account_session(c).map_err(CommandError::database)? != session {
        return Err(CommandError::validation("账号已切换，请重新打开歌单"));
    }
    Ok(())
}
fn snapshot(c: &rusqlite::Connection, playlist: &str) -> Result<Snapshot, CommandError> {
    Ok(Snapshot {
        session: account_session(c).map_err(CommandError::database)?,
        entries: imported_entries::list(c, playlist).map_err(CommandError::validation)?,
    })
}
#[tauri::command]
pub fn playlist_import_contexts(
    database: State<'_, Database>,
    track_ids: Vec<String>,
) -> Result<Vec<Entry>, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    let ids = track_ids.into_iter().take(100).collect();
    imported_entries::track_contexts(&c, &ids).map_err(CommandError::validation)
}
#[tauri::command]
pub fn playlist_import_entries(
    database: State<'_, Database>,
    playlist_id: String,
) -> Result<Snapshot, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    imported_entries::migrate_archive(&c, &playlist_id).map_err(CommandError::validation)?;
    snapshot(&c, &playlist_id)
}
#[tauri::command]
pub fn playlist_import_seed(
    database: State<'_, Database>,
    expected_session: String,
    playlist_id: String,
    name: String,
    source: String,
    rows: Vec<SeedRow>,
) -> Result<Snapshot, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    checked(&c, &expected_session)?;
    imported_entries::seed(&c, &playlist_id, &name, &source, &rows)
        .map_err(CommandError::validation)?;
    snapshot(&c, &playlist_id)
}
#[tauri::command]
pub fn playlist_import_bind(
    database: State<'_, Database>,
    expected_session: String,
    playlist_id: String,
    changes: Vec<Change>,
) -> Result<Snapshot, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    checked(&c, &expected_session)?;
    imported_entries::bind(&c, &playlist_id, &changes).map_err(CommandError::validation)?;
    snapshot(&c, &playlist_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_session_guard_rejects_aba_even_for_the_same_database() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        let first = account_session(&c).unwrap();
        checked(&c, &first).unwrap();
        c.execute(
            "UPDATE account_session SET token=lower(hex(randomblob(16)))",
            [],
        )
        .unwrap();
        c.execute(
            "UPDATE account_session SET token=lower(hex(randomblob(16)))",
            [],
        )
        .unwrap();
        assert!(checked(&c, &first).is_err());
        checked(&c, &account_session(&c).unwrap()).unwrap();
    }
}
