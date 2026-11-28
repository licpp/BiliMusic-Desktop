use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

const MAX_COLLECTIONS: usize = 2000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub bvid: String,
    pub folder_id: String,
    pub title: String,
    pub cover_url: String,
    pub uploader_name: String,
    #[serde(default)]
    pub note: String,
}
#[derive(Serialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub scope: String,
}
#[derive(Serialize)]
pub struct Collections {
    pub folders: Vec<Folder>,
    pub items: Vec<Collection>,
}
pub fn valid_reference(value: &str) -> bool {
    if let Some(mid) = value.strip_prefix("up:") {
        return mid.parse::<i64>().is_ok_and(|n| n > 0) && mid.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(rest) = value.strip_prefix("season:") {
        let parts: Vec<_> = rest.split(':').collect();
        return parts.len() == 2
            && parts.iter().all(|s| {
                !s.is_empty()
                    && s.bytes().all(|b| b.is_ascii_digit())
                    && s.parse::<i64>().is_ok_and(|n| n > 0)
            });
    }
    value.starts_with("BV") && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn season_creator_reference(reference: &str) -> Option<String> {
    let (mid, _) = reference.strip_prefix("season:")?.split_once(':')?;
    valid_reference(reference).then(|| format!("up:{mid}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionProgress {
    pub bvid: String,
    pub cid: i64,
    pub position_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_ref: Option<String>,
}

pub fn progress(c: &Connection, reference: &str) -> rusqlite::Result<Option<CollectionProgress>> {
    let creator = reference.starts_with("up:");
    let sql = if creator {
        "SELECT bvid,cid,position_ms,reference FROM collection_progress
         WHERE (reference=?1 OR creator_ref=?1) AND EXISTS(SELECT 1 FROM collections WHERE bvid=?1)
         ORDER BY observed_at DESC,reference DESC LIMIT 1"
    } else {
        "SELECT bvid,cid,position_ms,reference FROM collection_progress WHERE reference=?1"
    };
    c.query_row(sql, [reference], |row| {
        let saved_reference: String = row.get(3)?;
        Ok(CollectionProgress {
            bvid: row.get(0)?,
            cid: row.get(1)?,
            position_ms: row.get(2)?,
            collection_ref: (creator && saved_reference != reference).then_some(saved_reference),
        })
    })
    .optional()
}

pub fn save_progress(
    c: &Connection,
    reference: &str,
    track_id: &str,
    seconds: f64,
    observed_at: i64,
) -> rusqlite::Result<bool> {
    c.execute_batch("SAVEPOINT collection_progress_save")?;
    let result = (|| {
        let (changed, previous) =
            save_progress_in_transaction(c, reference, track_id, seconds, observed_at)?;
        if let Some(previous) = previous {
            super::track_cleanup::collect_unreferenced(c, &[previous])?;
        }
        Ok(changed)
    })();
    match result {
        Ok(changed) => {
            c.execute_batch("RELEASE collection_progress_save")?;
            Ok(changed)
        }
        Err(error) => {
            let _ = c.execute_batch(
                "ROLLBACK TO collection_progress_save; RELEASE collection_progress_save",
            );
            Err(error)
        }
    }
}

/// Returns the previous track if the update moved this collection checkpoint.
/// The caller checks remaining references after all changes in its transaction.
pub(crate) fn save_progress_in_transaction(
    c: &Connection,
    reference: &str,
    track_id: &str,
    seconds: f64,
    observed_at: i64,
) -> rusqlite::Result<(bool, Option<String>)> {
    let Some((bvid, cid)) = track_id
        .strip_prefix("bilibili:")
        .and_then(|id| id.split_once(':'))
    else {
        return Ok((false, None));
    };
    let Ok(cid) = cid.parse::<i64>() else {
        return Ok((false, None));
    };
    if bvid.len() <= 2
        || !bvid.starts_with("BV")
        || !valid_reference(bvid)
        || !valid_reference(reference)
        || cid <= 0
        || (reference != bvid && !reference.starts_with("season:") && !reference.starts_with("up:"))
        || !seconds.is_finite()
        || !(0.0..=604800.0).contains(&seconds)
        || !(1..=9_007_199_254_740_991).contains(&observed_at)
    {
        return Ok((false, None));
    }
    let previous = c
        .query_row(
            "SELECT t.id FROM collection_progress p
         JOIN source_items s ON s.provider='bilibili' AND s.bvid=p.bvid AND s.cid=p.cid
         JOIN tracks t ON t.source_item_id=s.id
         WHERE p.reference=?1 AND (p.bvid<>?2 OR p.cid<>?3) AND p.observed_at<=?4",
            params![reference, bvid, cid, observed_at],
            |r| r.get(0),
        )
        .optional()?;
    let changed = c.execute(
        "INSERT INTO collection_progress(reference,bvid,cid,position_ms,observed_at)
         SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM collections WHERE bvid=?1 OR bvid=?6)
         ON CONFLICT(reference) DO UPDATE SET bvid=excluded.bvid,cid=excluded.cid,position_ms=excluded.position_ms,observed_at=excluded.observed_at
         WHERE excluded.observed_at >= collection_progress.observed_at",
        params![reference, bvid, cid, (seconds * 1000.0).round() as i64, observed_at, season_creator_reference(reference)],
    )? > 0;
    Ok((changed, previous.filter(|_| changed)))
}

pub fn prune_progress(c: &Connection) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM collection_progress AS p
         WHERE NOT EXISTS(SELECT 1 FROM collections c WHERE c.bvid=p.reference OR c.bvid=p.creator_ref)",
        [],
    )
}
pub fn init_folders(c: &Connection) -> rusqlite::Result<()> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_folders') WHERE name='scope')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        c.execute_batch(
            "ALTER TABLE collection_folders ADD COLUMN scope TEXT NOT NULL DEFAULT 'collections';",
        )?;
    }
    Ok(())
}
/// Split legacy mixed folders deterministically, so independent devices converge on the same new folder ID.
pub fn separate_legacy_folders(c: &Connection) -> rusqlite::Result<()> {
    init_folders(c)?;
    let mut q=c.prepare("SELECT f.id,f.name FROM collection_folders f WHERE f.scope='collections' AND EXISTS(SELECT 1 FROM collections WHERE folder_id=f.id AND bvid LIKE 'up:%')")?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, name) in rows {
        let mixed: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE folder_id=?1 AND bvid NOT LIKE 'up:%')",
            [&id],
            |r| r.get(0),
        )?;
        if mixed {
            let mut bytes = md5::compute(format!("BiliMusic creator folder:{id}")).0;
            bytes[6] = (bytes[6] & 15) | 128;
            bytes[8] = (bytes[8] & 63) | 128;
            let creator_id = uuid::Uuid::from_bytes(bytes).to_string();
            c.execute("INSERT INTO collection_folders(id,name,scope) VALUES(?1,?2,'creators') ON CONFLICT(id) DO NOTHING",params![creator_id,name])?;
            c.execute(
                "UPDATE collections SET folder_id=?2 WHERE folder_id=?1 AND bvid LIKE 'up:%'",
                params![id, creator_id],
            )?;
        } else {
            c.execute(
                "UPDATE collection_folders SET scope='creators' WHERE id=?1",
                [id],
            )?;
        }
    }
    Ok(())
}
pub fn list(c: &Connection) -> rusqlite::Result<Collections> {
    let mut q = c.prepare(
        "SELECT id,name,scope FROM collection_folders ORDER BY created_at DESC,rowid DESC",
    )?;
    let folders = q
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                scope: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut q=c.prepare("SELECT c.bvid,c.folder_id,c.title,c.cover_url,c.uploader_name,COALESCE(n.note,'') FROM collections c LEFT JOIN creator_notes n ON n.bvid=c.bvid ORDER BY c.created_at DESC,c.rowid DESC")?;
    let items = q
        .query_map([], |r| {
            Ok(Collection {
                bvid: r.get(0)?,
                folder_id: r.get(1)?,
                title: r.get(2)?,
                cover_url: r.get(3)?,
                uploader_name: r.get(4)?,
                note: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Collections { folders, items })
}

fn validate_metadata(item: &Collection) -> Result<(), String> {
    if [&item.title, &item.cover_url, &item.uploader_name]
        .into_iter()
        .any(|value| value.len() > 4096)
    {
        return Err("合集信息过长".into());
    }
    Ok(())
}

pub fn import_seasons(c: &mut Connection, items: &[Collection]) -> Result<usize, String> {
    for item in items {
        if !item.bvid.starts_with("season:") || !valid_reference(&item.bvid) {
            return Err("订阅合集标识无效".into());
        }
        validate_metadata(item)?;
    }
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let count = tx
        .query_row("SELECT COUNT(*) FROM collections", [], |r| {
            r.get::<_, usize>(0)
        })
        .map_err(|e| e.to_string())?;
    let mut inserted = 0;
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO collections(bvid,folder_id,title,cover_url,uploader_name,created_at)
                 VALUES(?1,'',?2,?3,?4,strftime('%Y-%m-%d %H:%M:%f','now'))
                 ON CONFLICT(bvid) DO NOTHING",
            )
            .map_err(|e| e.to_string())?;
        for item in items.iter().rev() {
            inserted += insert
                .execute(params![
                    item.bvid,
                    item.title,
                    item.cover_url,
                    item.uploader_name
                ])
                .map_err(|e| e.to_string())?;
            if inserted > 0 && count + inserted > MAX_COLLECTIONS {
                return Err(format!("最多收藏 {MAX_COLLECTIONS} 个合集"));
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

pub fn change(
    c: &mut Connection,
    action: &str,
    id: &str,
    name: &str,
    item: Option<Collection>,
) -> Result<(), String> {
    init_folders(c).map_err(|e| e.to_string())?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let run = || -> Result<(), String> {
        let folder_exists = |id: &str, creator: bool| -> Result<bool, String> {
            if id.is_empty() {
                return Ok(true);
            }
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM collection_folders WHERE id=?1 AND scope=?2)",
                params![id, if creator { "creators" } else { "collections" }],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
        };
        let execute = |sql: &str, args: &[&dyn rusqlite::ToSql]| {
            tx.execute(sql, args).map_err(|e| e.to_string())
        };
        match action {
            "create" | "createCreator" | "rename" => {
                if name.trim().is_empty() || name.chars().count() > 80 {
                    return Err("文件夹名称需要1至80个字符".into());
                }
                if action == "create" || action == "createCreator" {
                    if tx
                        .query_row("SELECT COUNT(*) FROM collection_folders", [], |r| {
                            r.get::<_, i64>(0)
                        })
                        .map_err(|e| e.to_string())?
                        >= 100
                    {
                        return Err("最多创建100个文件夹".into());
                    }
                    execute(
                        "INSERT INTO collection_folders(id,name,scope) VALUES(?1,?2,?3)",
                        &[
                            &uuid::Uuid::new_v4().to_string(),
                            &name.trim(),
                            &if action == "createCreator" {
                                "creators"
                            } else {
                                "collections"
                            },
                        ],
                    )?;
                } else {
                    if id.is_empty() {
                        return Err("默认收藏夹不能重命名".into());
                    }
                    execute(
                        "UPDATE collection_folders SET name=?2 WHERE id=?1",
                        &[&id, &name.trim()],
                    )?;
                }
            }
            "delete" => {
                if id.is_empty() {
                    return Err("默认收藏夹不能删除".into());
                }
                execute(
                    "UPDATE collections SET folder_id='' WHERE folder_id=?1",
                    &[&id],
                )?;
                execute("DELETE FROM collection_folders WHERE id=?1", &[&id])?;
            }
            "save" | "importCreator" => {
                let i = item.ok_or("缺少合集信息")?;
                let creator = i.bvid.starts_with("up:");
                if !valid_reference(&i.bvid) || action == "importCreator" && !creator {
                    return Err("收藏标识无效".into());
                }
                if !folder_exists(&i.folder_id, creator)? {
                    return Err("文件夹不存在或类型不匹配".into());
                }
                validate_metadata(&i)?;
                if tx
                    .query_row(
                        "SELECT COUNT(*) FROM collections WHERE bvid<>?1",
                        [&i.bvid],
                        |r| r.get::<_, usize>(0),
                    )
                    .map_err(|e| e.to_string())?
                    >= MAX_COLLECTIONS
                {
                    return Err(format!("最多收藏 {MAX_COLLECTIONS} 个合集"));
                }
                let on_conflict = if action == "importCreator" {
                    "DO NOTHING"
                } else {
                    "DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,cover_url=excluded.cover_url,uploader_name=excluded.uploader_name,created_at=excluded.created_at"
                };
                tx.execute(
                    &format!("INSERT INTO collections(bvid,folder_id,title,cover_url,uploader_name,created_at) VALUES(?1,?2,?3,?4,?5,strftime('%Y-%m-%d %H:%M:%f','now')) ON CONFLICT(bvid) {on_conflict}"),
                    params![i.bvid, i.folder_id, i.title, i.cover_url, i.uploader_name],
                ).map_err(|e|e.to_string())?;
            }
            "cache" => {
                let i = item.ok_or("缺少合集信息")?;
                validate_metadata(&i)?;
                tx.execute(
                    "UPDATE collections SET title=COALESCE(NULLIF(?2,''),title), cover_url=COALESCE(NULLIF(?3,''),cover_url),
                     uploader_name=COALESCE(NULLIF(?4,''),uploader_name) WHERE bvid=?1
                     AND ((?2<>'' AND title<>?2) OR (?3<>'' AND cover_url<>?3) OR (?4<>'' AND uploader_name<>?4))",
                    params![i.bvid, i.title, i.cover_url, i.uploader_name],
                )
                .map_err(|e| e.to_string())?;
            }
            "move" => {
                if !folder_exists(name, id.starts_with("up:"))? {
                    return Err("文件夹不存在或类型不匹配".into());
                }
                execute(
                    "UPDATE collections SET folder_id=?2,created_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE bvid=?1 AND folder_id<>?2",
                    &[&id, &name],
                )?;
            }
            "note" => {
                if !id.starts_with("up:") || !valid_reference(id) || name.chars().count() > 160 {
                    return Err("备注最多160个字符".into());
                }
                if tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM collections WHERE bvid=?1)",
                        [id],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(|e| e.to_string())?
                {
                    execute(
                        "INSERT INTO creator_notes(bvid,note) VALUES(?1,?2) ON CONFLICT(bvid) DO UPDATE SET note=excluded.note",
                        &[&id, &name.trim()],
                    )?;
                } else {
                    return Err("请先关注这个 UP 主".into());
                }
            }
            "remove" => {
                let candidates = super::track_cleanup::collection_candidates(&tx, id)
                    .map_err(|e| e.to_string())?;
                execute("DELETE FROM creator_notes WHERE bvid=?1", &[&id])?;
                let removed = execute("DELETE FROM collections WHERE bvid=?1", &[&id])?;
                prune_progress(&tx).map_err(|e| e.to_string())?;
                if removed > 0 {
                    super::track_cleanup::collect_unreferenced(&tx, &candidates)
                        .map_err(|e| e.to_string())?;
                }
            }
            _ => return Err("不支持的收藏操作".into()),
        }
        Ok(())
    };
    run()?;
    tx.commit().map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advancing_a_collection_checkpoint_releases_its_previous_track() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute_batch(
            "INSERT INTO collections(bvid) VALUES ('up:42');
             INSERT INTO source_items(id,provider,bvid,cid) VALUES
                 ('bilibili:BVcheckpoint:1','bilibili','BVcheckpoint',1),
                 ('bilibili:BVcheckpoint:2','bilibili','BVcheckpoint',2);
             INSERT INTO tracks(id,source_item_id,title) SELECT id,id,'Track' FROM source_items;
             INSERT INTO metadata_overrides(track_id,title) VALUES ('bilibili:BVcheckpoint:1','Edit');
             INSERT INTO saved_chapters VALUES ('BVcheckpoint',1,'{}'),('BVcheckpoint',2,'{}');",
        ).unwrap();
        let first = "bilibili:BVcheckpoint:1";
        let second = "bilibili:BVcheckpoint:2";
        assert!(save_progress(&c, "season:42:99", first, 30.0, 20).unwrap());
        assert!(!save_progress(&c, "season:42:99", second, 40.0, 15).unwrap());
        assert!(save_progress(&c, "season:42:99", first, 35.0, 25).unwrap());
        let count = |sql| c.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM metadata_overrides"), 1);
        assert!(save_progress(&c, "season:42:99", second, 40.0, 30).unwrap());
        assert_eq!(count("SELECT COUNT(*) FROM metadata_overrides"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM saved_chapters WHERE cid=1"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM saved_chapters WHERE cid=2"), 1);
    }

    fn season(id: usize, title: &str, folder_id: &str) -> Collection {
        Collection {
            bvid: format!("season:42:{id}"),
            folder_id: folder_id.into(),
            title: title.into(),
            cover_url: String::new(),
            uploader_name: "UP 主".into(),
            note: String::new(),
        }
    }

    #[test]
    fn import_seasons_preserves_existing_collections_and_playback_progress() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        change(&mut c, "create", "", "已有分组", None).unwrap();
        let folder = list(&c).unwrap().folders.remove(0).id;
        change(&mut c, "save", "", "", Some(season(1, "原标题", &folder))).unwrap();
        assert!(save_progress(&c, "season:42:1", "bilibili:BV123:66", 22.0, 1).unwrap());

        let items = [season(1, "来源标题", ""), season(2, "新合集", "")];
        assert_eq!(import_seasons(&mut c, &items).unwrap(), 1);
        assert_eq!(import_seasons(&mut c, &items).unwrap(), 0);
        let saved = list(&c).unwrap().items;
        assert_eq!(saved.len(), 2);
        let existing = saved
            .iter()
            .find(|item| item.bvid == "season:42:1")
            .unwrap();
        assert_eq!(existing.folder_id, folder);
        assert_eq!(existing.title, "原标题");
        assert_eq!(
            progress(&c, "season:42:1").unwrap().unwrap().position_ms,
            22000
        );
        assert!(
            saved
                .iter()
                .find(|item| item.bvid == "season:42:2")
                .unwrap()
                .folder_id
                .is_empty()
        );
    }

    #[test]
    fn importing_an_existing_creator_preserves_its_group_and_name() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        change(&mut c, "createCreator", "", "已有分组", None).unwrap();
        let folder = list(&c).unwrap().folders.remove(0).id;
        let creator = |title: &str, folder_id: &str| Collection {
            bvid: "up:42".into(),
            folder_id: folder_id.into(),
            title: title.into(),
            cover_url: String::new(),
            uploader_name: title.into(),
            note: String::new(),
        };
        change(
            &mut c,
            "importCreator",
            "",
            "",
            Some(creator("原标题", &folder)),
        )
        .unwrap();
        change(
            &mut c,
            "importCreator",
            "",
            "",
            Some(creator("来源标题", "")),
        )
        .unwrap();
        let items = list(&c).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].folder_id, folder);
        assert_eq!(items[0].title, "原标题");
        assert!(change(&mut c, "importCreator", "", "", Some(season(1, "合集", ""))).is_err());
    }

    #[test]
    fn import_seasons_is_atomic_if_collection_limit_is_reached() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let initial = (1..MAX_COLLECTIONS)
            .map(|id| season(id, "已有合集", ""))
            .collect::<Vec<_>>();
        assert_eq!(
            import_seasons(&mut c, &initial).unwrap(),
            MAX_COLLECTIONS - 1
        );
        let batch = [
            season(MAX_COLLECTIONS, "新合集", ""),
            season(MAX_COLLECTIONS + 1, "另一个合集", ""),
        ];
        assert!(import_seasons(&mut c, &batch).is_err());
        assert_eq!(list(&c).unwrap().items.len(), MAX_COLLECTIONS - 1);
        assert_eq!(import_seasons(&mut c, &batch[..1]).unwrap(), 1);
        assert_eq!(import_seasons(&mut c, &batch[..1]).unwrap(), 0);
    }
    #[test]
    fn creator_notes_survive_cache_refresh_and_group_changes() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let up = || Collection {
            bvid: "up:123".into(),
            folder_id: String::new(),
            title: "昵称".into(),
            cover_url: String::new(),
            uploader_name: String::new(),
            note: String::new(),
        };
        change(&mut c, "save", "", "", Some(up())).unwrap();
        change(&mut c, "note", "up:123", "声音很好听", None).unwrap();
        change(&mut c, "cache", "", "", Some(up())).unwrap();
        change(&mut c, "createCreator", "", "听书", None).unwrap();
        let folder = list(&c).unwrap().folders.remove(0).id;
        change(&mut c, "move", "up:123", &folder, None).unwrap();
        assert_eq!(list(&c).unwrap().items[0].note, "声音很好听");
        change(&mut c, "delete", &folder, "", None).unwrap();
        let item = list(&c).unwrap().items.remove(0);
        assert!(item.folder_id.is_empty());
        assert_eq!(item.note, "声音很好听");
        assert!(change(&mut c, "note", "up:123", &"长".repeat(161), None).is_err());
        change(&mut c, "remove", "up:123", "", None).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM creator_notes", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn folder_delete_moves_bookmarks_without_creating_tracks() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        change(&mut c, "create", "", "听书", None).unwrap();
        let folder = list(&c).unwrap().folders.remove(0).id;
        change(
            &mut c,
            "save",
            "",
            "",
            Some(Collection {
                bvid: "BV123".into(),
                folder_id: folder.clone(),
                title: "合集".into(),
                cover_url: "".into(),
                uploader_name: "".into(),
                note: String::new(),
            }),
        )
        .unwrap();
        change(&mut c, "delete", &folder, "", None).unwrap();
        assert_eq!(list(&c).unwrap().items[0].folder_id, "");
        assert!(change(&mut c, "delete", "", "", None).is_err());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn creator_and_collection_folders_are_independent_and_reject_cross_moves() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        change(&mut c, "create", "", "收藏组", None).unwrap();
        change(&mut c, "createCreator", "", "UP组", None).unwrap();
        let folders = list(&c).unwrap().folders;
        let creator = folders
            .iter()
            .find(|f| f.scope == "creators")
            .unwrap()
            .id
            .clone();
        let collection = folders
            .iter()
            .find(|f| f.scope == "collections")
            .unwrap()
            .id
            .clone();
        change(
            &mut c,
            "save",
            "",
            "",
            Some(Collection {
                bvid: "up:123".into(),
                folder_id: creator.clone(),
                title: "UP".into(),
                cover_url: String::new(),
                uploader_name: String::new(),
                note: String::new(),
            }),
        )
        .unwrap();
        assert!(change(&mut c, "move", "up:123", &collection, None).is_err());
        change(&mut c, "delete", &creator, "", None).unwrap();
        let data = list(&c).unwrap();
        assert_eq!(data.folders.len(), 1);
        assert_eq!(data.folders[0].id, collection);
        assert!(data.items[0].folder_id.is_empty());
    }
    #[test]
    fn legacy_mixed_folder_splits_once_without_losing_members() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        c.execute(
            "INSERT INTO collection_folders(id,name) VALUES(?1,'旧文件夹')",
            [&id],
        )
        .unwrap();
        for reference in ["up:123", "BV1test"] {
            c.execute(
                "INSERT INTO collections(bvid,folder_id) VALUES(?1,?2)",
                params![reference, id],
            )
            .unwrap();
        }
        c.execute_batch("PRAGMA user_version=1; DELETE FROM schema_migrations; DROP TRIGGER collection_folder_created; ALTER TABLE collection_folders DROP COLUMN created_at;").unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let data = list(&c).unwrap();
        assert_eq!(data.folders.len(), 2);
        let up = data.items.iter().find(|i| i.bvid == "up:123").unwrap();
        let group = data.folders.iter().find(|f| f.scope == "creators").unwrap();
        assert_eq!(up.folder_id, group.id);
        assert_ne!(group.id, id);
        assert_eq!(
            data.items
                .iter()
                .find(|i| i.bvid == "BV1test")
                .unwrap()
                .folder_id,
            id
        );
        assert_eq!(list(&c).unwrap().folders.len(), 2);
    }

    #[test]
    fn followed_season_progress_uses_the_same_checkpoint_after_favoriting() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let first = "season:42:73";
        let second = "season:42:74";
        let song = "bilibili:BV1tZuKzgENQ:7";
        assert!(!save_progress(&c, first, song, 12.0, 100).unwrap());
        c.execute("INSERT INTO collections(bvid) VALUES('up:42')", [])
            .unwrap();
        assert!(save_progress(&c, first, song, 12.0, 100).unwrap());
        assert!(save_progress(&c, second, song, 25.0, 200).unwrap());
        assert!(save_progress(&c, "up:42", song, 55.0, 300).unwrap());
        assert_eq!(progress(&c, "up:42").unwrap().unwrap().collection_ref, None);

        c.execute("INSERT INTO collections(bvid) VALUES(?1)", [first])
            .unwrap();
        assert!(save_progress(&c, first, song, 65.0, 400).unwrap());
        assert!(!save_progress(&c, first, song, 18.0, 390).unwrap());
        assert_eq!(
            progress(&c, "up:42")
                .unwrap()
                .unwrap()
                .collection_ref
                .as_deref(),
            Some(first)
        );
        assert_eq!(progress(&c, first).unwrap().unwrap().position_ms, 65_000);
        assert_eq!(progress(&c, second).unwrap().unwrap().position_ms, 25_000);
        assert!(progress(&c, "season:42:75").unwrap().is_none());

        c.execute("DELETE FROM collections WHERE bvid=?1", [first])
            .unwrap();
        assert_eq!(prune_progress(&c).unwrap(), 0);
        assert_eq!(progress(&c, first).unwrap().unwrap().position_ms, 65_000);
        c.execute("INSERT INTO collections(bvid) VALUES(?1)", [second])
            .unwrap();
        c.execute("DELETE FROM collections WHERE bvid='up:42'", [])
            .unwrap();
        assert_eq!(prune_progress(&c).unwrap(), 2);
        assert!(progress(&c, first).unwrap().is_none());
        assert_eq!(progress(&c, second).unwrap().unwrap().position_ms, 25_000);
    }
}
