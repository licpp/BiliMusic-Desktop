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
    #[serde(default)]
    pub source_title_context: Option<crate::domain::source_title::SourceTitleContext>,
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
    pub source_display_title: String,
    pub source_video_title: String,
    pub title_overridden: bool,
    pub source_title_context: Option<crate::domain::source_title::SourceTitleContext>,
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
        let previous =
            crate::infrastructure::repositories::source_titles::get(connection, &track.id)?;
        let cached = track
            .source_title_context
            .clone()
            .map(|mut value| {
                if let Some(old) = &previous {
                    if value.season.is_none() {
                        value.season = old.season.clone()
                    }
                    value.chapter_context |= old.chapter_context;
                }
                value
            })
            .or(previous);
        let canonical = cached
            .as_ref()
            .map(|c| c.title())
            .unwrap_or_else(|| track.title.clone());
        let raw = cached
            .as_ref()
            .map(|c| c.video_title.as_str())
            .unwrap_or(&track.source_title);
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO source_items (id, provider, bvid, aid, cid, page, uploader_id, uploader_name, source_title)
             VALUES (?1, 'bilibili', ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET aid=excluded.aid, page=excluded.page, uploader_id=excluded.uploader_id,
               uploader_name=excluded.uploader_name, source_title=excluded.source_title, updated_at=CURRENT_TIMESTAMP",
            params![track.id, track.bvid, track.aid, track.cid, track.page, track.uploader_id, track.uploader_name, raw],
        )?;
        transaction.execute(
            "INSERT INTO tracks (id, source_item_id, title, artist, album, cover_url, duration_seconds)
             VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album,
               cover_url=excluded.cover_url, duration_seconds=excluded.duration_seconds, updated_at=CURRENT_TIMESTAMP",
            params![track.id, canonical, track.artist, track.album, track.cover_url, track.duration_seconds],
        )?;
        if let Some(context) = &cached {
            crate::infrastructure::repositories::source_titles::save(
                &transaction,
                &track.id,
                context,
            )?;
        }
        transaction.commit()?;
        Self::get(connection, &track.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn record_play(
        connection: &mut Connection,
        track: &TrackInput,
    ) -> rusqlite::Result<TrackRecord> {
        let record = Self::upsert(connection, track)?;
        connection.execute(
            "INSERT INTO play_history (track_id,played_at) VALUES (?1,strftime('%Y-%m-%d %H:%M:%f','now'))",
            params![track.id],
        )?;
        connection.execute(
            "DELETE FROM play_history WHERE id NOT IN (SELECT id FROM play_history ORDER BY played_at DESC, id DESC LIMIT 1000)",
            [],
        )?;
        connection.execute("DELETE FROM playback_positions WHERE track_id NOT IN (SELECT track_id FROM play_history GROUP BY track_id ORDER BY MAX(played_at) DESC, MAX(id) DESC LIMIT 200)", [])?;
        Ok(record)
    }

    pub fn playback_position(connection: &Connection, id: &str) -> rusqlite::Result<f64> {
        Ok(connection
            .query_row(
                "SELECT seconds FROM playback_positions WHERE track_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0.0))
    }

    pub fn save_playback_position(
        connection: &Connection,
        id: &str,
        seconds: f64,
        observed_at: i64,
    ) -> rusqlite::Result<()> {
        if !seconds.is_finite() || seconds < 0.0 || observed_at <= 0 {
            return Ok(());
        }
        connection.execute(
            "INSERT INTO playback_positions(track_id,seconds,observed_at)
             SELECT ?1,?2,?3 WHERE ?1 IN (SELECT track_id FROM play_history GROUP BY track_id ORDER BY MAX(played_at) DESC, MAX(id) DESC LIMIT 200)
             ON CONFLICT(track_id) DO UPDATE SET seconds=excluded.seconds, observed_at=excluded.observed_at
             WHERE excluded.observed_at >= playback_positions.observed_at",
            params![id, seconds, observed_at],
        )?;
        Ok(())
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
            "{} JOIN (
                SELECT track_id, MAX(strftime('%Y-%m-%d %H:%M:%f',added_at) || ':' || printf('%020d',added_row)) AS latest FROM (
                    SELECT track_id, created_at AS added_at, rowid AS added_row FROM favorites
                    UNION ALL SELECT track_id, created_at, rowid FROM playlist_items
                ) GROUP BY track_id
            ) membership ON membership.track_id=t.id
            ORDER BY membership.latest DESC, t.id LIMIT ?1",
            Self::select_sql()
        ))?;
        statement
            .query_map(params![limit.clamp(1, 500)], Self::map_row)?
            .collect()
    }

    pub fn recent(connection: &Connection, limit: i64) -> rusqlite::Result<Vec<TrackRecord>> {
        let mut statement = connection.prepare(&format!(
            "{} JOIN (SELECT track_id,MAX(played_at) latest_time,MAX(id) latest_id FROM play_history GROUP BY track_id) h ON h.track_id=t.id ORDER BY h.latest_time DESC,h.latest_id DESC LIMIT ?1",
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
                "INSERT INTO favorites(track_id,created_at) VALUES(?1,strftime('%Y-%m-%d %H:%M:%f','now')) ON CONFLICT(track_id) DO NOTHING",
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
           CASE WHEN f.track_id IS NULL THEN 0 ELSE 1 END, t.title, s.source_title,
           CASE WHEN NULLIF(m.title,'') IS NOT NULL THEN 1 ELSE 0 END,
           sc.part_title,sc.part_count,sc.season_json,sc.chapter_context
         FROM tracks t JOIN source_items s ON s.id=t.source_item_id AND s.provider='bilibili'
         LEFT JOIN metadata_overrides m ON m.track_id=t.id LEFT JOIN favorites f ON f.track_id=t.id LEFT JOIN source_title_cache sc ON sc.track_id=t.id"
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
            source_display_title: row.get(13)?,
            source_video_title: row.get(14)?,
            title_overridden: row.get(15)?,
            source_title_context: row.get::<_, Option<String>>(16)?.map(|part_title| {
                crate::domain::source_title::SourceTitleContext {
                    video_title: row.get(14).unwrap_or_default(),
                    part_title,
                    part_count: row.get(17).unwrap_or(1),
                    chapter_context: row.get(19).unwrap_or(false),
                    season: row
                        .get::<_, Option<String>>(18)
                        .ok()
                        .flatten()
                        .and_then(|value| serde_json::from_str(&value).ok()),
                }
            }),
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
            source_title_context: None,
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
    fn chapter_context_survives_old_play_records_and_user_titles_remain_authoritative() {
        let mut c = database();
        let mut input = track(10);
        input.source_title = "AI喻大华 苦命皇帝咸丰 未删减版 01谁是太子".into();
        input.title = input.source_title.clone();
        input.source_title_context=Some(serde_json::from_value(serde_json::json!({
            "videoTitle":input.source_title,"partTitle":"01谁是太子","partCount":1,
            "season":{"id":10,"uploaderId":42,"title":"AI喻大华 苦命皇帝咸丰 未删减版","coverUrl":"","uploaderName":"远哥挺乐"}
        })).unwrap());
        let first = LibraryRepository::upsert(&mut c, &input).unwrap();
        assert_eq!(first.title, "01谁是太子");
        assert_eq!(first.source_video_title, input.source_title);
        assert!(!first.title_overridden);
        LibraryRepository::set_favorite(&c, &input.id, true).unwrap();
        input.source_title_context = None;
        let played = LibraryRepository::record_play(&mut c, &input).unwrap();
        assert_eq!(played.title, "01谁是太子");
        assert!(played.liked);
        assert!(played.source_title_context.unwrap().season.is_some());
        LibraryRepository::update_metadata(
            &c,
            &input.id,
            &MetadataPatch {
                title: "我的章节".into(),
                artist: None,
                album: None,
                cover_url: None,
            },
        )
        .unwrap();
        let played = LibraryRepository::record_play(&mut c, &input).unwrap();
        assert_eq!(played.title, "我的章节");
        assert!(played.title_overridden);
        assert_eq!(played.source_display_title, "01谁是太子");
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
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
    fn playback_positions_are_bounded_and_ignore_stale_updates() {
        let mut connection = database();
        let first = track(1);
        LibraryRepository::record_play(&mut connection, &first).unwrap();
        LibraryRepository::save_playback_position(&connection, &first.id, 24.0, 10).unwrap();
        LibraryRepository::save_playback_position(&connection, &first.id, 0.0, 12).unwrap();
        LibraryRepository::save_playback_position(&connection, &first.id, 38.0, 11).unwrap();
        assert_eq!(
            LibraryRepository::playback_position(&connection, &first.id).unwrap(),
            0.0
        );
        LibraryRepository::save_playback_position(&connection, &first.id, 40.0, 13).unwrap();
        for cid in 2..=201 {
            LibraryRepository::record_play(&mut connection, &track(cid)).unwrap();
        }
        LibraryRepository::save_playback_position(&connection, &first.id, 45.0, 14).unwrap();
        assert_eq!(
            LibraryRepository::playback_position(&connection, &first.id).unwrap(),
            0.0
        );
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
    #[test]
    fn retired_imported_audio_is_hidden_without_touching_files_or_downloaded_bili_tracks() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute_batch("INSERT INTO source_items(id,provider,bvid,cid) VALUES('local:retired','local','local:retired',0),('bilibili:BVdownload:1','bilibili','BVdownload',1);
          INSERT INTO tracks(id,source_item_id,title,cover_url) VALUES('local:retired','local:retired','retired','file:///original.jpg'),('bilibili:BVdownload:1','bilibili:BVdownload:1','downloaded song','https://bili/cover.jpg');
          INSERT INTO local_audio VALUES('local:retired','/untouched/original.mp3');
          INSERT INTO favorites(track_id) VALUES('local:retired'),('bilibili:BVdownload:1');
          INSERT INTO play_history(track_id) VALUES('local:retired'),('bilibili:BVdownload:1');
          INSERT INTO playlists(id,name) VALUES('mixed','mixed');
          INSERT INTO playlist_items(playlist_id,track_id,position) VALUES('mixed','local:retired',0),('mixed','bilibili:BVdownload:1',1);").unwrap();
        assert!(
            LibraryRepository::get(&c, "local:retired")
                .unwrap()
                .is_none()
        );
        assert_eq!(LibraryRepository::list(&c, false, 500).unwrap().len(), 1);
        assert_eq!(
            LibraryRepository::recent(&c, 500).unwrap()[0].id,
            "bilibili:BVdownload:1"
        );
        assert_eq!(
            LibraryRepository::saved(&c, 500).unwrap()[0].id,
            "bilibili:BVdownload:1"
        );
        use crate::infrastructure::repositories::playlists::{
            FAVORITES_PLAYLIST_ID, PlaylistRepository,
        };
        for id in [FAVORITES_PLAYLIST_ID, "mixed"] {
            let playlist = PlaylistRepository::get(&c, id).unwrap();
            assert_eq!(playlist.track_count, 1);
            assert_eq!(
                playlist.cover_url.as_deref(),
                Some("https://bili/cover.jpg")
            );
            assert_eq!(PlaylistRepository::tracks(&c, id).unwrap().len(), 1);
        }
        assert!(
            PlaylistRepository::list(&c)
                .unwrap()
                .iter()
                .all(|p| p.track_count == 1)
        );
        assert_eq!(
            c.query_row("SELECT path FROM local_audio", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "/untouched/original.mp3"
        );
    }
}
