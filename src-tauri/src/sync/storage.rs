use super::model::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub fn init(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS sync_settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_base(provider TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_info(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e|e.to_string())
}
pub fn export(c: &Connection, uid: &str, history: bool) -> Result<Snapshot, String> {
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
        let mut q = c.prepare("SELECT id,name FROM collection_folders LIMIT 101")?;
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = row?;
            add(
                format!("collectionFolder:{id}"),
                "collectionFolder",
                json!({"id":id,"name":name}),
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
            c.prepare("SELECT playlist_id,track_id,position FROM playlist_items LIMIT 10001")?;
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
        let mut q = c.prepare("SELECT track_id FROM favorites LIMIT 5001")?;
        for row in q.query_map([], |r| r.get::<_, String>(0))? {
            let t = row?;
            add(format!("favorite:{t}"), "favorite", json!({"trackId":t}));
        }
        if history {
            let mut q=c.prepare("SELECT track_id,MAX(played_at) FROM play_history GROUP BY track_id ORDER BY MAX(played_at) DESC,track_id LIMIT 200")?;
            for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (t, time) = row?;
                add(
                    format!("history:{t}"),
                    "history",
                    json!({"trackId":t,"playedAt":time}),
                );
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
        if let Some(lyric) = lyric {
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
    s.validate(&s.uid)?;
    c.execute_batch("SAVEPOINT sync_apply")
        .map_err(|e| e.to_string())?;
    let tx = c;
    let result = (|| -> rusqlite::Result<()> {
        tx.execute("DELETE FROM collection_folders", [])?;
        for r in s.records.values().filter(|r| r.kind == "collectionFolder") {
            tx.execute(
                "INSERT INTO collection_folders(id,name) VALUES(?1,?2)",
                params![text(r, "id"), text(r, "name")],
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
        tx.execute_batch(
            "DELETE FROM playlist_items; DELETE FROM playlists; DELETE FROM favorites;",
        )?;
        for r in s.records.values().filter(|r| r.kind == "playlist") {
            tx.execute(
                "INSERT INTO playlists(id,name,description,cover_url) VALUES(?1,?2,?3,?4)",
                params![
                    text(r, "id"),
                    text(r, "name"),
                    text(r, "description"),
                    optional(r, "coverUrl")
                ],
            )?;
        }
        for r in s.records.values() {
            match r.kind.as_str() {
                "favorite" => {
                    tx.execute(
                        "INSERT INTO favorites(track_id) VALUES(?1)",
                        [text(r, "trackId")],
                    )?;
                }
                "item" => {
                    tx.execute("INSERT INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,?3)",params![text(r,"playlistId"),text(r,"trackId"),number(r,"position")])?;
                }
                "lyric" => {
                    tx.execute("INSERT INTO lyrics(track_id,provider,provider_lyric_id,raw_text,parsed_json,bias_ms,selected_manually) VALUES(?1,?2,?3,'','[]',?4,?5) ON CONFLICT(track_id) DO UPDATE SET raw_text=CASE WHEN lyrics.provider=excluded.provider AND lyrics.provider_lyric_id IS excluded.provider_lyric_id THEN lyrics.raw_text ELSE '' END,parsed_json=CASE WHEN lyrics.provider=excluded.provider AND lyrics.provider_lyric_id IS excluded.provider_lyric_id THEN lyrics.parsed_json ELSE '[]' END,provider=excluded.provider,provider_lyric_id=excluded.provider_lyric_id,bias_ms=excluded.bias_ms,selected_manually=excluded.selected_manually",params![text(r,"id"),text(r,"provider"),optional(r,"providerLyricId"),number(r,"biasMs"),r.fields.get("manual").and_then(Value::as_bool).unwrap_or(false)])?;
                }
                _ => {}
            }
        }
        if history {
            tx.execute("DELETE FROM play_history", [])?;
            for r in s.records.values().filter(|r| r.kind == "history") {
                tx.execute(
                    "INSERT INTO play_history(track_id,played_at) VALUES(?1,?2)",
                    params![text(r, "trackId"), text(r, "playedAt")],
                )?;
            }
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
    c.execute("DELETE FROM metadata_overrides WHERE track_id NOT IN (SELECT track_id FROM favorites UNION SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history)",[])?;
    c.execute("DELETE FROM lyrics WHERE track_id NOT IN (SELECT track_id FROM favorites UNION SELECT track_id FROM playlist_items UNION SELECT track_id FROM play_history)",[])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
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
}
