use crate::{
    infrastructure::database::{Database, account_session},
    sync::visibility::{Rule, rules, save},
};
use rusqlite::OptionalExtension;
use tauri::State;
#[tauri::command]
pub fn content_visibility(database: State<'_, Database>) -> Result<serde_json::Value, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    Ok(
        serde_json::json!({"session":account_session(&c).map_err(|e|e.to_string())?,"rules":rules(&c)?,"error":c.query_row("SELECT value FROM visibility_runtime WHERE key='sync_error'",[],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?}),
    )
}
#[tauri::command]
pub fn content_visibility_save(
    database: State<'_, Database>,
    expected_session: String,
    changes: Vec<Rule>,
) -> Result<(), String> {
    save(&database, &expected_session, &changes)
}
