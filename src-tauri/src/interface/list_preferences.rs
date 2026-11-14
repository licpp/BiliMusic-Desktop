//! Small per-list view preferences. No materialized song ordering is uploaded.
use crate::{
    infrastructure::database::Database,
    sync::model::{text, Snapshot},
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preference {
    pub entity: String,
    pub display_rank: Option<String>,
    pub sort_rule: Option<String>,
}
pub fn valid_rank(value: &str) -> bool {
    value.len() == 20 && value.bytes().all(|b| b.is_ascii_digit())
}
pub fn valid_rule(value: &str) -> bool {
    matches!(
        value,
        "source:asc" | "source:desc" | "name:asc" | "name:desc" | "date:asc" | "date:desc"
    )
}
pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS list_preferences(entity TEXT PRIMARY KEY,display_rank TEXT,sort_rule TEXT);")
}
#[tauri::command]
pub fn list_preferences(database: State<'_, Database>) -> Result<serde_json::Value, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    let mut q = c
        .prepare("SELECT entity,display_rank,sort_rule FROM list_preferences")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| {
            Ok(Preference {
                entity: r.get(0)?,
                display_rank: r.get(1)?,
                sort_rule: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut dates = BTreeMap::new();
    let mut q=c.prepare("SELECT substr(key,18),CAST(value AS INTEGER) FROM sync_info WHERE key LIKE 'source-published:%'").map_err(|e|e.to_string())?;
    for row in q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (key, value) = row.map_err(|e| e.to_string())?;
        if value > 0 {
            dates.insert(key, value);
        }
    }
    Ok(serde_json::json!({"preferences":rows,"dates":dates}))
}
pub fn save(c: &Connection, changes: &[Preference]) -> Result<(), String> {
    if changes.len() > 3000 {
        return Err("一次整理的项目过多".into());
    }
    let uid = c
        .query_row(
            "SELECT json_extract(json,'$.uid') FROM sync_settings WHERE id=1",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            c.query_row(
                "SELECT CAST(owner_uid AS TEXT) FROM linked_bili_folders LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok()
        })
        .unwrap_or("1".into());
    let snapshot = crate::sync::storage::export(c, &uid, false)?;
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    for row in changes {
        let local_collection_rule = row.display_rank.is_none()
            && row.sort_rule.is_some()
            && row
                .entity
                .strip_prefix("collection:")
                .is_some_and(crate::infrastructure::repositories::collections::valid_reference);
        if !local_collection_rule
            && !matches!(row.entity.as_str(), "view:favorites" | "view:saved")
            && !snapshot.records.get(&row.entity).is_some_and(|r| {
                matches!(
                    r.kind.as_str(),
                    "playlist" | "linkedFolder" | "collectionFolder" | "collection"
                )
            })
        {
            return Err("收藏已被删除，请刷新列表后重试".into());
        }
        if row.display_rank.as_ref().is_some_and(|s| !valid_rank(s))
            || row.sort_rule.as_ref().is_some_and(|s| !valid_rule(s))
        {
            return Err("排序设置无效".into());
        }
        c.execute("INSERT INTO list_preferences(entity,display_rank,sort_rule) VALUES(?1,?2,?3) ON CONFLICT(entity) DO UPDATE SET display_rank=COALESCE(excluded.display_rank,display_rank),sort_rule=COALESCE(excluded.sort_rule,sort_rule)",params![row.entity,row.display_rank,row.sort_rule]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn list_preferences_save(
    database: State<'_, Database>,
    changes: Vec<Preference>,
) -> Result<(), String> {
    {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        save(&c, &changes)
    }
}
pub fn export(c: &Connection, snapshot: &mut Snapshot) -> Result<(), String> {
    let mut q = c
        .prepare("SELECT entity,display_rank,sort_rule FROM list_preferences")
        .map_err(|e| e.to_string())?;
    for row in q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (id, rank, rule) = row.map_err(|e| e.to_string())?;
        if matches!(id.as_str(), "view:favorites" | "view:saved") {
            snapshot
                .records
                .entry(id.clone())
                .or_insert_with(|| crate::sync::model::Record {
                    kind: "view".into(),
                    fields: std::collections::BTreeMap::from([(
                        "id".into(),
                        id.strip_prefix("view:").unwrap().into(),
                    )]),
                });
        }
        if let Some(r) = snapshot.records.get_mut(&id) {
            if let Some(rank) = rank {
                r.fields.insert("displayRank".into(), rank.into());
            }
            if let Some(rule) = rule {
                r.fields.insert("sortRule".into(), rule.into());
            }
        }
    }
    Ok(())
}
pub fn apply(c: &Connection, s: &Snapshot) -> rusqlite::Result<()> {
    c.execute("DELETE FROM list_preferences", [])?;
    for (entity, r) in &s.records {
        let rank = text(r, "displayRank");
        let rule = text(r, "sortRule");
        if !rank.is_empty() || !rule.is_empty() {
            c.execute(
                "INSERT INTO list_preferences VALUES(?1,?2,?3)",
                params![
                    entity,
                    if rank.is_empty() { None } else { Some(rank) },
                    if rule.is_empty() { None } else { Some(rule) }
                ],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn virtual_views_and_preferences_round_trip_without_creating_playlists_or_song_positions() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        save(
            &c,
            &[Preference {
                entity: "view:favorites".into(),
                display_rank: None,
                sort_rule: Some("name:desc".into()),
            }],
        )
        .unwrap();
        let snapshot = crate::sync::storage::export(&c, "42", false).unwrap();
        assert!(snapshot.records.contains_key("view:favorites"));
        let target = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&target).unwrap();
        crate::sync::storage::apply(&target, &snapshot, false).unwrap();
        assert_eq!(
            target
                .query_row(
                    "SELECT sort_rule FROM list_preferences WHERE entity='view:favorites'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "name:desc"
        );
        assert_eq!(
            target
                .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(save(
            &c,
            &[Preference {
                entity: "view:favorites".into(),
                display_rank: None,
                sort_rule: Some("invalid".into())
            }]
        )
        .is_err());
        save(
            &c,
            &[Preference {
                entity: "collection:BV1GFRFBREe6".into(),
                display_rank: None,
                sort_rule: Some("source:desc".into()),
            }],
        )
        .unwrap();
        let local_view = crate::sync::storage::export(&c, "42", false).unwrap();
        assert!(!local_view.records.contains_key("collection:BV1GFRFBREe6"));
        assert!(save(
            &c,
            &[Preference {
                entity: "playlist:deleted".into(),
                display_rank: None,
                sort_rule: Some("name:asc".into())
            }]
        )
        .is_err());
    }
}
