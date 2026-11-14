//! Canonical business projection shared by every platform. Received facts never become new edits.
use super::{
    causal::{self, Cell, Document, Domain},
    model::{text, Record, Snapshot},
    storage,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
pub type Facts = BTreeMap<String, Cell>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct View {
    pub snapshot: Snapshot,
    pub facts: Facts,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn facts(snapshot: &Snapshot, domain: Domain) -> Facts {
    let mut out = Facts::new();
    for (entity, row) in &snapshot.records {
        if domain_of(&row.kind) != domain {
            continue;
        }
        out.insert(causal::key(entity, "__present"), Cell::Value(true.into()));
        for (field, value) in &row.fields {
            out.insert(causal::key(entity, field), Cell::Value(value.clone()));
        }
    }
    out
}
pub fn domain_of(kind: &str) -> Domain {
    if matches!(kind, "history" | "collectionProgress") {
        Domain::Progress
    } else {
        Domain::Library
    }
}
fn canonical_stamp(value: &str, rowid: i64, entity: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || !value.is_ascii()
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b' '
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return value.into();
    }
    let fraction = value.get(20..).unwrap_or_default();
    if bytes.get(19) == Some(&b'.')
        && fraction.len() == 54
        && fraction.bytes().all(|c| c.is_ascii_digit())
    {
        return value.into();
    }
    let milliseconds = fraction.get(..3).unwrap_or(fraction);
    let milliseconds = format!("{milliseconds:0<3}");
    let digest = ring::digest::digest(&ring::digest::SHA256, entity.as_bytes());
    let unique = u128::from_be_bytes(digest.as_ref()[..16].try_into().unwrap());
    format!(
        "{}.{}{:012}{:039}",
        &value[..19],
        milliseconds,
        rowid,
        unique
    )
}
pub fn capture(c: &Connection, uid: &str, history: bool) -> Result<View, String> {
    let snapshot = storage::export(c, uid, history)?;
    let mut all = facts(&snapshot, Domain::Library);
    all.extend(facts(&snapshot, Domain::Progress));
    let mut q = c
        .prepare("SELECT bvid,note FROM creator_notes ORDER BY bvid")
        .map_err(err)?;
    for row in q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
    {
        let (id, note) = row.map_err(err)?;
        if note.chars().count() > 160 {
            return Err("UP主备注超过同步上限".into());
        }
        let entity = format!("collection:{id}");
        if snapshot.records.contains_key(&entity) {
            all.insert(
                causal::key(&entity, "creatorNote"),
                Cell::Value(note.into()),
            );
        }
    }
    for (kind, sql) in [
        ("playlist", "SELECT id,created_at,rowid FROM playlists"),
        (
            "collection",
            "SELECT bvid,created_at,rowid FROM collections",
        ),
        (
            "favorite",
            "SELECT track_id,created_at,rowid FROM favorites",
        ),
        (
            "collectionFolder",
            "SELECT id,created_at,rowid FROM collection_folders",
        ),
        (
            "linkedFolder",
            "SELECT CAST(folder_id AS TEXT),printf('%020.6f',added_at),rowid FROM linked_bili_folder_order",
        ),
    ] {
        let mut q = c.prepare(sql).map_err(err)?;
        for row in q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(err)?
        {
            let (id, order, rowid) = row.map_err(err)?;
            let entity = format!("{kind}:{id}");
            if snapshot.records.contains_key(&entity) {
                if let Some(order) = order {
                    let order = if kind == "linkedFolder" {
                        order
                    } else {
                        canonical_stamp(&order, rowid, &entity)
                    };
                    all.insert(causal::key(&entity, "__order"), Cell::Value(order.into()));
                }
            }
        }
    }
    Ok(View {
        snapshot,
        facts: all,
    })
}
pub fn delta(before: &Facts, after: &Facts, domain: Domain) -> Result<Facts, String> {
    let mut delta = Facts::new();
    let keys: BTreeSet<_> = before.keys().chain(after.keys()).collect();
    for key in keys {
        let (entity, field): (String, String) = serde_json::from_str(key).map_err(err)?;
        if domain_of(entity.split(':').next().unwrap_or_default()) != domain {
            continue;
        }
        if before.get(key) == after.get(key) {
            continue;
        }
        // Deleting a record changes only its existence. Retain its fields as recovery evidence.
        if field != "__present" && !after.contains_key(&causal::key(&entity, "__present")) {
            continue;
        }
        let value = after.get(key).cloned().unwrap_or(if field == "__present" {
            Cell::Value(false.into())
        } else {
            Cell::Missing
        });
        delta.insert(key.clone(), value);
    }
    complete_lyric_selection(&mut delta, after)?;
    Ok(delta)
}
/// Both halves of a lyric selection use the same causal operation, even if
/// only its ID changed. No new wire fields or per-song timestamps are needed.
pub fn complete_lyric_selection(delta: &mut Facts, after: &Facts) -> Result<(), String> {
    let entities: BTreeSet<String> = delta
        .keys()
        .map(|key| serde_json::from_str::<(String, String)>(key).map_err(err))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(entity, field)| {
            entity.starts_with("lyric:") && matches!(field.as_str(), "provider" | "providerLyricId")
        })
        .map(|(entity, _)| entity)
        .collect();
    for entity in entities {
        if after.get(&causal::key(&entity, "__present")) != Some(&Cell::Value(true.into())) {
            continue;
        }
        for field in ["provider", "providerLyricId"] {
            let key = causal::key(&entity, field);
            delta.insert(
                key.clone(),
                after.get(&key).cloned().unwrap_or(Cell::Missing),
            );
        }
    }
    Ok(())
}
pub fn rows(doc: &Document) -> Result<BTreeMap<String, BTreeMap<String, Value>>, String> {
    let (mut rows, _) = doc.materialize()?;
    for (key, reg) in &doc.registers {
        let (entity, field): (String, String) = serde_json::from_str(key).map_err(err)?;
        if matches!(field.as_str(), "__present" | "__record") || !rows.contains_key(&entity) {
            continue;
        }
        let pick = if field == "__order" {
            reg.values
                .iter()
                .filter_map(|v| {
                    if let Cell::Value(v) = &v.cell {
                        Some(v)
                    } else {
                        None
                    }
                })
                .max_by_key(|v| v.as_str().unwrap_or_default())
        } else if doc.scope.domain == Domain::Progress {
            reg.values
                .iter()
                .filter_map(|v| {
                    if let Cell::Value(v) = &v.cell {
                        Some(v)
                    } else {
                        None
                    }
                })
                .max_by_key(|v| match field.as_str() {
                    "resume" => super::model::track_position_order(v),
                    "checkpoint" => super::model::checkpoint_order(v),
                    _ => (0, v.as_str().unwrap_or_default()),
                })
        } else if super::upgrade_merge::automatic_field(&field) {
            // A concurrent unset/default candidate must not hide an available
            // setting. A causally later clear has already superseded old values.
            reg.values
                .iter()
                .filter_map(|candidate| match &candidate.cell {
                    Cell::Value(value)
                        if !value.is_null()
                            && !value.as_str().is_some_and(|s| s.trim().is_empty()) =>
                    {
                        Some(value)
                    }
                    _ => None,
                })
                .next()
        } else {
            None
        };
        if let Some(value) = pick {
            rows.get_mut(&entity).unwrap().insert(field, value.clone());
        }
    }
    // Concurrent selections choose a whole provider/ID pair from one operation.
    // Causally newer writes already replace older candidates; concurrent writes
    // have no reliable wall clock, so the register's stable dot order breaks ties.
    for (entity, fields) in rows
        .iter_mut()
        .filter(|(entity, _)| entity.starts_with("lyric:"))
    {
        let provider = doc.registers.get(&causal::key(entity, "provider"));
        let id = doc.registers.get(&causal::key(entity, "providerLyricId"));
        if let (Some(provider), Some(id)) = (provider, id) {
            if let Some((p, i)) = id.values.iter().find_map(|i| {
                provider
                    .values
                    .iter()
                    .find(|p| p.dot == i.dot)
                    .map(|p| (p, i))
            }) {
                for (field, cell) in [("provider", &p.cell), ("providerLyricId", &i.cell)] {
                    match cell {
                        Cell::Value(value) => {
                            fields.insert(field.into(), value.clone());
                        }
                        Cell::Missing => {
                            fields.remove(field);
                        }
                    }
                }
            }
        }
    }
    Ok(rows)
}
pub fn snapshot(
    library: &Document,
    progress: &Document,
    history: bool,
) -> Result<Snapshot, String> {
    let mut snapshot = Snapshot::empty(&library.scope.uid);
    for (domain, rows) in [
        (Domain::Library, rows(library)?),
        (Domain::Progress, rows(progress)?),
    ] {
        if domain == Domain::Progress && !history {
            continue;
        }
        for (entity, mut fields) in rows {
            let kind = entity.split(':').next().ok_or("同步实体无效")?.to_owned();
            if domain_of(&kind) != domain {
                return Err("同步资料跨越数据域".into());
            }
            fields.remove("__order");
            fields.remove("creatorNote");
            snapshot.records.insert(entity, Record { kind, fields });
        }
    }
    // Causal orphan facts remain in the document, while the SQL projection keeps references valid.
    // The engine reports these as recoverable parent/child conflicts before applying this view.
    snapshot.compact(history);
    snapshot.validate(&snapshot.uid)?;
    Ok(snapshot)
}
pub fn apply(
    c: &Connection,
    library: &Document,
    progress: &Document,
    history: bool,
) -> Result<View, String> {
    let snapshot = snapshot(library, progress, history)?;
    storage::apply(c, &snapshot, history)?;
    for (entity, row) in rows(library)? {
        if !snapshot.records.contains_key(&entity) {
            continue;
        }
        let record = &snapshot.records[&entity];
        if let Some(note) = row.get("creatorNote").and_then(Value::as_str) {
            if record.kind != "collection"
                || !text(record, "bvid").starts_with("up:")
                || note.chars().count() > 160
            {
                return Err("同步备注无效".into());
            }
            c.execute("INSERT INTO creator_notes(bvid,note) VALUES(?1,?2) ON CONFLICT(bvid) DO UPDATE SET note=excluded.note",params![text(record,"bvid"),note]).map_err(err)?;
        }
        if let Some(order) = row.get("__order").and_then(Value::as_str) {
            if order.len() > 120 {
                return Err("同步顺序无效".into());
            }
            let pair = match record.kind.as_str() {
                "playlist" => Some(("playlists", "id", text(record, "id"))),
                "collection" => Some(("collections", "bvid", text(record, "bvid"))),
                "favorite" => Some(("favorites", "track_id", text(record, "trackId"))),
                "collectionFolder" => Some(("collection_folders", "id", text(record, "id"))),
                _ => None,
            };
            if let Some((table, key, id)) = pair {
                c.execute(
                    &format!("UPDATE {table} SET created_at=?2 WHERE {key}=?1"),
                    params![id, order],
                )
                .map_err(err)?;
            }
            if record.kind == "linkedFolder" {
                let value: f64 = order.parse().map_err(|_| "同步关联顺序无效")?;
                if !value.is_finite() || value < 0.0 {
                    return Err("同步关联顺序无效".into());
                }
                c.execute(
                    "UPDATE linked_bili_folder_order SET added_at=?2 WHERE folder_id=?1",
                    params![super::model::number(record, "folderId"), value],
                )
                .map_err(err)?;
            }
        }
    }
    capture(c, &snapshot.uid, history)
}

#[cfg(test)]
mod selection_tests {
    use super::*;
    use serde_json::json;
    fn scope() -> causal::Scope {
        causal::Scope {
            uid: "42".into(),
            vault: "00000000-0000-4000-8000-000000000001".into(),
            seed: "a".repeat(64),
            domain: Domain::Library,
        }
    }
    fn selection(provider: &str, id: &str) -> Facts {
        [
            ("__present", Cell::Value(true.into())),
            ("id", Cell::Value("bilibili:BV1tZuKzgENQ:1".into())),
            ("provider", Cell::Value(provider.into())),
            ("providerLyricId", Cell::Value(id.into())),
        ]
        .into_iter()
        .map(|(f, v)| (causal::key("lyric:bilibili:BV1tZuKzgENQ:1", f), v))
        .collect()
    }
    #[test]
    fn favorites_concurrent_add_wins_but_observed_unlike_still_removes() {
        let aa = "00000000-0000-4000-8000-000000000002";
        let bb = "00000000-0000-4000-8000-000000000003";
        let entity = "favorite:bilibili:BV123:1";
        let present = causal::key(entity, "__present");
        let mut a = Document::empty(scope());
        let initial = a
            .make_batch(
                aa,
                BTreeMap::from([
                    (present.clone(), Cell::Value(true.into())),
                    (
                        causal::key(entity, "trackId"),
                        Cell::Value("bilibili:BV123:1".into()),
                    ),
                ]),
            )
            .unwrap()
            .unwrap();
        a.apply(&initial).unwrap();
        let mut b = a.clone();
        let delete = a
            .make_batch(
                aa,
                BTreeMap::from([(present.clone(), Cell::Value(false.into()))]),
            )
            .unwrap()
            .unwrap();
        a.apply(&delete).unwrap();
        let unlike = b
            .make_batch(
                bb,
                BTreeMap::from([(present.clone(), Cell::Value(false.into()))]),
            )
            .unwrap()
            .unwrap();
        b.apply(&unlike).unwrap();
        let add = b
            .make_batch(
                bb,
                BTreeMap::from([(present.clone(), Cell::Value(true.into()))]),
            )
            .unwrap()
            .unwrap();
        b.apply(&add).unwrap();
        let original = a.clone();
        a.join(&b).unwrap();
        b.join(&original).unwrap();
        for doc in [&a, &b] {
            let (rows, conflicts) = doc.materialize().unwrap();
            assert!(rows.contains_key(entity));
            assert!(conflicts.is_empty());
        }
        let later = a
            .make_batch(aa, BTreeMap::from([(present, Cell::Value(false.into()))]))
            .unwrap()
            .unwrap();
        a.apply(&later).unwrap();
        b.apply(&later).unwrap();
        for doc in [&a, &b] {
            let (rows, conflicts) = doc.materialize().unwrap();
            assert!(!rows.contains_key(entity));
            assert!(conflicts.is_empty());
        }
    }
    #[test]
    fn concurrent_lyric_selection_pairs_converge_and_later_selection_wins() {
        let mut a = Document::empty(scope());
        let mut b = a.clone();
        let aa = "00000000-0000-4000-8000-000000000002";
        let bb = "00000000-0000-4000-8000-000000000003";
        let ba = a
            .make_batch(aa, selection("netease", "101"))
            .unwrap()
            .unwrap();
        a.apply(&ba).unwrap();
        let batch = b.make_batch(bb, selection("qq", "202")).unwrap().unwrap();
        b.apply(&batch).unwrap();
        let original_a = a.clone();
        a.join(&b).unwrap();
        b.join(&original_a).unwrap();
        assert_eq!(rows(&a).unwrap(), rows(&b).unwrap());
        let row = rows(&a)
            .unwrap()
            .remove("lyric:bilibili:BV1tZuKzgENQ:1")
            .unwrap();
        assert!(
            (row["provider"] == json!("netease") && row["providerLyricId"] == json!("101"))
                || (row["provider"] == json!("qq") && row["providerLyricId"] == json!("202"))
        );
        let before = selection("qq", "202");
        let after = selection("qq", "303");
        let changes = delta(&before, &after, Domain::Library).unwrap();
        assert_eq!(changes.len(), 2);
        assert!(changes.contains_key(&causal::key("lyric:bilibili:BV1tZuKzgENQ:1", "provider")));
        let newer = a.make_batch(aa, changes).unwrap().unwrap();
        a.apply(&newer).unwrap();
        b.apply(&newer).unwrap();
        assert_eq!(rows(&a).unwrap(), rows(&b).unwrap());
        let row = rows(&b)
            .unwrap()
            .remove("lyric:bilibili:BV1tZuKzgENQ:1")
            .unwrap();
        assert_eq!(row["provider"], json!("qq"));
        assert_eq!(row["providerLyricId"], json!("303"));
    }
}
