use super::model::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub fn init(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS sync_settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_base(provider TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_info(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e|e.to_string())
}
pub fn export(c: &Connection, uid: &str, history: bool) -> Result<Snapshot, String> {
    crate::infrastructure::repositories::collections::separate_legacy_folders(c)
        .map_err(|e| e.to_string())?;
    let mut s = Snapshot::empty(uid);
    let mut add = |key: String, kind: &str, value: Value| {
        s.records.insert(
            key,
            Record {
                kind: kind.into(),
                fields: serde_json::from_value(value).unwrap(),
            },
        );
    };
    let result = (|| -> rusqlite::Result<()> {
        let mut q = c.prepare("SELECT id,name,scope FROM collection_folders LIMIT 101")?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, name, scope) = row?;
            add(
                format!("collectionFolder:{id}"),
                "collectionFolder",
                if scope == "creators" {
                    json!({"id":id,"name":name,"scope":scope})
                } else {
                    json!({"id":id,"name":name})
                },
            );
        }
        let mut q = c.prepare("SELECT bvid,folder_id FROM collections LIMIT 2001")?;
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (bvid, folder) = row?;
            add(
                format!("collection:{bvid}"),
                "collection",
                json!({"bvid":bvid,"folderId":folder}),
            );
        }
        if history {
            let mut q = c.prepare("SELECT p.reference,p.bvid,p.cid,p.position_ms,p.observed_at FROM collection_progress p JOIN collections c ON c.bvid=p.reference LIMIT 2001")?;
            for row in q.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })? {
                let (reference, bvid, cid, position, time) = row?;
                add(
                    format!("collectionProgress:{reference}"),
                    "collectionProgress",
                    json!({"reference":reference,"checkpoint":format!("{time}:{bvid}:{cid}:{position}")}),
                );
            }
        }
        let mut q =
            c.prepare("SELECT id,name,description,cover_url FROM playlists ORDER BY id LIMIT 501")?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })? {
            let (id, name, description, cover) = row?;
            add(
                format!("playlist:{id}"),
                "playlist",
                json!({"id":id,"name":name,"description":description,"coverUrl":cover.filter(|s|safe_cover(s))}),
            );
        }
        let mut q =
            c.prepare("SELECT playlist_id,track_id,position FROM playlist_items WHERE track_id NOT IN (SELECT track_id FROM local_audio) LIMIT 10001")?;
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })? {
            let (p, t, pos) = row?;
            add(
                format!("item:{p}|{t}"),
                "item",
                json!({"playlistId":p,"trackId":t,"position":pos}),
            );
        }
        let mut q = c.prepare("SELECT track_id FROM favorites WHERE track_id NOT IN (SELECT track_id FROM local_audio) LIMIT 5001")?;
        for row in q.query_map([], |r| r.get::<_, String>(0))? {
            let t = row?;
            add(format!("favorite:{t}"), "favorite", json!({"trackId":t}));
        }
        if history {
            let mut q = c.prepare(
                "SELECT h.track_id,h.played_at,p.seconds,p.observed_at FROM (
                  SELECT track_id,MAX(played_at) played_at FROM play_history
                  WHERE track_id NOT IN (SELECT track_id FROM local_audio)
                  GROUP BY track_id ORDER BY played_at DESC,track_id LIMIT 200
                ) h LEFT JOIN playback_positions p ON p.track_id=h.track_id",
            )?;
            for row in q.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<f64>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            })? {
                let (t, time, seconds, observed) = row?;
                let mut fields = json!({"trackId":t,"playedAt":time});
                if let (Some(seconds), Some(observed)) = (seconds, observed)
                    && (0.0..=604800.0).contains(&seconds)
                {
                    fields["resume"] =
                        json!(format!("{observed}:{}", (seconds * 1000.0).round() as i64));
                }
                add(format!("history:{t}"), "history", fields);
            }
        }
        Ok(())
    })();
    result.map_err(|e| e.to_string())?;
    let refs: std::collections::BTreeSet<_> = s
        .records
        .values()
        .filter_map(|r| r.fields.get("trackId").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    for id in refs {
        let record=c.query_row("SELECT s.bvid,s.cid,m.title,m.artist,m.album,m.cover_url FROM tracks t JOIN source_items s ON s.id=t.source_item_id LEFT JOIN metadata_overrides m ON m.track_id=t.id WHERE t.id=?1",[&id],|r|Ok(json!({"id":id,"bvid":r.get::<_,String>(0)?,"cid":r.get::<_,i64>(1)?,"overrideTitle":r.get::<_,Option<String>>(2)?,"overrideArtist":r.get::<_,Option<String>>(3)?,"overrideAlbum":r.get::<_,Option<String>>(4)?,"overrideCover":r.get::<_,Option<String>>(5)?.filter(|s|safe_cover(s))}))).optional().map_err(|e|e.to_string())?;
        if let Some(record) = record {
            s.records.insert(
                format!("track:{id}"),
                Record {
                    kind: "track".into(),
                    fields: serde_json::from_value(record).unwrap(),
                },
            );
        }
        let lyric=c.query_row("SELECT provider,provider_lyric_id,bias_ms,selected_manually FROM lyrics WHERE track_id=?1",[&id],|r|Ok(json!({"id":id,"provider":r.get::<_,String>(0)?,"providerLyricId":r.get::<_,Option<String>>(1)?,"biasMs":r.get::<_,i64>(2)?,"manual":r.get::<_,bool>(3)?}))).optional().map_err(|e|e.to_string())?;
        if let Some(lyric) = lyric.filter(|v| v["provider"] != "bilibili") {
            s.records.insert(
                format!("lyric:{id}"),
                Record {
                    kind: "lyric".into(),
                    fields: serde_json::from_value(lyric).unwrap(),
                },
            );
        }
    }
    s.compact(history);
    s.validate(uid)?;
    Ok(s)
}
fn optional<'a>(r: &'a Record, k: &str) -> Option<&'a str> {
    r.fields.get(k).and_then(Value::as_str)
}
pub fn apply(c: &Connection, s: &Snapshot, history: bool) -> Result<(), String> {
    crate::infrastructure::repositories::collections::init_folders(c).map_err(|e| e.to_string())?;
    s.validate(&s.uid)?;
    c.execute_batch("SAVEPOINT sync_apply")
        .map_err(|e| e.to_string())?;
    let tx = c;
    let result = (|| -> rusqlite::Result<()> {
        // Updating surviving rows keeps their local creation order stable.
        for (table, kind) in [
            ("collection_folders", "collectionFolder"),
            ("playlists", "playlist"),
        ] {
            let keep: std::collections::BTreeSet<_> = s
                .records
                .values()
                .filter(|r| r.kind == kind)
                .map(|r| text(r, "id"))
                .collect();
            let mut query = tx.prepare(&format!("SELECT id FROM {table}"))?;
            let existing = query
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for id in existing {
                if !keep.contains(id.as_str()) {
                    tx.execute(&format!("DELETE FROM {table} WHERE id=?1"), [&id])?;
                }
            }
        }
        for r in s.records.values().filter(|r| r.kind == "collectionFolder") {
            tx.execute(
                "INSERT INTO collection_folders(id,name,scope) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,scope=CASE WHEN ?4 THEN excluded.scope ELSE collection_folders.scope END",
                params![text(r, "id"), text(r, "name"),if text(r,"scope")=="creators" {"creators"}else{"collections"},r.fields.contains_key("scope")],
            )?;
        }
        let keep: std::collections::BTreeSet<_> = s
            .records
            .values()
            .filter(|r| r.kind == "collection")
            .map(|r| text(r, "bvid").to_owned())
            .collect();
        let mut q = tx.prepare("SELECT bvid FROM collections")?;
        let existing = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in existing {
            if !keep.contains(&id) {
                tx.execute("DELETE FROM collections WHERE bvid=?1", [id])?;
            }
        }
        for r in s.records.values().filter(|r| r.kind == "collection") {
            tx.execute("INSERT INTO collections(bvid,folder_id) VALUES(?1,?2) ON CONFLICT(bvid) DO UPDATE SET folder_id=excluded.folder_id",params![text(r,"bvid"),text(r,"folderId")])?;
        }
        crate::infrastructure::repositories::collections::separate_legacy_folders(tx)?;
        tx.execute(
            "DELETE FROM creator_notes WHERE bvid NOT IN (SELECT bvid FROM collections)",
            [],
        )?;
        tx.execute(
            "DELETE FROM collection_progress WHERE reference NOT IN (SELECT bvid FROM collections)",
            [],
        )?;
        if history {
            for r in s
                .records
                .values()
                .filter(|r| r.kind == "collectionProgress")
            {
                if let Some((time, bvid, cid, position)) = parse_checkpoint(text(r, "checkpoint")) {
                    crate::infrastructure::repositories::collections::save_progress(
                        tx,
                        text(r, "reference"),
                        &format!("bilibili:{bvid}:{cid}"),
                        position as f64 / 1000.0,
                        time,
                    )?;
                }
            }
        }
        for r in s.records.values().filter(|r| r.kind == "track") {
            let id = text(r, "id");
            tx.execute("INSERT INTO source_items(id,provider,bvid,aid,cid,page,source_title,uploader_id,uploader_name) VALUES(?1,'bilibili',?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO NOTHING",params![id,text(r,"bvid"),r.fields.get("aid").and_then(Value::as_i64),number(r,"cid"),1,"",r.fields.get("uploaderId").and_then(Value::as_i64),optional(r,"uploaderName")])?;
            tx.execute("INSERT INTO tracks(id,source_item_id,title,artist,album,cover_url,duration_seconds) VALUES(?1,?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING",params![id,"B站歌曲（待加载）",optional(r,"artist"),optional(r,"album"),optional(r,"coverUrl"),number(r,"duration")])?;
            tx.execute("DELETE FROM metadata_overrides WHERE track_id=?1", [id])?;
            if [
                "overrideTitle",
                "overrideArtist",
                "overrideAlbum",
                "overrideCover",
            ]
            .iter()
            .any(|k| optional(r, k).is_some())
            {
                tx.execute("INSERT INTO metadata_overrides(track_id,title,artist,album,cover_url) VALUES(?1,?2,?3,?4,?5)",params![id,optional(r,"overrideTitle"),optional(r,"overrideArtist"),optional(r,"overrideAlbum"),optional(r,"overrideCover")])?;
            }
        }
        for r in s.records.values().filter(|r| r.kind == "playlist") {
            tx.execute(
                "INSERT INTO playlists(id,name,description,cover_url,created_at) VALUES(?1,?2,?3,?4,strftime('%Y-%m-%d %H:%M:%f','now'))
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,cover_url=excluded.cover_url",
                params![text(r,"id"), text(r,"name"), text(r,"description"), optional(r,"coverUrl")],
            )?;
        }
        tx.execute_batch(
            "CREATE TEMP TABLE sync_item_keys(playlist_id TEXT, track_id TEXT, PRIMARY KEY(playlist_id,track_id));
             CREATE TEMP TABLE sync_favorite_keys(track_id TEXT PRIMARY KEY);",
        )?;
        for r in s.records.values() {
            match r.kind.as_str() {
                "favorite" => {
                    let id = text(r, "trackId");
                    tx.execute("INSERT INTO sync_favorite_keys(track_id) VALUES(?1)", [id])?;
                    tx.execute(
                        "INSERT INTO favorites(track_id) VALUES(?1) ON CONFLICT(track_id) DO NOTHING",
                        [id],
                    )?;
                }
                "item" => {
                    let playlist = text(r, "playlistId");
                    let track = text(r, "trackId");
                    tx.execute(
                        "INSERT INTO sync_item_keys VALUES(?1,?2)",
                        params![playlist, track],
                    )?;
                    tx.execute(
                        "INSERT INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,?3)
                        ON CONFLICT(playlist_id,track_id) DO UPDATE SET position=excluded.position",
                        params![playlist, track, number(r, "position")],
                    )?;
                }
                "lyric" => {
                    tx.execute("INSERT INTO lyrics(track_id,provider,provider_lyric_id,raw_text,parsed_json,bias_ms,selected_manually) VALUES(?1,?2,?3,'','[]',?4,?5) ON CONFLICT(track_id) DO UPDATE SET raw_text=CASE WHEN lyrics.provider=excluded.provider AND lyrics.provider_lyric_id IS excluded.provider_lyric_id THEN lyrics.raw_text ELSE '' END,parsed_json=CASE WHEN lyrics.provider=excluded.provider AND lyrics.provider_lyric_id IS excluded.provider_lyric_id THEN lyrics.parsed_json ELSE '[]' END,provider=excluded.provider,provider_lyric_id=excluded.provider_lyric_id,bias_ms=excluded.bias_ms,selected_manually=excluded.selected_manually",params![text(r,"id"),text(r,"provider"),optional(r,"providerLyricId"),number(r,"biasMs"),r.fields.get("manual").and_then(Value::as_bool).unwrap_or(false)])?;
                }
                _ => {}
            }
        }
        tx.execute_batch(
            "DELETE FROM playlist_items WHERE track_id NOT IN (SELECT track_id FROM local_audio)
               AND NOT EXISTS(SELECT 1 FROM sync_item_keys k WHERE k.playlist_id=playlist_items.playlist_id AND k.track_id=playlist_items.track_id);
             DELETE FROM favorites WHERE track_id NOT IN (SELECT track_id FROM local_audio)
               AND NOT EXISTS(SELECT 1 FROM sync_favorite_keys k WHERE k.track_id=favorites.track_id);
             DROP TABLE sync_item_keys;
             DROP TABLE sync_favorite_keys;",
        )?;
        if history {
            tx.execute_batch("CREATE TEMP TABLE sync_history_keys(track_id TEXT PRIMARY KEY);")?;
            for r in s.records.values().filter(|r| r.kind == "history") {
                let track = text(r, "trackId");
                let time = text(r, "playedAt");
                tx.execute("INSERT INTO sync_history_keys VALUES(?1)", [track])?;
                tx.execute(
                    "INSERT INTO play_history(track_id,played_at) SELECT ?1,?2
                     WHERE NOT EXISTS(SELECT 1 FROM play_history WHERE track_id=?1 AND played_at>=?2)",
                    params![track, time],
                )?;
            }
            for r in s.records.values().filter(|r| r.kind == "history") {
                if let Some((observed, ms)) = parse_track_position(text(r, "resume")) {
                    tx.execute(
                        "INSERT INTO playback_positions(track_id,seconds,observed_at) VALUES(?1,?2,?3)
                         ON CONFLICT(track_id) DO UPDATE SET seconds=excluded.seconds,observed_at=excluded.observed_at
                         WHERE excluded.observed_at >= playback_positions.observed_at",
                        params![text(r,"trackId"),ms as f64 / 1000.0,observed],
                    )?;
                }
            }
            tx.execute_batch("DELETE FROM play_history WHERE track_id NOT IN (SELECT track_id FROM local_audio)
                AND track_id NOT IN (SELECT track_id FROM sync_history_keys); DROP TABLE sync_history_keys;")?;
        }
        prune(&tx)?;
        Ok(())
    })();
    match result {
        Ok(()) => c
            .execute_batch("RELEASE sync_apply")
            .map_err(|e| e.to_string()),
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK TO sync_apply; RELEASE sync_apply");
            Err(e.to_string())
        }
    }
}
pub fn prune(c: &Connection) -> rusqlite::Result<()> {
    // Keep exactly the visible recent-list references, never an unbounded metadata archive.
    c.execute("DELETE FROM play_history WHERE track_id NOT IN (SELECT track_id FROM play_history GROUP BY track_id ORDER BY MAX(played_at) DESC,track_id LIMIT 200)",[])?;
    c.execute("DELETE FROM playback_positions WHERE track_id NOT IN (SELECT track_id FROM play_history GROUP BY track_id ORDER BY MAX(played_at) DESC,MAX(id) DESC LIMIT 200)", [])?;
    c.execute("DELETE FROM metadata_overrides WHERE track_id NOT IN (SELECT track_id FROM favorites UNION SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history UNION SELECT track_id FROM local_audio)",[])?;
    c.execute("DELETE FROM lyrics WHERE track_id NOT IN (SELECT track_id FROM favorites UNION SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history UNION SELECT track_id FROM local_audio)",[])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sync_preserves_local_playlist_and_folder_creation_order() {
        use crate::infrastructure::repositories::{collections, playlists::PlaylistRepository};
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        let a = "ffffffff-2861-4be1-8b08-a6a0fb0b0579";
        let b = "00000000-2861-4be1-8b08-a6a0fb0b0579";
        for id in [a, b] {
            c.execute(
                "INSERT INTO playlists(id,name,created_at) VALUES(?1,?1,'2026-11-08 00:00:00')",
                [id],
            )
            .unwrap();
            c.execute(
                "INSERT INTO collection_folders(id,name) VALUES(?1,?1)",
                [id],
            )
            .unwrap();
        }
        let snapshot = export(&c, "42", false).unwrap();
        apply(&c, &snapshot, false).unwrap();
        assert_eq!(PlaylistRepository::list(&c).unwrap()[1].id, b);
        assert_eq!(collections::list(&c).unwrap().folders[0].id, b);
    }
    #[test]
    fn applying_sync_preserves_local_favorite_addition_order() {
        use crate::infrastructure::repositories::playlists::{
            FAVORITES_PLAYLIST_ID, PlaylistRepository,
        };
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        for (id, cid) in [("bilibili:BV123:2", 2), ("bilibili:BV123:1", 1)] {
            c.execute(
                "INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili','BV123',?2)",
                params![id, cid],
            )
            .unwrap();
            c.execute(
                "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'Track')",
                [id],
            )
            .unwrap();
            c.execute(
                "INSERT INTO favorites(track_id,created_at) VALUES(?1,'2026-11-10 00:00:00')",
                [id],
            )
            .unwrap();
        }
        let snapshot = export(&c, "42", false).unwrap();
        apply(&c, &snapshot, false).unwrap();
        let tracks = PlaylistRepository::tracks(&c, FAVORITES_PLAYLIST_ID).unwrap();
        assert_eq!(tracks[0].id, "bilibili:BV123:1");
        assert_eq!(tracks[1].id, "bilibili:BV123:2");
    }
    #[test]
    fn collection_progress_merges_and_syncs_without_song_metadata_or_history() {
        use crate::infrastructure::repositories::collections;
        let reference = "season:42:73";
        let local = Connection::open_in_memory().unwrap();
        local
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        local
            .execute(
                "INSERT INTO collections(bvid,folder_id) VALUES(?1,'')",
                [reference],
            )
            .unwrap();
        let empty = export(&local, "42", true).unwrap();
        collections::save_progress(&local, reference, "bilibili:BV123:5", 85.25, 100).unwrap();
        let older = export(&local, "42", true).unwrap();
        collections::save_progress(&local, reference, "bilibili:BV456:7", 2.25, 200).unwrap();
        collections::save_progress(&local, reference, "bilibili:BV123:5", 99.0, 199).unwrap();
        let newer = export(&local, "42", true).unwrap();
        let (merged, conflicts) = merge(&empty, &newer, &older, None);
        assert!(conflicts.is_empty());
        assert_eq!(merged, newer);
        assert_eq!(merged.records.len(), 2);
        assert_eq!(export(&local, "42", false).unwrap().records.len(), 1);

        let remote = Connection::open_in_memory().unwrap();
        remote
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        apply(&remote, &merged, true).unwrap();
        let progress = collections::progress(&remote, reference).unwrap().unwrap();
        assert_eq!(
            (progress.bvid.as_str(), progress.cid, progress.position_ms),
            ("BV456", 7, 2250)
        );
        apply(&remote, &Snapshot::empty("42"), false).unwrap();
        assert!(collections::progress(&remote, reference).unwrap().is_none());
    }

    #[test]
    fn recent_order_survives_history_sync_in_record_key_order() {
        use crate::infrastructure::repositories::library::LibraryRepository;
        let local = Connection::open_in_memory().unwrap();
        local
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        for (id, cid, played_at) in [
            ("bilibili:BV123:2", 2, "2026-11-10 00:00:00.900"),
            ("bilibili:BV123:1", 1, "2026-11-10 00:00:00.100"),
        ] {
            local.execute("INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili','BV123',?2)", params![id,cid]).unwrap();
            local
                .execute(
                    "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'Track')",
                    [id],
                )
                .unwrap();
            local
                .execute(
                    "INSERT INTO play_history(track_id,played_at) VALUES(?1,?2)",
                    params![id, played_at],
                )
                .unwrap();
        }
        let track = "bilibili:BV123:2";
        let history = format!("history:{track}");
        LibraryRepository::save_playback_position(&local, track, 84.5, 200).unwrap();
        let snapshot = export(&local, "42", true).unwrap();
        assert_eq!(text(&snapshot.records[&history], "resume"), "200:84500");
        assert!(
            !export(&local, "42", false)
                .unwrap()
                .records
                .contains_key(&history)
        );
        let remote = Connection::open_in_memory().unwrap();
        remote
            .execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        apply(&remote, &snapshot, true).unwrap();
        apply(&remote, &snapshot, true).unwrap();
        let recent = LibraryRepository::recent(&remote, 10).unwrap();
        assert_eq!(recent.iter().map(|t| t.cid).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(
            LibraryRepository::playback_position(&remote, track).unwrap(),
            84.5
        );
        LibraryRepository::save_playback_position(&remote, track, 0.0, 300).unwrap();
        let restarted = export(&remote, "42", true).unwrap();
        let (merged, conflicts) = merge(&snapshot, &restarted, &snapshot, None);
        assert!(conflicts.is_empty());
        assert_eq!(text(&merged.records[&history], "resume"), "300:0");

        let mut left = crate::sync::dav::Doc::empty("42");
        left.update("first", &snapshot).unwrap();
        let mut right = left.clone();
        let mut seeked = snapshot.clone();
        seeked
            .records
            .get_mut(&history)
            .unwrap()
            .fields
            .insert("resume".into(), json!("250:123000"));
        left.update("first", &seeked).unwrap();
        right.update("second", &restarted).unwrap();
        left.join(right).unwrap();
        let (dav, conflicts) = left.materialize().unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(text(&dav.records[&history], "resume"), "300:0");

        apply(&local, &merged, true).unwrap();
        assert_eq!(
            LibraryRepository::playback_position(&local, track).unwrap(),
            0.0
        );

        assert_eq!(
            remote
                .query_row("SELECT COUNT(*) FROM play_history", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn collections_round_trip_without_uploading_source_cache() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        use crate::infrastructure::repositories::collections::{self, Collection};
        collections::change(&mut c, "create", "", "听书", None).unwrap();
        let id = collections::list(&c).unwrap().folders.remove(0).id;
        collections::change(
            &mut c,
            "save",
            "",
            "",
            Some(Collection {
                bvid: "BV123".into(),
                folder_id: id.clone(),
                title: "local cache".into(),
                cover_url: "".into(),
                uploader_name: "local uploader".into(),
                note: String::new(),
            }),
        )
        .unwrap();
        let s = export(&c, "42", false).unwrap();
        assert_eq!(s.records.len(), 2);
        assert!(!serde_json::to_string(&s).unwrap().contains("local cache"));
        let d = Connection::open_in_memory().unwrap();
        d.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        apply(&d, &s, false).unwrap();
        assert_eq!(s, export(&d, "42", false).unwrap());
        collections::change(&mut c, "delete", &id, "", None).unwrap();
        let deleted = export(&c, "42", false).unwrap();
        apply(&d, &deleted, false).unwrap();
        assert_eq!(collections::list(&d).unwrap().items[0].folder_id, "");
    }
    #[test]
    fn cloud_round_trip_preserves_device_only_audio_memberships() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        c.execute_batch("
            INSERT INTO source_items(id,provider,bvid,cid) VALUES('local:fixture','local','local:fixture',0);
            INSERT INTO tracks(id,source_item_id,title) VALUES('local:fixture','local:fixture','Device audio');
            INSERT INTO local_audio(track_id,path) VALUES('local:fixture','/private/example.mp3');
            INSERT INTO playlists(id,name) VALUES('8076ad4b-2861-4be1-8b08-a6a0fb0b0579','Mixed playlist');
            INSERT INTO playlist_items(playlist_id,track_id,position) VALUES('8076ad4b-2861-4be1-8b08-a6a0fb0b0579','local:fixture',0);
            INSERT INTO favorites(track_id) VALUES('local:fixture');
            INSERT INTO play_history(track_id) VALUES('local:fixture');
        ").unwrap();
        let snapshot = export(&c, "42", true).unwrap();
        assert_eq!(snapshot.records.len(), 1);
        assert!(
            snapshot
                .records
                .contains_key("playlist:8076ad4b-2861-4be1-8b08-a6a0fb0b0579")
        );
        apply(&c, &snapshot, true).unwrap();
        assert_eq!(
            c.query_row("SELECT (SELECT COUNT(*) FROM playlist_items) + (SELECT COUNT(*) FROM favorites) + (SELECT COUNT(*) FROM play_history)", [], |row| row.get::<_, i64>(0)).unwrap(),
            3
        );
    }
    #[test]
    fn bounded_export_excludes_unreferenced_metadata_and_secrets() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        c.execute_batch("INSERT INTO source_items(id,provider,bvid,cid) VALUES('bilibili:BV1:1','bilibili','BV1',1); INSERT INTO tracks(id,source_item_id,title) VALUES('bilibili:BV1:1','bilibili:BV1:1','Song'); INSERT INTO metadata_overrides(track_id,title) VALUES('bilibili:BV1:1','Edit'); INSERT INTO auth_session(provider,cookie_header) VALUES('bilibili','secret');").unwrap();
        assert!(export(&c, "42", false).unwrap().records.is_empty());
        c.execute(
            "INSERT INTO favorites(track_id) VALUES('bilibili:BV1:1')",
            [],
        )
        .unwrap();
        let s = export(&c, "42", false).unwrap();
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("Edit"));
        assert!(!j.contains("secret"));
        let d = Connection::open_in_memory().unwrap();
        d.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        apply(&d, &s, false).unwrap();
        assert_eq!(s, export(&d, "42", false).unwrap());
        c.execute("DELETE FROM favorites", []).unwrap();
        prune(&c).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM metadata_overrides", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn scoped_creator_folders_round_trip_including_empty_folders() {
        use crate::infrastructure::repositories::collections;
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        collections::change(&mut c, "createCreator", "", "独立UP文件夹", None).unwrap();
        let source = export(&c, "42", true).unwrap();
        source.validate("42").unwrap();
        let d = Connection::open_in_memory().unwrap();
        d.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        apply(&d, &source, true).unwrap();
        let data = collections::list(&d).unwrap();
        assert_eq!(data.folders.len(), 1);
        assert_eq!(data.folders[0].scope, "creators");
    }
}
