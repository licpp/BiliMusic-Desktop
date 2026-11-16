use crate::infrastructure::database::Database;
pub use crate::infrastructure::repositories::list_preferences::*;
use tauri::State;
#[tauri::command]
pub fn list_preferences(database: State<'_, Database>) -> Result<serde_json::Value, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    read(&c)
}

#[tauri::command]
pub fn list_preferences_save(
    database: State<'_, Database>,
    changes: Vec<Preference>,
) -> Result<(), String> {
    {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        save(&c, &changes)
    }
}
