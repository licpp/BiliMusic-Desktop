use super::library::{LibraryRepository, TrackRecord};
use crate::interface::error::CommandError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    pub track_id: String,
    pub target_path: String,
    pub status: String,
    pub received_bytes: i64,
    pub total_bytes: Option<i64>,
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<TrackRecord>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloaded_tracks_resolve_even_outside_the_library_preview() {
        use super::super::library::TrackInput;
        let mut connection = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&connection).unwrap();
        for cid in 1..=501 {
            LibraryRepository::upsert(
                &mut connection,
                &TrackInput {
                    id: format!("bilibili:BVTEST00001:{cid}"),
                    bvid: "BVTEST00001".into(),
                    aid: None,
                    cid,
                    page: 1,
                    source_title: "视频标题".into(),
                    source_title_context: None,
                    title: format!("歌曲 {cid}"),
                    artist: Some("歌手".into()),
                    album: None,
                    cover_url: Some("https://example.test/cover.jpg".into()),
                    duration_seconds: 120,
                    uploader_id: None,
                    uploader_name: None,
                },
            )
            .unwrap();
        }
        let id = "bilibili:BVTEST00001:1";
        connection
            .execute(
                "UPDATE tracks SET updated_at='2000-01-01' WHERE id=?1",
                [id],
            )
            .unwrap();
        assert!(
            LibraryRepository::list(&connection, false, 500)
                .unwrap()
                .iter()
                .all(|t| t.id != id)
        );
        DownloadRepository::create(&connection, "download", id, "/tmp/song.m4a").unwrap();
        DownloadRepository::complete(&connection, "download", 123).unwrap();
        let records = DownloadRepository::list_with_tracks(&connection).unwrap();
        let record = records.iter().find(|r| r.id == "download").unwrap();
        let track = record.track.as_ref().unwrap();
        assert_eq!(track.title, "歌曲 1");
        assert_eq!(track.artist.as_deref(), Some("歌手"));
        assert_eq!(
            track.cover_url.as_deref(),
            Some("https://example.test/cover.jpg")
        );
        assert_eq!(record.status, "completed");
    }

    #[test]
    fn records_progress_and_completion() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE downloads(id TEXT PRIMARY KEY,track_id TEXT,target_path TEXT,status TEXT,received_bytes INTEGER DEFAULT 0,total_bytes INTEGER,error_message TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);").unwrap();
        DownloadRepository::create(&connection, "d1", "t1", "/tmp/a.m4a").unwrap();
        DownloadRepository::progress(&connection, "d1", 512, Some(1024)).unwrap();
        DownloadRepository::complete(&connection, "d1", 1024).unwrap();
        let rows = DownloadRepository::list(&connection).unwrap();
        assert_eq!(rows[0].status, "completed");
        assert_eq!(rows[0].received_bytes, 1024);
    }

    #[test]
    fn deletion_preserves_active_download_and_removes_duplicate_completed_rows() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE downloads(id TEXT PRIMARY KEY,track_id TEXT,target_path TEXT,status TEXT,received_bytes INTEGER DEFAULT 0,total_bytes INTEGER,error_message TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);").unwrap();
        let path =
            std::env::temp_dir().join(format!("bilimusic-test-{}.m4a", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"fixture").unwrap();
        let target = path.to_str().unwrap();
        for id in ["completed", "duplicate", "active", "failed"] {
            DownloadRepository::create(&connection, id, "track", target).unwrap();
        }
        DownloadRepository::complete(&connection, "completed", 7).unwrap();
        DownloadRepository::complete(&connection, "duplicate", 7).unwrap();
        DownloadRepository::fail(&connection, "failed", "fixture").unwrap();
        DownloadRepository::remove(&connection, "failed").unwrap();
        assert!(DownloadRepository::remove(&connection, "completed").is_err());
        assert!(path.is_file());
        DownloadRepository::complete(&connection, "active", 7).unwrap();
        DownloadRepository::remove(&connection, "completed").unwrap();
        assert!(!path.exists());
        assert!(DownloadRepository::list(&connection).unwrap().is_empty());
        DownloadRepository::remove(&connection, "completed").unwrap();
    }
}

pub struct DownloadRepository;

impl DownloadRepository {
    // Resolve by download identity, not the 500 most recently updated library tracks.
    pub fn list_with_tracks(connection: &Connection) -> rusqlite::Result<Vec<DownloadRecord>> {
        let mut records = Self::list(connection)?;
        for record in &mut records {
            record.track = LibraryRepository::get(connection, &record.track_id)?;
        }
        Ok(records)
    }
    pub fn create(
        connection: &Connection,
        id: &str,
        track_id: &str,
        path: &str,
    ) -> rusqlite::Result<()> {
        connection.execute(
            "INSERT INTO downloads(id,track_id,target_path,status) VALUES (?1,?2,?3,'queued')",
            params![id, track_id, path],
        )?;
        Ok(())
    }

    pub fn progress(
        connection: &Connection,
        id: &str,
        received: i64,
        total: Option<i64>,
    ) -> rusqlite::Result<()> {
        connection.execute("UPDATE downloads SET status='downloading',received_bytes=?2,total_bytes=?3,updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![id, received, total])?;
        Ok(())
    }

    pub fn complete(connection: &Connection, id: &str, received: i64) -> rusqlite::Result<()> {
        connection.execute("UPDATE downloads SET status='completed',received_bytes=?2,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![id, received])?;
        Ok(())
    }

    pub fn fail(connection: &Connection, id: &str, message: &str) -> rusqlite::Result<()> {
        connection.execute("UPDATE downloads SET status='failed',error_message=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?1", params![id, message])?;
        Ok(())
    }

    pub fn remove(connection: &Connection, id: &str) -> Result<(), CommandError> {
        let Some((path, status)) = connection
            .query_row(
                "SELECT target_path,status FROM downloads WHERE id=?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(CommandError::database)?
        else {
            return Ok(());
        };
        if status == "failed" {
            connection
                .execute("DELETE FROM downloads WHERE id=?1", [id])
                .map_err(CommandError::database)?;
            return Ok(());
        }
        let busy = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM downloads WHERE target_path=?1 AND status IN ('queued','downloading'))",
            [&path], |row| row.get::<_, bool>(0),
        ).map_err(CommandError::database)?;
        if status != "completed" || busy {
            return Err(CommandError::validation("文件正在下载，请完成后再删除"));
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(CommandError::validation(
                    "无法删除下载文件，请确认文件未被占用并重试",
                ));
            }
        }
        connection
            .execute(
                "DELETE FROM downloads WHERE target_path=?1 AND status='completed'",
                [&path],
            )
            .map_err(CommandError::database)?;
        Ok(())
    }

    pub fn list(connection: &Connection) -> rusqlite::Result<Vec<DownloadRecord>> {
        let mut statement = connection.prepare("SELECT id,track_id,target_path,status,received_bytes,total_bytes,error_message FROM downloads ORDER BY rowid DESC LIMIT 200")?;
        statement
            .query_map([], |row| {
                Ok(DownloadRecord {
                    id: row.get(0)?,
                    track_id: row.get(1)?,
                    target_path: row.get(2)?,
                    status: row.get(3)?,
                    received_bytes: row.get(4)?,
                    total_bytes: row.get(5)?,
                    error_message: row.get(6)?,
                    track: None,
                })
            })?
            .collect()
    }
}
