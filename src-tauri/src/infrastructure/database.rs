use super::repositories::auth::AuthRepository;
use rusqlite::Connection;
use std::io::ErrorKind;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct Database(pub Mutex<Connection>, pub std::path::PathBuf);

pub fn account_session(c: &Connection) -> rusqlite::Result<String> {
    c.execute_batch("CREATE TEMP TABLE IF NOT EXISTS account_session(token TEXT NOT NULL); INSERT INTO account_session SELECT lower(hex(randomblob(16))) WHERE NOT EXISTS(SELECT 1 FROM account_session);")?;
    c.query_row("SELECT token FROM account_session", [], |r| r.get(0))
}

impl Database {
    pub fn open(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        crate::sync::request_budget::initialize(&data_dir);
        let marker = data_dir.join("active-profile");
        let pending = data_dir.join("active-profile.tmp");
        let profile = std::fs::read_to_string(&marker).unwrap_or_default();
        let mut path = profile_path(&data_dir, &profile);
        let mut connection = Connection::open(&path)?;
        super::migrations::migrate(&connection)?;
        if finish_interrupted_logout(&connection, &profile, &marker, &pending)? {
            path = profile_path(&data_dir, "");
            connection = Connection::open(&path)?;
            super::migrations::migrate(&connection)?;
        }
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
        self.switch_profile(uid, cookie, None)
    }

    pub fn switch_profile(
        &self,
        uid: Option<i64>,
        cookie: Option<&str>,
        expected_session: Option<&str>,
    ) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "数据库正忙")?;
        if let Some(expected) = expected_session {
            if account_session(&current).map_err(|e| e.to_string())? != expected {
                return Err("B 站账号已变更，请重试".into());
            }
        }
        let marker = self.1.join("active-profile");
        let temporary = self.1.join("active-profile.tmp");
        let previous = match std::fs::read_to_string(&marker) {
            Ok(profile) => profile,
            Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.to_string()),
        };
        let profile = uid
            .filter(|n| *n > 0)
            .map(|n| n.to_string())
            .unwrap_or_default();
        let path = profile_path(&self.1, &profile);
        let next = Connection::open(&path).map_err(|e| e.to_string())?;
        super::migrations::migrate(&next).map_err(|e| e.to_string())?;
        crate::sync::storage::init(&next)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        std::fs::write(&temporary, &profile).map_err(|e| e.to_string())?;
        let auth = match cookie {
            Some(_) => &next,
            None => {
                if !previous.is_empty() {
                    AuthRepository::clear(&next, "bilibili").map_err(|e| e.to_string())?;
                }
                &current
            }
        };
        let old_cookie = AuthRepository::get_cookie(auth, "bilibili").map_err(|e| e.to_string())?;
        set_bilibili_cookie(auth, cookie).map_err(|e| e.to_string())?;
        if let Err(error) = std::fs::rename(&temporary, &marker) {
            set_bilibili_cookie(auth, old_cookie.as_deref())
                .map_err(|restore| format!("{error}，恢复账号凭据失败：{restore}"))?;
            return Err(error.to_string());
        }
        *current = next;
        Ok(())
    }
}

fn profile_path(directory: &std::path::Path, profile: &str) -> std::path::PathBuf {
    if !profile.is_empty() && profile.bytes().all(|c| c.is_ascii_digit()) {
        directory.join(format!("profile-{profile}.sqlite3"))
    } else {
        directory.join("resonance.sqlite3")
    }
}

fn set_bilibili_cookie(connection: &Connection, cookie: Option<&str>) -> rusqlite::Result<()> {
    match cookie {
        Some(cookie) => AuthRepository::save_cookie(connection, "bilibili", cookie),
        None => AuthRepository::clear(connection, "bilibili"),
    }
}

// A logout stages the empty marker before removing credentials from the active
// database. If the app stops after that removal, startup finishes the switch.
fn finish_interrupted_logout(
    connection: &Connection,
    profile: &str,
    marker: &std::path::Path,
    pending: &std::path::Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    if profile.is_empty()
        || !std::fs::metadata(pending).is_ok_and(|entry| entry.is_file() && entry.len() == 0)
        || AuthRepository::get_cookie(connection, "bilibili")?.is_some()
    {
        return Ok(false);
    }
    std::fs::rename(pending, marker)?;
    Ok(true)
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
        let guest_session = account_session(&db.0.lock().unwrap()).unwrap();
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
        let first_a = account_session(&db.0.lock().unwrap()).unwrap();
        assert_ne!(guest_session, first_a);
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
        assert_ne!(first_a, account_session(&db.0.lock().unwrap()).unwrap());
        db.switch(None, None).unwrap();
        assert_ne!(
            guest_session,
            account_session(&db.0.lock().unwrap()).unwrap()
        );
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

    #[test]
    fn failed_profile_switch_leaves_the_active_cookie_and_session_intact() {
        let dir =
            std::env::temp_dir().join(format!("bilimusic-profile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let guest = Connection::open(dir.join("resonance.sqlite3")).unwrap();
        super::super::migrations::migrate(&guest).unwrap();
        let db = Database(Mutex::new(guest), dir.clone());
        db.switch(Some(42), Some("SESSDATA=original")).unwrap();
        let original = account_session(&db.0.lock().unwrap()).unwrap();
        std::fs::create_dir(dir.join("active-profile.tmp")).unwrap();
        assert!(
            db.switch_profile(Some(42), Some("SESSDATA=candidate"), Some(&original))
                .is_err()
        );
        assert!(db.switch(None, None).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("active-profile")).unwrap(),
            "42"
        );
        {
            let connection = db.0.lock().unwrap();
            assert_eq!(account_session(&connection).unwrap(), original);
            assert_eq!(
                AuthRepository::get_cookie(&connection, "bilibili")
                    .unwrap()
                    .as_deref(),
                Some("SESSDATA=original")
            );
        }
        std::fs::remove_dir(dir.join("active-profile.tmp")).unwrap();
        db.switch(None, None).unwrap();
        db.switch(Some(42), Some("SESSDATA=new")).unwrap();
        assert!(
            db.switch_profile(Some(42), Some("SESSDATA=stale"), Some(&original))
                .is_err()
        );
        assert_eq!(
            AuthRepository::get_cookie(&db.0.lock().unwrap(), "bilibili")
                .unwrap()
                .as_deref(),
            Some("SESSDATA=new")
        );
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn startup_finishes_a_logout_interrupted_after_the_cookie_removal() {
        let dir =
            std::env::temp_dir().join(format!("bilimusic-profile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let profile = Connection::open(profile_path(&dir, "42")).unwrap();
        super::super::migrations::migrate(&profile).unwrap();
        let marker = dir.join("active-profile");
        let pending = dir.join("active-profile.tmp");
        std::fs::write(&marker, "42").unwrap();
        std::fs::write(&pending, "").unwrap();
        set_bilibili_cookie(&profile, Some("SESSDATA=original")).unwrap();
        assert!(!finish_interrupted_logout(&profile, "42", &marker, &pending).unwrap());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "42");
        set_bilibili_cookie(&profile, None).unwrap();
        assert!(finish_interrupted_logout(&profile, "42", &marker, &pending).unwrap());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "");
        assert!(!pending.exists());
        drop(profile);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
