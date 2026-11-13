use crate::infrastructure::repositories::library::{LibraryRepository, TrackRecord};
use rusqlite::{Connection, params};
use serde::Serialize;

pub const FAVORITES_PLAYLIST_ID: &str = "system:favorites";
const PLAYLIST_COVER: &str = "COALESCE(NULLIF(p.cover_url,''),(SELECT NULLIF(COALESCE(m.cover_url,t.cover_url),'') FROM playlist_items first_item JOIN tracks t ON t.id=first_item.track_id LEFT JOIN metadata_overrides m ON m.track_id=t.id WHERE first_item.playlist_id=p.id ORDER BY first_item.position,first_item.created_at DESC,first_item.rowid DESC LIMIT 1))";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub cover_url: Option<String>,
    pub track_count: i64,
    pub is_system: bool,
    pub added_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bili_folder_id: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repositories::library::{LibraryRepository, TrackInput};

    #[test]
    fn covers_follow_the_first_track_and_its_metadata_without_copying_urls() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
        for (index, id) in ["a", "b"].iter().enumerate() {
            c.execute(
                "INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili','BVtest',?2)",
                params![id, index + 1],
            )
            .unwrap();
            c.execute(
                "INSERT INTO tracks(id,source_item_id,title,cover_url) VALUES(?1,?1,?1,?2)",
                params![id, format!("https://cover/{id}")],
            )
            .unwrap();
        }
        PlaylistRepository::create(&c, "list", "test").unwrap();
        PlaylistRepository::add_track(&c, "list", "a").unwrap();
        PlaylistRepository::add_track(&c, "list", "b").unwrap();
        assert_eq!(
            PlaylistRepository::get(&c, "list")
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://cover/b")
        );
        c.execute("INSERT INTO metadata_overrides(track_id,title,cover_url) VALUES('b','b','https://cover/edited')",[]).unwrap();
        assert_eq!(
            PlaylistRepository::list(&c).unwrap()[1]
                .cover_url
                .as_deref(),
            Some("https://cover/edited")
        );
        LibraryRepository::set_favorite(&c, "a", true).unwrap();
        LibraryRepository::set_favorite(&c, "b", true).unwrap();
        assert_eq!(
            PlaylistRepository::get(&c, FAVORITES_PLAYLIST_ID)
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://cover/edited")
        );
        PlaylistRepository::remove_track(&c, "list", "b").unwrap();
        assert_eq!(
            PlaylistRepository::get(&c, "list")
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://cover/a")
        );
        c.execute(
            "UPDATE playlists SET cover_url='https://custom' WHERE id='list'",
            [],
        )
        .unwrap();
        assert_eq!(
            PlaylistRepository::get(&c, "list")
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://custom")
        );
        LibraryRepository::set_favorite(&c, "b", false).unwrap();
        assert_eq!(
            PlaylistRepository::get(&c, FAVORITES_PLAYLIST_ID)
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://cover/a")
        );
        LibraryRepository::set_favorite(&c, "a", false).unwrap();
        assert!(
            PlaylistRepository::get(&c, FAVORITES_PLAYLIST_ID)
                .unwrap()
                .cover_url
                .is_none()
        );
    }

    #[test]
    fn default_favorites_playlist_shares_hearts_and_cannot_be_deleted_or_renamed() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
        connection.execute_batch("INSERT INTO source_items(id,provider,bvid,cid) VALUES('song','bilibili','BVTEST00001',1); INSERT INTO tracks(id,source_item_id,title) VALUES('song','song','Song')").unwrap();
        let playlists = PlaylistRepository::list(&connection).unwrap();
        assert_eq!(playlists[0].id, FAVORITES_PLAYLIST_ID);
        assert!(playlists[0].is_system);
        assert_eq!(playlists[0].track_count, 0);
        PlaylistRepository::add_track(&connection, FAVORITES_PLAYLIST_ID, "song").unwrap();
        PlaylistRepository::add_track(&connection, FAVORITES_PLAYLIST_ID, "song").unwrap();
        assert!(
            LibraryRepository::get(&connection, "song")
                .unwrap()
                .unwrap()
                .liked
        );
        assert_eq!(
            PlaylistRepository::get(&connection, FAVORITES_PLAYLIST_ID)
                .unwrap()
                .track_count,
            1
        );
        assert_eq!(
            PlaylistRepository::tracks(&connection, FAVORITES_PLAYLIST_ID)
                .unwrap()
                .len(),
            1
        );
        assert!(PlaylistRepository::delete(&connection, FAVORITES_PLAYLIST_ID).is_err());
        assert!(PlaylistRepository::rename(&connection, FAVORITES_PLAYLIST_ID, "Changed").is_err());
        LibraryRepository::toggle_favorite(&connection, "song").unwrap();
        assert!(
            PlaylistRepository::tracks(&connection, FAVORITES_PLAYLIST_ID)
                .unwrap()
                .is_empty()
        );
        LibraryRepository::toggle_favorite(&connection, "song").unwrap();
        PlaylistRepository::remove_track(&connection, FAVORITES_PLAYLIST_ID, "song").unwrap();
        PlaylistRepository::remove_track(&connection, FAVORITES_PLAYLIST_ID, "song").unwrap();
        assert!(
            !LibraryRepository::get(&connection, "song")
                .unwrap()
                .unwrap()
                .liked
        );
        assert_eq!(
            PlaylistRepository::list(&connection).unwrap()[0].name,
            "我喜欢"
        );
    }

    #[test]
    fn explicit_additions_prepend_in_selection_order_without_duplicates() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
        for (i, id) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
            c.execute("INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili','BVFIXTURE',?2)", params![id,i as i64+1]).unwrap();
            c.execute(
                "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,?1)",
                [id],
            )
            .unwrap();
        }
        PlaylistRepository::create(&c, "list", "歌单").unwrap();
        let add = |ids: &[&str], append| {
            PlaylistRepository::add_tracks(
                &c,
                "list",
                &ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                append,
            )
            .unwrap()
        };
        let ids = || {
            PlaylistRepository::tracks(&c, "list")
                .unwrap()
                .into_iter()
                .map(|t| t.id)
                .collect::<Vec<_>>()
        };
        add(&["a", "b"], false);
        PlaylistRepository::add_track(&c, "list", "c").unwrap();
        add(&["d", "e", "c", "d"], false);
        assert_eq!(ids(), vec!["d", "e", "c", "a", "b"]);
        add(&["f"], true);
        assert_eq!(ids(), vec!["d", "e", "c", "a", "b", "f"]);
        assert!(PlaylistRepository::add_tracks(&c, "list", &["missing".into()], false).is_err());
        assert_eq!(ids(), vec!["d", "e", "c", "a", "b", "f"]);
        add(&["a", "d", "a"], false);
        add(&["e"], true);
        assert_eq!(ids(), vec!["a", "d", "e", "c", "b", "f"]);
        PlaylistRepository::add_tracks(&c, FAVORITES_PLAYLIST_ID, &["b".into(), "a".into()], false)
            .unwrap();
        PlaylistRepository::add_track(&c, FAVORITES_PLAYLIST_ID, "c").unwrap();
        assert_eq!(
            PlaylistRepository::tracks(&c, FAVORITES_PLAYLIST_ID)
                .unwrap()
                .into_iter()
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            vec!["c", "b", "a"]
        );
        PlaylistRepository::create(&c, "new", "新歌单").unwrap();
        c.execute("UPDATE playlists SET created_at='2020-01-01 00:00:00',updated_at='2099-01-01 00:00:00' WHERE id='list'",[]).unwrap();
        assert_eq!(PlaylistRepository::list(&c).unwrap()[1].id, "new");
    }

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
        Self::ensure_custom(id)?;
        connection.execute(
            "INSERT INTO playlists(id,name,created_at) VALUES (?1,?2,strftime('%Y-%m-%d %H:%M:%f','now'))",
            params![id, name.trim()],
        )?;
        Self::get(connection, id)
    }

    pub fn list(connection: &Connection) -> rusqlite::Result<Vec<PlaylistRecord>> {
        let mut statement = connection.prepare(&format!("SELECT p.id,p.name,p.description,{PLAYLIST_COVER},COUNT(i.track_id),COALESCE((julianday(p.created_at)-2440587.5)*86400,0) FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id GROUP BY p.id ORDER BY p.created_at DESC,p.rowid DESC"))?;
        let mut playlists = vec![Self::get(connection, FAVORITES_PLAYLIST_ID)?];
        playlists.extend(
            statement
                .query_map([], Self::map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
        Ok(playlists)
    }

    pub fn get(connection: &Connection, id: &str) -> rusqlite::Result<PlaylistRecord> {
        if id == FAVORITES_PLAYLIST_ID {
            return Ok(PlaylistRecord {
                id: id.into(),
                name: "我喜欢".into(),
                description: "点击红心收藏的歌曲 · 默认歌单".into(),
                cover_url: connection.query_row("SELECT (SELECT NULLIF(COALESCE(m.cover_url,t.cover_url),'') FROM favorites f JOIN tracks t ON t.id=f.track_id LEFT JOIN metadata_overrides m ON m.track_id=t.id ORDER BY f.created_at DESC,f.rowid DESC LIMIT 1)",[],|row|row.get(0))?,
                track_count: connection
                    .query_row("SELECT COUNT(*) FROM favorites", [], |row| row.get(0))?,
                is_system: true,
                added_at: 0.0,
                bili_folder_id: None,
            });
        }
        connection.query_row(&format!("SELECT p.id,p.name,p.description,{PLAYLIST_COVER},COUNT(i.track_id),COALESCE((julianday(p.created_at)-2440587.5)*86400,0) FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id WHERE p.id=?1 GROUP BY p.id"), params![id], Self::map_row)
    }

    pub fn tracks(connection: &Connection, id: &str) -> rusqlite::Result<Vec<TrackRecord>> {
        if id == FAVORITES_PLAYLIST_ID {
            let mut statement = connection.prepare(&format!(
                "{} WHERE f.track_id IS NOT NULL ORDER BY f.created_at DESC,f.rowid DESC",
                LibraryRepository::select_sql()
            ))?;
            return statement
                .query_map([], LibraryRepository::map_row)?
                .collect();
        }
        let mut statement = connection.prepare(&format!("{} JOIN playlist_items pi ON pi.track_id=t.id WHERE pi.playlist_id=?1 ORDER BY pi.position,pi.created_at DESC,pi.rowid DESC", LibraryRepository::select_sql()))?;
        statement
            .query_map(params![id], LibraryRepository::map_row)?
            .collect()
    }

    pub fn add_track(
        connection: &Connection,
        playlist_id: &str,
        track_id: &str,
    ) -> rusqlite::Result<()> {
        Self::add_tracks(connection, playlist_id, &[track_id.to_owned()], false)
    }

    pub fn add_tracks(
        connection: &Connection,
        playlist_id: &str,
        track_ids: &[String],
        append: bool,
    ) -> rusqlite::Result<()> {
        let tx = connection.unchecked_transaction()?;
        let mut seen = std::collections::HashSet::new();
        let ids = track_ids
            .iter()
            .filter(|id| seen.insert(id.as_str()))
            .collect::<Vec<_>>();
        if playlist_id == FAVORITES_PLAYLIST_ID {
            // An explicit add brings the selected batch to the front. The key stays unique.
            for id in ids.into_iter().rev() {
                tx.execute("DELETE FROM favorites WHERE track_id=?1", [id])?;
                LibraryRepository::set_favorite(&tx, id, true)?;
            }
        } else if !ids.is_empty() {
            let start: i64 = if append {
                tx.query_row(
                    "SELECT COALESCE(MAX(position)+1,0) FROM playlist_items WHERE playlist_id=?1",
                    [playlist_id],
                    |r| r.get(0),
                )?
            } else {
                tx.execute(
                    "UPDATE playlist_items SET position=position+?2 WHERE playlist_id=?1",
                    params![playlist_id, ids.len() as i64],
                )?;
                0
            };
            for (index, id) in ids.into_iter().enumerate() {
                let position = start + index as i64;
                if append {
                    tx.execute(
                        "INSERT INTO playlist_items(playlist_id,track_id,position,created_at)
                         VALUES(?1,?2,?3,strftime('%Y-%m-%d %H:%M:%f','now')) ON CONFLICT DO NOTHING",
                        params![playlist_id, id, position],
                    )?;
                } else {
                    tx.execute(
                        "INSERT INTO playlist_items(playlist_id,track_id,position,created_at)
                         VALUES(?1,?2,?3,strftime('%Y-%m-%d %H:%M:%f','now'))
                         ON CONFLICT(playlist_id,track_id) DO UPDATE SET position=excluded.position, created_at=excluded.created_at",
                        params![playlist_id, id, position],
                    )?;
                }
            }
            tx.execute(
                "UPDATE playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                [playlist_id],
            )?;
        }
        tx.commit()
    }

    pub fn remove_track(
        connection: &Connection,
        playlist_id: &str,
        track_id: &str,
    ) -> rusqlite::Result<()> {
        if playlist_id == FAVORITES_PLAYLIST_ID {
            return LibraryRepository::set_favorite(connection, track_id, false);
        }
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
        Self::ensure_custom(id)?;
        connection.execute("DELETE FROM playlists WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn rename(connection: &Connection, id: &str, name: &str) -> rusqlite::Result<()> {
        Self::ensure_custom(id)?;
        connection.execute(
            "UPDATE playlists SET name=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![id, name.trim()],
        )?;
        Ok(())
    }

    fn ensure_custom(id: &str) -> rusqlite::Result<()> {
        if id == FAVORITES_PLAYLIST_ID {
            return Err(rusqlite::Error::InvalidParameterName(
                "默认歌单不能删除或重命名".into(),
            ));
        }
        Ok(())
    }

    fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlaylistRecord> {
        Ok(PlaylistRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            cover_url: row.get(3)?,
            track_count: row.get(4)?,
            is_system: false,
            added_at: row.get(5)?,
            bili_folder_id: None,
        })
    }
}
