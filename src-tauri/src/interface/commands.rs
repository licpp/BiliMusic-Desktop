use crate::infrastructure::database::Database;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    app: &'static str,
    database: &'static str,
    schema_version: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    tracks: i64,
    playlists: i64,
    favorites: i64,
}

#[tauri::command]
pub fn app_health(database: State<'_, Database>) -> Result<Health, String> {
    let connection = database.0.lock().map_err(|_| "database lock poisoned")?;
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(Health { app: "ready", database: "ready", schema_version })
}

#[tauri::command]
pub fn library_summary(database: State<'_, Database>) -> Result<LibrarySummary, String> {
    let connection = database.0.lock().map_err(|_| "database lock poisoned")?;
    let count = |table: &str| {
        connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0))
    };
    Ok(LibrarySummary {
        tracks: count("tracks").map_err(|error| error.to_string())?,
        playlists: count("playlists").map_err(|error| error.to_string())?,
        favorites: count("favorites").map_err(|error| error.to_string())?,
    })
}
