use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct Database(pub Mutex<Connection>, pub std::path::PathBuf);

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        let profile = std::fs::read_to_string(data_dir.join("active-profile")).unwrap_or_default();
        let path = if !profile.is_empty() && profile.bytes().all(|c| c.is_ascii_digit()) {
            data_dir.join(format!("profile-{profile}.sqlite3"))
        } else {
            data_dir.join("resonance.sqlite3")
        };
        let connection = Connection::open(&path)?;
        connection.execute_batch(include_str!("../../migrations/0001_initial.sql"))?;
        connection.execute("UPDATE downloads SET status='failed',error_message='上次下载被中断，可以重新下载' WHERE status IN ('queued','downloading')", [])?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        crate::sync::storage::init(&connection)?;
        Ok(Self(Mutex::new(connection), data_dir))
    }

    pub fn switch(&self, uid: Option<i64>, cookie: Option<&str>) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "数据库正忙")?;
        let profile = uid
            .filter(|n| *n > 0)
            .map(|n| n.to_string())
            .unwrap_or_default();
        let path = if profile.is_empty() {
            self.1.join("resonance.sqlite3")
        } else {
            self.1.join(format!("profile-{profile}.sqlite3"))
        };
        let next = Connection::open(&path).map_err(|e| e.to_string())?;
        next.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .map_err(|e| e.to_string())?;
        crate::sync::storage::init(&next)?;
        if let Some(cookie) = cookie {
            crate::infrastructure::repositories::auth::AuthRepository::save_cookie(
                &next, "bilibili", cookie,
            )
            .map_err(|e| e.to_string())?;
        } else {
            crate::infrastructure::repositories::auth::AuthRepository::clear(&next, "bilibili")
                .map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        std::fs::write(self.1.join("active-profile.tmp"), &profile).map_err(|e| e.to_string())?;
        std::fs::rename(
            self.1.join("active-profile.tmp"),
            self.1.join("active-profile"),
        )
        .map_err(|e| e.to_string())?;
        *current = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switching_accounts_keeps_libraries_separate_and_preserves_guest_data() {
        let dir =
            std::env::temp_dir().join(format!("bilimusic-profile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let guest = Connection::open(dir.join("resonance.sqlite3")).unwrap();
        guest
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        guest
            .execute(
                "INSERT INTO playlists(id,name) VALUES('guest','Guest data')",
                [],
            )
            .unwrap();
        let db = Database(Mutex::new(guest), dir.clone());
        db.switch(Some(42), Some("SESSDATA=test")).unwrap();
        {
            let c = db.0.lock().unwrap();
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            c.execute("INSERT INTO playlists(id,name) VALUES('a','Account A')", [])
                .unwrap();
        }
        db.switch(Some(43), Some("SESSDATA=other")).unwrap();
        assert_eq!(
            db.0.lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.switch(Some(42), Some("SESSDATA=test")).unwrap();
        assert_eq!(
            db.0.lock()
                .unwrap()
                .query_row("SELECT name FROM playlists", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Account A"
        );
        db.switch(None, None).unwrap();
        assert_eq!(
            db.0.lock()
                .unwrap()
                .query_row("SELECT name FROM playlists", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Guest data"
        );
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
