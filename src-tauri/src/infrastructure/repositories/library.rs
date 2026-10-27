use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInput {
    pub id: String,
    pub bvid: String,
    pub aid: Option<i64>,
    pub cid: i64,
    pub page: i32,
    pub source_title: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub duration_seconds: i64,
    pub uploader_id: Option<i64>,
    pub uploader_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRecord {
    pub id: String,
    pub bvid: String,
    pub aid: Option<i64>,
    pub cid: i64,
    pub page: i32,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub duration_seconds: i64,
    pub uploader_id: Option<i64>,
    pub uploader_name: Option<String>,
    pub liked: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataPatch {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
}

pub struct LibraryRepository;

impl LibraryRepository {
    pub fn upsert(
        connection: &mut Connection,
        track: &TrackInput,
    ) -> rusqlite::Result<TrackRecord> {
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO source_items (id, provider, bvid, aid, cid, page, uploader_id, uploader_name, source_title)
             VALUES (?1, 'bilibili', ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET aid=excluded.aid, page=excluded.page, uploader_id=excluded.uploader_id,
               uploader_name=excluded.uploader_name, source_title=excluded.source_title, updated_at=CURRENT_TIMESTAMP",
            params![track.id, track.bvid, track.aid, track.cid, track.page, track.uploader_id, track.uploader_name, track.source_title],
        )?;
        transaction.execute(
            "INSERT INTO tracks (id, source_item_id, title, artist, album, cover_url, duration_seconds)
             VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
               cover_url=excluded.cover_url, duration_seconds=excluded.duration_seconds, updated_at=CURRENT_TIMESTAMP",
            params![track.id, track.title, track.artist, track.album, track.cover_url, track.duration_seconds],
        )?;
        transaction.commit()?;
        Self::get(connection, &track.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn record_play(
        connection: &mut Connection,
        track: &TrackInput,
    ) -> rusqlite::Result<TrackRecord> {
        let record = Self::upsert(connection, track)?;
        connection.execute(
            "INSERT INTO play_history (track_id) VALUES (?1)",
            params![track.id],
        )?;
        connection.execute(
            "DELETE FROM play_history WHERE id NOT IN (SELECT id FROM play_history ORDER BY played_at DESC, id DESC LIMIT 1000)",
            [],
        )?;
        Ok(record)
    }

    pub fn list(
        connection: &Connection,
        favorites_only: bool,
        limit: i64,
    ) -> rusqlite::Result<Vec<TrackRecord>> {
        let mut statement = connection.prepare(&format!(
            "{} {} {}",
            Self::select_sql(),
            if favorites_only {
                "WHERE f.track_id IS NOT NULL"
            } else {
                ""
            },
            "ORDER BY COALESCE(f.created_at, t.updated_at) DESC LIMIT ?1"
        ))?;
        statement
            .query_map(params![limit.clamp(1, 500)], Self::map_row)?
            .collect()
    }

    pub fn get(connection: &Connection, id: &str) -> rusqlite::Result<Option<TrackRecord>> {
        let sql = format!("{} WHERE t.id=?1", Self::select_sql());
        connection
            .query_row(&sql, params![id], Self::map_row)
            .optional()
    }

    pub fn saved(connection: &Connection, limit: i64) -> rusqlite::Result<Vec<TrackRecord>> {
        let mut statement = connection.prepare(&format!(
            "{} WHERE f.track_id IS NOT NULL OR EXISTS(SELECT 1 FROM playlist_items pi WHERE pi.track_id=t.id) ORDER BY t.updated_at DESC,t.id LIMIT ?1",
            Self::select_sql()
        ))?;
        statement
            .query_map(params![limit.clamp(1, 500)], Self::map_row)?
            .collect()
    }

    pub fn recent(connection: &Connection, limit: i64) -> rusqlite::Result<Vec<TrackRecord>> {
        let mut statement = connection.prepare(&format!(
            "{} JOIN (SELECT track_id,MAX(id) latest_id FROM play_history GROUP BY track_id) h ON h.track_id=t.id ORDER BY h.latest_id DESC LIMIT ?1",
            Self::select_sql()
        ))?;
        statement
            .query_map(params![limit.clamp(1, 500)], Self::map_row)?
            .collect()
    }

    pub fn toggle_favorite(connection: &Connection, id: &str) -> rusqlite::Result<bool> {
        let liked = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM favorites WHERE track_id=?1)",
            params![id],
            |row| row.get::<_, bool>(0),
        )?;
        if liked {
            Self::set_favorite(connection, id, false)?;
            Ok(false)
        } else {
            Self::set_favorite(connection, id, true)?;
            Ok(true)
        }
    }

    pub fn set_favorite(connection: &Connection, id: &str, liked: bool) -> rusqlite::Result<()> {
        if liked {
            connection.execute(
                "INSERT INTO favorites(track_id) VALUES(?1) ON CONFLICT(track_id) DO NOTHING",
                params![id],
            )?;
        } else {
            connection.execute("DELETE FROM favorites WHERE track_id=?1", params![id])?;
        }
        Ok(())
    }

    pub fn update_metadata(
        connection: &Connection,
        id: &str,
        patch: &MetadataPatch,
    ) -> rusqlite::Result<TrackRecord> {
        connection.execute(
            "INSERT INTO metadata_overrides (track_id, title, artist, album, cover_url) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(track_id) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
               cover_url=excluded.cover_url, updated_at=CURRENT_TIMESTAMP",
            params![id, patch.title.trim(), patch.artist.as_deref().map(str::trim), patch.album.as_deref().map(str::trim), patch.cover_url.as_deref().map(str::trim)],
        )?;
        Self::get(connection, id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub(crate) fn select_sql() -> &'static str {
        "SELECT t.id, s.bvid, s.aid, s.cid, s.page,
           COALESCE(NULLIF(m.title,''),t.title), COALESCE(m.artist,t.artist), COALESCE(m.album,t.album),
           COALESCE(m.cover_url,t.cover_url), t.duration_seconds, s.uploader_id, s.uploader_name,
           CASE WHEN f.track_id IS NULL THEN 0 ELSE 1 END
         FROM tracks t JOIN source_items s ON s.id=t.source_item_id
         LEFT JOIN metadata_overrides m ON m.track_id=t.id LEFT JOIN favorites f ON f.track_id=t.id"
    }

    pub(crate) fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackRecord> {
        Ok(TrackRecord {
            id: row.get(0)?,
            bvid: row.get(1)?,
            aid: row.get(2)?,
            cid: row.get(3)?,
            page: row.get(4)?,
            title: row.get(5)?,
            artist: row.get(6)?,
            album: row.get(7)?,
            cover_url: row.get(8)?,
            duration_seconds: row.get(9)?,
            uploader_id: row.get(10)?,
            uploader_name: row.get(11)?,
            liked: row.get(12)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{LibraryRepository, MetadataPatch, TrackInput};
    use rusqlite::Connection;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
        connection
    }

    fn track(cid: i64) -> TrackInput {
        TrackInput {
            id: format!("bilibili:BVTEST00001:{cid}"),
            bvid: "BVTEST00001".into(),
            aid: Some(1),
            cid,
            page: 1,
            source_title: "来源标题".into(),
            title: "原始标题".into(),
            artist: None,
            album: None,
            cover_url: None,
            duration_seconds: 120,
            uploader_id: Some(7),
            uploader_name: Some("投稿者".into()),
        }
    }

    #[test]
    fn metadata_override_is_shared_by_stable_identity() {
        let mut connection = database();
        let input = track(10);
        LibraryRepository::upsert(&mut connection, &input).unwrap();
        let updated = LibraryRepository::update_metadata(
            &connection,
            &input.id,
            &MetadataPatch {
                title: "歌曲名".into(),
                artist: Some("歌手".into()),
                album: Some("专辑".into()),
                cover_url: None,
            },
        )
        .unwrap();
        assert_eq!(updated.title, "歌曲名");
        assert_eq!(
            LibraryRepository::get(&connection, &input.id)
                .unwrap()
                .unwrap()
                .artist
                .as_deref(),
            Some("歌手")
        );
    }

    #[test]
    fn different_parts_have_independent_favorite_state() {
        let mut connection = database();
        let first = track(10);
        let second = track(11);
        LibraryRepository::upsert(&mut connection, &first).unwrap();
        LibraryRepository::upsert(&mut connection, &second).unwrap();
        assert!(LibraryRepository::toggle_favorite(&connection, &first.id).unwrap());
        assert!(
            LibraryRepository::get(&connection, &first.id)
                .unwrap()
                .unwrap()
                .liked
        );
        assert!(
            !LibraryRepository::get(&connection, &second.id)
                .unwrap()
                .unwrap()
                .liked
        );
    }

    #[test]
    fn recent_tracks_are_unique_and_ordered_by_latest_play() {
        let mut connection = database();
        let first = track(10);
        let second = track(11);
        LibraryRepository::record_play(&mut connection, &first).unwrap();
        LibraryRepository::record_play(&mut connection, &second).unwrap();
        LibraryRepository::record_play(&mut connection, &first).unwrap();
        let recent = LibraryRepository::recent(&connection, 10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].id, first.id);
        assert_eq!(recent[1].id, second.id);
    }

    #[test]
    fn saved_collection_excludes_play_only_tracks_and_deduplicates_playlists() {
        use crate::infrastructure::repositories::playlists::PlaylistRepository;
        let mut connection = database();
        let played = track(10);
        let liked = track(11);
        let in_playlist = track(12);
        LibraryRepository::record_play(&mut connection, &played).unwrap();
        LibraryRepository::upsert(&mut connection, &liked).unwrap();
        LibraryRepository::upsert(&mut connection, &in_playlist).unwrap();
        LibraryRepository::set_favorite(&connection, &liked.id, true).unwrap();
        for id in ["a", "b"] {
            PlaylistRepository::create(&connection, id, id).unwrap();
            PlaylistRepository::add_track(&connection, id, &in_playlist.id).unwrap();
        }
        let saved = LibraryRepository::saved(&connection, 500).unwrap();
        assert_eq!(saved.len(), 2);
        assert!(saved.iter().all(|item| item.id != played.id));
        assert_eq!(
            LibraryRepository::recent(&connection, 200).unwrap()[0].id,
            played.id
        );
        LibraryRepository::set_favorite(&connection, &liked.id, false).unwrap();
        assert_eq!(LibraryRepository::saved(&connection, 500).unwrap().len(), 1);
        PlaylistRepository::delete(&connection, "a").unwrap();
        assert_eq!(LibraryRepository::saved(&connection, 500).unwrap().len(), 1);
        PlaylistRepository::delete(&connection, "b").unwrap();
        assert!(
            LibraryRepository::saved(&connection, 500)
                .unwrap()
                .is_empty()
        );
        assert!(
            LibraryRepository::get(&connection, &in_playlist.id)
                .unwrap()
                .is_some()
        );
    }
}
