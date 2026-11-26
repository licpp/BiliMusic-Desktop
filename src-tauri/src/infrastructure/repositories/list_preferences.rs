//! Small per-list view preferences. No materialized song ordering is uploaded.
use crate::sync::model::{Snapshot, text};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preference {
    pub entity: String,
    pub display_rank: Option<String>,
    pub sort_rule: Option<String>,
}
pub use crate::domain::list_preferences::{valid_rank, valid_rule};
pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS list_preferences(entity TEXT PRIMARY KEY,display_rank TEXT,sort_rule TEXT);")
}

pub fn read(c: &Connection) -> Result<serde_json::Value, String> {
    let mut q = c
        .prepare("SELECT entity,display_rank,sort_rule FROM list_preferences")
        .map_err(|e| e.to_string())?;
    let mut rows = q
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
    let mut play_counts = BTreeMap::new();
    let mut q = c.prepare("SELECT substr(key,14),CAST(value AS INTEGER) FROM sync_info WHERE key LIKE 'source-plays:%'").map_err(|e|e.to_string())?;
    for row in q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (id, value) = row.map_err(|e| e.to_string())?;
        play_counts.insert(id, value);
    }
    // New view-only rules stay local: older clients validate synchronized rule
    // names strictly. A play-count preference must not make their sync fail.
    let mut q = c
        .prepare("SELECT substr(key,12),value FROM sync_info WHERE key LIKE 'local-sort:%'")
        .map_err(|e| e.to_string())?;
    for row in q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
    {
        let (entity, rule) = row.map_err(|e| e.to_string())?;
        if let Some(row) = rows.iter_mut().find(|row| row.entity == entity) {
            row.sort_rule = Some(rule);
        } else {
            rows.push(Preference {
                entity,
                display_rank: None,
                sort_rule: Some(rule),
            });
        }
    }
    Ok(serde_json::json!({"preferences":rows,"dates":dates,"playCounts":play_counts}))
}
fn entity_exists(c: &Connection, entity: &str) -> Result<bool, String> {
    let Some((kind, id)) = entity.split_once(':') else {
        return Ok(false);
    };
    let sql = match kind {
        "playlist" => "SELECT EXISTS(SELECT 1 FROM playlists WHERE id=?1)",
        "linkedFolder" => {
            "SELECT EXISTS(SELECT 1 FROM linked_bili_folders WHERE folder_id=CAST(?1 AS INTEGER) AND CAST(folder_id AS TEXT)=?1)"
        }
        "collectionFolder" => "SELECT EXISTS(SELECT 1 FROM collection_folders WHERE id=?1)",
        "collection" => "SELECT EXISTS(SELECT 1 FROM collections WHERE bvid=?1)",
        _ => return Ok(false),
    };
    c.query_row(sql, [id], |r| r.get(0))
        .map_err(|e| e.to_string())
}
pub fn save(c: &Connection, changes: &[Preference]) -> Result<(), String> {
    if changes.len() > 3000 {
        return Err("一次整理的项目过多".into());
    }
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    save_in_transaction(&tx, changes)?;
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn save_in_transaction(c: &Connection, changes: &[Preference]) -> Result<(), String> {
    for row in changes {
        let local_collection_rule = row.display_rank.is_none()
            && row.sort_rule.is_some()
            && row
                .entity
                .strip_prefix("collection:")
                .is_some_and(crate::infrastructure::repositories::collections::valid_reference);
        if !local_collection_rule
            && !matches!(row.entity.as_str(), "view:favorites" | "view:saved")
            && !entity_exists(c, &row.entity)?
        {
            return Err("收藏已被删除，请刷新列表后重试".into());
        }
        let play_sort = matches!(row.sort_rule.as_deref(), Some("plays:asc" | "plays:desc"));
        if row.display_rank.as_ref().is_some_and(|s| !valid_rank(s))
            || row.sort_rule.as_ref().is_some_and(|s| !valid_rule(s)) && !play_sort
        {
            return Err("排序设置无效".into());
        }
        let local_key = format!("local-sort:{}", row.entity);
        if play_sort {
            c.execute("INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![local_key,row.sort_rule]).map_err(|e|e.to_string())?;
        } else if row.sort_rule.is_some() {
            c.execute("DELETE FROM sync_info WHERE key=?1", [&local_key])
                .map_err(|e| e.to_string())?;
        }
        let sync_rule = if play_sort {
            None
        } else {
            row.sort_rule.as_ref()
        };
        c.execute("INSERT INTO list_preferences(entity,display_rank,sort_rule) VALUES(?1,?2,?3) ON CONFLICT(entity) DO UPDATE SET display_rank=COALESCE(excluded.display_rank,display_rank),sort_rule=COALESCE(excluded.sort_rule,sort_rule)",params![row.entity,row.display_rank,sync_rule]).map_err(|e|e.to_string())?;
    }
    Ok(())
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
    fn local_sort_is_independent_of_invalid_sync_data_and_batch_is_atomic() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute("INSERT INTO playlists(id,name) VALUES('p','')", [])
            .unwrap();
        assert!(crate::sync::storage::export(&c, "42", false).is_err());
        let change = Preference {
            entity: "playlist:p".into(),
            display_rank: None,
            sort_rule: Some("plays:desc".into()),
        };
        save(&c, &[change.clone()]).unwrap();
        let invalid = Preference {
            entity: "playlist:missing".into(),
            ..change.clone()
        };
        let changed = Preference {
            sort_rule: Some("name:asc".into()),
            ..change
        };
        assert!(save(&c, &[changed, invalid]).is_err());
        assert_eq!(
            read(&c).unwrap()["preferences"][0]["sortRule"],
            "plays:desc"
        );
    }

    #[test]
    fn play_count_view_is_local_and_survives_sync_without_breaking_older_rule_validation() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        save(
            &c,
            &[Preference {
                entity: "view:favorites".into(),
                sort_rule: Some("name:asc".into()),
                display_rank: None,
            }],
        )
        .unwrap();
        save(
            &c,
            &[Preference {
                entity: "view:favorites".into(),
                sort_rule: Some("plays:desc".into()),
                display_rank: None,
            }],
        )
        .unwrap();
        c.execute(
            "INSERT INTO sync_info VALUES('source-plays:BV1GFRFBREe6','0')",
            [],
        )
        .unwrap();
        let snapshot = crate::sync::storage::export(&c, "42", false).unwrap();
        assert_eq!(
            snapshot.records["view:favorites"].fields["sortRule"],
            "name:asc"
        );
        assert!(!valid_rule("plays:desc"));
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("source-plays")
        );
        crate::sync::storage::apply(&c, &snapshot, false).unwrap();
        let view = read(&c).unwrap();
        assert_eq!(view["preferences"][0]["sortRule"], "plays:desc");
        assert_eq!(view["playCounts"]["BV1GFRFBREe6"], 0);
        save(
            &c,
            &[Preference {
                entity: "view:favorites".into(),
                sort_rule: Some("date:desc".into()),
                display_rank: None,
            }],
        )
        .unwrap();
        assert_eq!(read(&c).unwrap()["preferences"][0]["sortRule"], "date:desc");
    }
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
        assert!(
            save(
                &c,
                &[Preference {
                    entity: "view:favorites".into(),
                    display_rank: None,
                    sort_rule: Some("invalid".into())
                }]
            )
            .is_err()
        );
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
        assert!(
            save(
                &c,
                &[Preference {
                    entity: "playlist:deleted".into(),
                    display_rank: None,
                    sort_rule: Some("name:asc".into())
                }]
            )
            .is_err()
        );
    }
}
