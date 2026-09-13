use rusqlite::{Connection, params};
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

pub struct DownloadRepository;

impl DownloadRepository {
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

    pub fn list(connection: &Connection) -> rusqlite::Result<Vec<DownloadRecord>> {
        let mut statement = connection.prepare("SELECT id,track_id,target_path,status,received_bytes,total_bytes,error_message FROM downloads ORDER BY updated_at DESC LIMIT 200")?;
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
                })
            })?
            .collect()
    }
}
