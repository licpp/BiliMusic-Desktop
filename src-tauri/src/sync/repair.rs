use super::{Database, SyncState, config_from_connection, model::track_identity};
use crate::infrastructure::database::account_session;
use rusqlite::{Connection, params};
use serde::Serialize;
use std::{fs::OpenOptions, io::Write, path::Path};
use tauri::State;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Favorite,
    Playlist,
    History,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    kind: Kind,
    track_id: String,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    revision: String,
    total: usize,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
struct Row {
    row_id: i64,
    entry: Entry,
    original: serde_json::Value,
}

fn rows(c: &Connection, history: bool) -> Result<Vec<Row>, String> {
    let mut query = c
        .prepare(
            "WITH refs(kind,rid,track_id,label,original) AS (
                SELECT 0,rowid,track_id,created_at,
                    json_object('trackId',track_id,'createdAt',created_at) FROM favorites
                UNION ALL
                SELECT 1,i.rowid,i.track_id,p.name,
                    json_object('playlistId',i.playlist_id,'trackId',i.track_id,
                                'position',i.position,'createdAt',i.created_at)
                    FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id
                UNION ALL
                SELECT 2,h.id,h.track_id,h.played_at,
                    json_object('id',h.id,'trackId',h.track_id,'playedAt',h.played_at,
                                'progressSeconds',h.progress_seconds,
                                'resumeSeconds',p.seconds,'resumeObservedAt',p.observed_at)
                    FROM play_history h LEFT JOIN playback_positions p ON p.track_id=h.track_id
                    WHERE ?1
             )
             SELECT kind,rid,track_id,label,original
             FROM refs
             WHERE NOT EXISTS(SELECT 1 FROM local_audio WHERE track_id=refs.track_id)
               AND NOT EXISTS(SELECT 1 FROM tracks t JOIN source_items s ON s.id=t.source_item_id
                              WHERE t.id=refs.track_id)
             ORDER BY kind,rid",
        )
        .map_err(err)?;
    let mut result = Vec::new();
    let mut cursor = query.query([history]).map_err(err)?;
    while let Some(row) = cursor.next().map_err(err)? {
        let id: String = row.get(2).map_err(err)?;
        if track_identity(&id).is_some() {
            continue;
        }
        result.push(Row {
            row_id: row.get(1).map_err(err)?,
            entry: Entry {
                kind: match row.get::<_, i64>(0).map_err(err)? {
                    0 => Kind::Favorite,
                    1 => Kind::Playlist,
                    _ => Kind::History,
                },
                track_id: id,
                label: row.get(3).map_err(err)?,
            },
            original: serde_json::from_str(&row.get::<_, String>(4).map_err(err)?).map_err(err)?,
        });
    }
    Ok(result)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn revision(c: &Connection, history: bool, rows: &[Row]) -> Result<String, String> {
    let session = account_session(c).map_err(err)?;
    let input = serde_json::to_vec(&(session, history, rows)).map_err(err)?;
    Ok(super::causal::hash(&input))
}

pub fn preview(c: &Connection, history: bool) -> Result<Option<Preview>, String> {
    let rows = rows(c, history)?;
    if rows.is_empty() {
        return Ok(None);
    }
    Ok(Some(Preview {
        revision: revision(c, history, &rows)?,
        total: rows.len(),
        entries: rows.into_iter().take(50).map(|row| row.entry).collect(),
    }))
}

fn archive(
    c: &Connection,
    directory: &Path,
    uid: &str,
    history: bool,
    expected: &str,
) -> Result<String, String> {
    let tx = c.unchecked_transaction().map_err(err)?;
    let rows = rows(&tx, history)?;
    if rows.is_empty() || revision(&tx, history, &rows)? != expected {
        return Err("本机记录已变化，请重新检查".into());
    }
    let path = directory.join(format!("sync-repair-{}.json", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| "无法保存修复备份")?;
    let backup = serde_json::json!({ "schema": 1, "uid": uid, "rows": rows });
    let bytes = serde_json::to_vec_pretty(&backup).map_err(err)?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "无法保存修复备份")?;
    for row in &rows {
        let statement = match row.entry.kind {
            Kind::Favorite => "DELETE FROM favorites WHERE rowid=?1 AND track_id=?2",
            Kind::Playlist => "DELETE FROM playlist_items WHERE rowid=?1 AND track_id=?2",
            Kind::History => "DELETE FROM play_history WHERE id=?1 AND track_id=?2",
        };
        tx.execute(statement, params![row.row_id, row.entry.track_id])
            .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sync_archive_invalid_track_references(
    database: State<'_, Database>,
    sync: State<'_, SyncState>,
    revision: String,
) -> Result<String, String> {
    let _gate = sync.gate.lock().await;
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    let cfg = config_from_connection(&c)?.unwrap_or_default();
    let uid = if cfg.uid.is_empty() {
        std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default()
    } else {
        cfg.uid
    };
    super::active(&database, &uid)?;
    archive(&c, &database.1, &uid, cfg.history, &revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{model::MISSING_TRACK, storage};

    #[test]
    fn missing_track_repair_archives_only_unidentified_rows_after_confirmation() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let directory =
            std::env::temp_dir().join(format!("sync-repair-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        c.execute_batch(
            "PRAGMA foreign_keys=OFF;
             INSERT INTO playlists(id,name) VALUES('00000000-0000-4000-8000-000000000001','测试歌单');
             INSERT INTO playlist_items(playlist_id,track_id,position)
                VALUES('00000000-0000-4000-8000-000000000001','legacy-id',7);
             INSERT INTO favorites(track_id) VALUES('legacy-id'),('bilibili:BV123:1');
             INSERT INTO play_history(track_id,played_at) VALUES('legacy-id','2024-01-01 00:00:00');
             INSERT INTO playback_positions(track_id,seconds,observed_at) VALUES('legacy-id',12.5,123);
             INSERT INTO local_audio(track_id,path) VALUES('local:1','/test.mp3');
             INSERT INTO favorites(track_id) VALUES('local:1');
             PRAGMA foreign_keys=ON;",
        )
        .unwrap();
        assert!(
            storage::export(&c, "42", true)
                .unwrap_err()
                .ends_with(MISSING_TRACK)
        );
        let check = preview(&c, false).unwrap().unwrap();
        assert_eq!(check.total, 2);
        assert!(archive(&c, &directory, "42", true, &check.revision).is_err());
        let check = preview(&c, true).unwrap().unwrap();
        assert_eq!(check.total, 3);
        c.execute(
            "UPDATE playlist_items SET position=8 WHERE track_id='legacy-id'",
            [],
        )
        .unwrap();
        assert!(archive(&c, &directory, "42", true, &check.revision).is_err());
        let check = preview(&c, true).unwrap().unwrap();
        let other = Connection::open_in_memory().unwrap();
        assert_ne!(
            revision(&other, true, &rows(&c, true).unwrap()).unwrap(),
            check.revision
        );
        assert!(archive(&c, &directory.join("missing"), "42", true, &check.revision).is_err());
        assert_eq!(preview(&c, true).unwrap().unwrap().total, 3);

        let file = archive(&c, &directory, "42", true, &check.revision).unwrap();
        let backup: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        assert_eq!(backup["rows"][1]["original"]["position"], 8);
        assert_eq!(backup["rows"][1]["entry"]["label"], "测试歌单");
        assert_eq!(backup["rows"][2]["original"]["resumeSeconds"], 12.5);
        assert!(preview(&c, true).unwrap().is_none());
        let snapshot = storage::export(&c, "42", true).unwrap();
        assert!(snapshot.records.contains_key("favorite:bilibili:BV123:1"));
        storage::apply(&c, &snapshot, true).unwrap();
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
