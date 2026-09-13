use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct Database(pub Mutex<Connection>);

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let connection = Connection::open(data_dir.join("resonance.sqlite3"))?;
        connection.execute_batch(include_str!("../../migrations/0001_initial.sql"))?;
        Ok(Self(Mutex::new(connection)))
    }
}
