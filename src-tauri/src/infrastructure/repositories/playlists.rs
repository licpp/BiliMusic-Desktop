use crate::infrastructure::repositories::library::{LibraryRepository, TrackRecord};
use rusqlite::{Connection, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub cover_url: Option<String>,
    pub track_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repositories::library::{LibraryRepository, TrackInput};

    #[test]
    fn playlist_add_is_idempotent_and_remove_is_scoped() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
        let track = TrackInput {
            id: "bilibili:BVTEST00001:1".into(),
            bvid: "BVTEST00001".into(),
            aid: Some(1),
            cid: 1,
            page: 1,
            source_title: "source".into(),
            title: "track".into(),
            artist: None,
            album: None,
            cover_url: None,
            duration_seconds: 100,
            uploader_id: None,
            uploader_name: None,
        };
        LibraryRepository::upsert(&mut connection, &track).unwrap();
        PlaylistRepository::create(&connection, "list-a", "清晨").unwrap();
        PlaylistRepository::add_track(&connection, "list-a", &track.id).unwrap();
        PlaylistRepository::add_track(&connection, "list-a", &track.id).unwrap();
        assert_eq!(
            PlaylistRepository::tracks(&connection, "list-a")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            PlaylistRepository::get(&connection, "list-a")
                .unwrap()
                .track_count,
            1
        );
        PlaylistRepository::remove_track(&connection, "list-a", &track.id).unwrap();
        assert!(
            PlaylistRepository::tracks(&connection, "list-a")
                .unwrap()
                .is_empty()
        );
    }
}

pub struct PlaylistRepository;

impl PlaylistRepository {
    pub fn create(
        connection: &Connection,
        id: &str,
        name: &str,
    ) -> rusqlite::Result<PlaylistRecord> {
        connection.execute(
            "INSERT INTO playlists(id,name) VALUES (?1,?2)",
            params![id, name.trim()],
        )?;
        Self::get(connection, id)
    }

    pub fn list(connection: &Connection) -> rusqlite::Result<Vec<PlaylistRecord>> {
        let mut statement = connection.prepare("SELECT p.id,p.name,p.description,p.cover_url,COUNT(i.track_id) FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id GROUP BY p.id ORDER BY p.updated_at DESC,p.created_at DESC")?;
        statement.query_map([], Self::map_row)?.collect()
    }

    pub fn get(connection: &Connection, id: &str) -> rusqlite::Result<PlaylistRecord> {
        connection.query_row("SELECT p.id,p.name,p.description,p.cover_url,COUNT(i.track_id) FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.id=?1 GROUP BY p.id", params![id], Self::map_row)
    }

    pub fn tracks(connection: &Connection, id: &str) -> rusqlite::Result<Vec<TrackRecord>> {
        let mut statement = connection.prepare(&format!("{} JOIN playlist_items pi ON pi.track_id=t.id WHERE pi.playlist_id=?1 ORDER BY pi.position", LibraryRepository::select_sql()))?;
        statement
            .query_map(params![id], LibraryRepository::map_row)?
            .collect()
    }

    pub fn add_track(
        connection: &Connection,
        playlist_id: &str,
        track_id: &str,
    ) -> rusqlite::Result<()> {
        connection.execute("INSERT INTO playlist_items(playlist_id,track_id,position) VALUES (?1,?2,COALESCE((SELECT MAX(position)+1 FROM playlist_items WHERE playlist_id=?1),0)) ON CONFLICT(playlist_id,track_id) DO NOTHING", params![playlist_id, track_id])?;
        connection.execute(
            "UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![playlist_id],
        )?;
        Ok(())
    }

    pub fn remove_track(
        connection: &Connection,
        playlist_id: &str,
        track_id: &str,
    ) -> rusqlite::Result<()> {
        connection.execute(
            "DELETE FROM playlist_items WHERE playlist_id=?1 AND track_id=?2",
            params![playlist_id, track_id],
        )?;
        connection.execute(
            "UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![playlist_id],
        )?;
        Ok(())
    }

    pub fn delete(connection: &Connection, id: &str) -> rusqlite::Result<()> {
        connection.execute("DELETE FROM playlists WHERE id=?1", params![id])?;
        Ok(())
    }

    fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlaylistRecord> {
        Ok(PlaylistRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            cover_url: row.get(3)?,
            track_count: row.get(4)?,
        })
    }
}
