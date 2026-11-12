use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
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
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionProgress {
    pub bvid: String,
    pub cid: i64,
    pub position_ms: i64,
}

pub fn progress(c: &Connection, reference: &str) -> rusqlite::Result<Option<CollectionProgress>> {
    use rusqlite::OptionalExtension;
    c.query_row(
        "SELECT bvid,cid,position_ms FROM collection_progress WHERE reference=?1",
        [reference],
        |row| {
            Ok(CollectionProgress {
                bvid: row.get(0)?,
                cid: row.get(1)?,
                position_ms: row.get(2)?,
            })
        },
    )
    .optional()
}

pub fn save_progress(
    c: &Connection,
    reference: &str,
    track_id: &str,
    seconds: f64,
    observed_at: i64,
) -> rusqlite::Result<bool> {
    let Some((bvid, cid)) = track_id
        .strip_prefix("bilibili:")
        .and_then(|id| id.split_once(':'))
    else {
        return Ok(false);
    };
    let Ok(cid) = cid.parse::<i64>() else {
        return Ok(false);
    };
    if bvid.len() <= 2
        || !bvid.starts_with("BV")
        || !valid_reference(bvid)
        || cid <= 0
        || (reference != bvid && !reference.starts_with("season:") && !reference.starts_with("up:"))
        || !seconds.is_finite()
        || !(0.0..=604800.0).contains(&seconds)
        || observed_at <= 0
    {
        return Ok(false);
    }
    c.execute(
        "INSERT INTO collection_progress(reference,bvid,cid,position_ms,observed_at)
         SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM collections WHERE bvid=?1)
         ON CONFLICT(reference) DO UPDATE SET bvid=excluded.bvid,cid=excluded.cid,position_ms=excluded.position_ms,observed_at=excluded.observed_at
         WHERE excluded.observed_at >= collection_progress.observed_at",
        params![reference, bvid, cid, (seconds * 1000.0).round() as i64, observed_at],
    ).map(|changed| changed > 0)
}
pub fn list(c: &Connection) -> rusqlite::Result<Collections> {
    let mut q = c.prepare("SELECT id,name FROM collection_folders ORDER BY rowid DESC")?;
    let folders = q
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
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
pub fn change(
    c: &mut Connection,
    action: &str,
    id: &str,
    name: &str,
    item: Option<Collection>,
) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let run = || -> Result<(), String> {
        let folder_exists = |id: &str| -> Result<bool, String> {
            if id.is_empty() {
                return Ok(true);
            }
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM collection_folders WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
        };
        let execute = |sql: &str, args: &[&dyn rusqlite::ToSql]| {
            tx.execute(sql, args).map_err(|e| e.to_string())
        };
        match action {
            "create" | "rename" => {
                if name.trim().is_empty() || name.chars().count() > 80 {
                    return Err("收藏夹名称需要1至80个字符".into());
                }
                if action == "create" {
                    if tx
                        .query_row("SELECT COUNT(*) FROM collection_folders", [], |r| {
                            r.get::<_, i64>(0)
                        })
                        .map_err(|e| e.to_string())?
                        >= 100
                    {
                        return Err("最多创建100个收藏夹".into());
                    }
                    execute(
                        "INSERT INTO collection_folders(id,name) VALUES(?1,?2)",
                        &[&uuid::Uuid::new_v4().to_string(), &name.trim()],
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
            "save" => {
                let i = item.ok_or("缺少合集信息")?;
                if !valid_reference(&i.bvid) {
                    return Err("收藏标识无效".into());
                }
                if !folder_exists(&i.folder_id)? {
                    return Err("收藏夹不存在".into());
                }
                if i.title.len() > 4096 || i.cover_url.len() > 4096 || i.uploader_name.len() > 4096
                {
                    return Err("合集信息过长".into());
                }
                if tx
                    .query_row(
                        "SELECT COUNT(*) FROM collections WHERE bvid<>?1",
                        [&i.bvid],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(|e| e.to_string())?
                    >= 2000
                {
                    return Err("最多收藏2000个合集".into());
                }
                tx.execute("INSERT INTO collections(bvid,folder_id,title,cover_url,uploader_name,created_at) VALUES(?1,?2,?3,?4,?5,strftime('%Y-%m-%d %H:%M:%f','now')) ON CONFLICT(bvid) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,cover_url=excluded.cover_url,uploader_name=excluded.uploader_name,created_at=excluded.created_at",params![i.bvid,i.folder_id,i.title,i.cover_url,i.uploader_name]).map_err(|e|e.to_string())?;
            }
            "cache" => {
                let i = item.ok_or("缺少合集信息")?;
                if i.title.len() > 4096 || i.cover_url.len() > 4096 || i.uploader_name.len() > 4096
                {
                    return Err("合集信息过长".into());
                }
                tx.execute(
                    "UPDATE collections SET title=?2,cover_url=?3,uploader_name=?4 WHERE bvid=?1",
                    params![i.bvid, i.title, i.cover_url, i.uploader_name],
                )
                .map_err(|e| e.to_string())?;
            }
            "move" => {
                if !folder_exists(name)? {
                    return Err("收藏夹不存在".into());
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
                execute("DELETE FROM creator_notes WHERE bvid=?1", &[&id])?;
                execute("DELETE FROM collection_progress WHERE reference=?1", &[&id])?;
                execute("DELETE FROM collections WHERE bvid=?1", &[&id])?;
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
    fn creator_notes_survive_cache_refresh_and_group_changes() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
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
        change(&mut c, "create", "", "听书", None).unwrap();
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
        c.execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
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
}
