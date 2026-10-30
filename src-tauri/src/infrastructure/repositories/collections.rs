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
pub fn list(c: &Connection) -> rusqlite::Result<Collections> {
    let mut q = c.prepare("SELECT id,name FROM collection_folders ORDER BY name,id")?;
    let folders = q
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut q=c.prepare("SELECT bvid,folder_id,title,cover_url,uploader_name FROM collections ORDER BY created_at DESC,bvid")?;
    let items = q
        .query_map([], |r| {
            Ok(Collection {
                bvid: r.get(0)?,
                folder_id: r.get(1)?,
                title: r.get(2)?,
                cover_url: r.get(3)?,
                uploader_name: r.get(4)?,
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
                if !i.bvid.starts_with("BV")
                    || i.bvid.len() > 32
                    || !i.bvid.bytes().all(|b| b.is_ascii_alphanumeric())
                {
                    return Err("无效的BV号".into());
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
                tx.execute("INSERT INTO collections(bvid,folder_id,title,cover_url,uploader_name) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(bvid) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,cover_url=excluded.cover_url,uploader_name=excluded.uploader_name",params![i.bvid,i.folder_id,i.title,i.cover_url,i.uploader_name]).map_err(|e|e.to_string())?;
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
                    "UPDATE collections SET folder_id=?2 WHERE bvid=?1",
                    &[&id, &name],
                )?;
            }
            "remove" => {
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
