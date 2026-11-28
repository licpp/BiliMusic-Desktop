use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedFeedback {
    pub local_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
    pub created_at: String,
}

pub struct PendingFeedback {
    pub local_id: String,
    pub tracking_key: String,
    pub is_new: bool,
}

// This table lives in the active profile database and is never read by sync or export.
fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS feedback_tracking (
            local_id TEXT PRIMARY KEY NOT NULL,
            tracking_key TEXT NOT NULL UNIQUE,
            pending_fingerprint TEXT UNIQUE,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            receipt_id TEXT
        );",
    )
}

pub fn pending(
    connection: &Connection,
    fingerprint: &str,
) -> rusqlite::Result<Option<PendingFeedback>> {
    initialize(connection)?;
    connection
        .query_row(
            "SELECT local_id, tracking_key FROM feedback_tracking WHERE pending_fingerprint = ?1",
            [fingerprint],
            |row| {
                Ok(PendingFeedback {
                    local_id: row.get(0)?,
                    tracking_key: row.get(1)?,
                    is_new: false,
                })
            },
        )
        .optional()
}

pub fn insert_pending(
    connection: &Connection,
    pending: &PendingFeedback,
    fingerprint: &str,
    title: &str,
) -> rusqlite::Result<()> {
    initialize(connection)?;
    connection.execute(
        "INSERT INTO feedback_tracking(local_id, tracking_key, pending_fingerprint, title) VALUES(?1, ?2, ?3, ?4)",
        params![pending.local_id, pending.tracking_key, fingerprint, title],
    )?;
    Ok(())
}

pub fn list(connection: &Connection) -> rusqlite::Result<Vec<TrackedFeedback>> {
    initialize(connection)?;
    let mut query = connection.prepare(
        "SELECT local_id, receipt_id, title, created_at FROM feedback_tracking ORDER BY created_at DESC, rowid DESC",
    )?;
    query
        .query_map([], |row| {
            Ok(TrackedFeedback {
                local_id: row.get(0)?,
                id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .collect()
}

pub fn key(connection: &Connection, local_id: &str) -> rusqlite::Result<Option<String>> {
    initialize(connection)?;
    connection
        .query_row(
            "SELECT tracking_key FROM feedback_tracking WHERE local_id = ?1",
            [local_id],
            |row| row.get(0),
        )
        .optional()
}

pub fn confirm(connection: &Connection, local_id: &str, id: &str) -> rusqlite::Result<bool> {
    let updated = connection.execute(
        "UPDATE feedback_tracking SET receipt_id = ?2, pending_fingerprint = NULL
         WHERE local_id = ?1 AND receipt_id IS NULL",
        params![local_id, id],
    )?;
    if updated == 1 {
        return Ok(true);
    }
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM feedback_tracking WHERE local_id = ?1 AND receipt_id = ?2)",
        params![local_id, id],
        |row| row.get(0),
    )
}

pub fn forget_pending(connection: &Connection, local_id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM feedback_tracking WHERE local_id = ?1 AND receipt_id IS NULL",
        [local_id],
    )?;
    Ok(())
}
