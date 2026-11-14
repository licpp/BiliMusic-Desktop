//! Read-only local input for one-time device upgrades, not a v1 upload format.
//! It supplements (and never replaces) the preserved local causal state and bootstrap evidence.
use super::{model::Snapshot, storage};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "state",
    content = "text",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Note {
    Unspecified,
    Value(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LocalMaterial {
    pub schema: u32,
    pub uid: String,
    pub library: Snapshot,
    /// Unspecified is not deletion. Value("") is an explicitly stored empty note.
    pub creator_notes: BTreeMap<String, Note>,
    /// Observed relative order only. Old apply() timestamps cannot prove original creation time.
    pub observed_order: BTreeMap<String, Vec<String>>,
}
fn hash(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
impl LocalMaterial {
    pub fn digest(&self) -> Result<String, String> {
        Ok(hash(&serde_json::to_vec(self).map_err(|e| e.to_string())?))
    }
}
/// Same upgrade/source/entity/field has one identity, even after a retry.
/// A changed value under that identity needs a new capture, not silent replacement.
pub fn fact_identity(upgrade: &str, installation: &str, entity: &str, field: &str) -> String {
    hash(&serde_json::to_vec(&(upgrade, installation, entity, field)).unwrap())
}

pub fn capture(c: &Connection, uid: &str, history: bool) -> Result<LocalMaterial, String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let library = storage::export(c, uid, history)?;
    let mut material = LocalMaterial {
        schema: 1,
        uid: uid.into(),
        library,
        creator_notes: BTreeMap::new(),
        observed_order: BTreeMap::new(),
    };
    {
        let mut q=c.prepare("SELECT c.bvid,n.note FROM collections c LEFT JOIN creator_notes n ON n.bvid=c.bvid WHERE c.bvid LIKE 'up:%' ORDER BY c.bvid").map_err(|e|e.to_string())?;
        for row in q
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?
        {
            let (id, note) = row.map_err(|e| e.to_string())?;
            if !material
                .library
                .records
                .contains_key(&format!("collection:{id}"))
            {
                continue;
            }
            if note.as_ref().is_some_and(|v| v.chars().count() > 160) {
                return Err("UP主备注超过迁移上限，请先修正本机备注".into());
            }
            material
                .creator_notes
                .insert(id, note.map(Note::Value).unwrap_or(Note::Unspecified));
        }
    }
    for (group, kind, sql) in [
        (
            "playlists",
            "playlist",
            "SELECT id FROM playlists ORDER BY created_at DESC,rowid DESC",
        ),
        (
            "collections",
            "collection",
            "SELECT bvid FROM collections ORDER BY created_at DESC,rowid DESC",
        ),
        (
            "collectionFolders",
            "collectionFolder",
            "SELECT id FROM collection_folders ORDER BY rowid DESC",
        ),
        (
            "favorites",
            "favorite",
            "SELECT track_id FROM favorites ORDER BY created_at DESC,rowid DESC",
        ),
        (
            "linkedFolders",
            "linkedFolder",
            "SELECT l.folder_id FROM linked_bili_folders l LEFT JOIN linked_bili_folder_order o USING(folder_id) ORDER BY o.added_at DESC,l.folder_id DESC",
        ),
    ] {
        // Preserve relative local order without inventing semantic timestamps.
        let mut q = c.prepare(sql).map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| match r.get_ref(0)? {
                rusqlite::types::ValueRef::Integer(n) => Ok(n.to_string()),
                _ => r.get::<_, String>(0),
            })
            .map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for row in rows {
            let id = row.map_err(|e| e.to_string())?;
            if material
                .library
                .records
                .contains_key(&format!("{kind}:{id}"))
            {
                ids.push(id)
            }
        }
        material.observed_order.insert(group.into(), ids);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(material)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn supplements_preserve_notes_order_and_absence_without_exporting_cache_or_credentials() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute_batch("INSERT INTO collections(bvid,title) VALUES('up:1','private profile cache'),('up:2',''),('up:3','');
            INSERT INTO creator_notes VALUES('up:1','备注'),('up:2','');
            INSERT INTO auth_session(provider,cookie_header) VALUES('bilibili','private credential');").unwrap();
        let first = "ffffffff-2861-4be1-8b08-a6a0fb0b0579";
        let second = "00000000-2861-4be1-8b08-a6a0fb0b0579";
        for id in [first, second] {
            c.execute(
                "INSERT INTO playlists(id,name,created_at) VALUES(?1,'list','2026-11-08 00:00:00')",
                [id],
            )
            .unwrap();
        }
        let a = capture(&c, "42", false).unwrap();
        assert_eq!(a, capture(&c, "42", false).unwrap());
        assert_eq!(a.creator_notes["up:1"], Note::Value("备注".into()));
        assert_eq!(a.creator_notes["up:2"], Note::Value(String::new()));
        assert_eq!(a.creator_notes["up:3"], Note::Unspecified);
        assert_eq!(a.observed_order["playlists"], vec![second, first]);
        let bytes = serde_json::to_string(&a).unwrap();
        assert!(!bytes.contains("private"));
        assert_eq!(
            a.digest().unwrap(),
            capture(&c, "42", false).unwrap().digest().unwrap()
        );
        assert_eq!(
            fact_identity("p", "a", "up:1", "note"),
            fact_identity("p", "a", "up:1", "note")
        );
        assert_ne!(
            fact_identity("p", "a", "up:1", "note"),
            fact_identity("p", "b", "up:1", "note")
        );
    }
}
