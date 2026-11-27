//! Optional imported playlist order. Playlist members and imported entries keep their own identities.
use super::{
    Config,
    causal::{self, Cell, Register},
    model::{self, Snapshot},
    register_extension::{self, RegisterExtension},
    transport::Secret,
};
use crate::infrastructure::database::Database;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

const KEY_PREFIX: &str = "import-playlist-order:";
const MAX_ITEMS: usize = 10_000;

fn invalid(message: impl ToString) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.to_string())
}

fn valid_playlist(playlist: &str) -> bool {
    playlist
        .strip_prefix("import:")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

fn read(c: &Connection, playlist: &str) -> rusqlite::Result<Register> {
    let raw: Option<String> = c
        .query_row(
            "SELECT value FROM sync_info WHERE key=?1",
            [format!("{KEY_PREFIX}{playlist}")],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|json| serde_json::from_str(&json).map_err(invalid))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn write(c: &Connection, playlist: &str, register: &Register) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO sync_info(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (
            format!("{KEY_PREFIX}{playlist}"),
            serde_json::to_string(register).map_err(invalid)?,
        ),
    )?;
    Ok(())
}

fn selected(register: &Register) -> Option<&Cell> {
    register.values.last().map(|candidate| &candidate.cell)
}

fn validate(value: &Value) -> Result<(), String> {
    let Some(items) = value.as_array().filter(|ids| ids.len() <= MAX_ITEMS) else {
        return Err("导入歌单排序记录无效".into());
    };
    let mut seen = BTreeSet::new();
    for item in items {
        let id = item
            .as_str()
            .filter(|id| {
                id.strip_prefix("entry:").is_some_and(causal::valid_hash)
                    || (id.len() <= 160
                        && model::track_identity(id).is_some_and(|(bvid, _)| bvid.len() > 2))
            })
            .ok_or("导入歌单排序包含无效条目")?;
        if !seen.insert(id) {
            return Err("导入歌单排序包含重复条目".into());
        }
    }
    Ok(())
}

pub(crate) fn positions(c: &Connection, playlist: &str) -> rusqlite::Result<Option<Vec<String>>> {
    match selected(&read(c, playlist)?) {
        Some(Cell::Value(order)) => serde_json::from_value(order.clone())
            .map(Some)
            .map_err(invalid),
        _ => Ok(None),
    }
}

pub(crate) fn save(
    c: &Connection,
    root: &Path,
    playlist: &str,
    ordered: &[String],
) -> rusqlite::Result<()> {
    let local_id = playlist.strip_prefix("import:").unwrap_or_default();
    if local_id.is_empty() || playlist.len() > 100 || local_id.contains(['|', '\r', '\n', '\0']) {
        return Err(invalid("导入歌单排序键无效"));
    }
    let value = serde_json::to_value(ordered).map_err(invalid)?;
    validate(&value).map_err(invalid)?;
    let mut register = read(c, playlist)?;
    let cell = Cell::Value(value);
    if register.values.len() == 1 && selected(&register) == Some(&cell) {
        return Ok(());
    }
    // The caller's transaction covers the order edit and the corresponding local list update.
    register_extension::edit_register(c, root, &EXTENSION, &mut register, cell).map_err(invalid)?;
    write(c, playlist, &register)
}

fn scope(library: &Snapshot) -> BTreeSet<String> {
    library
        .records
        .iter()
        .filter_map(|(key, record)| {
            let id = model::text(record, "id");
            (record.kind == "playlist"
                && key.strip_prefix("playlist:") == Some(id)
                && valid_playlist(id))
            .then(|| id.to_owned())
        })
        .collect()
}

fn project(c: &Connection, scope: &BTreeSet<String>) -> Result<BTreeMap<String, Register>, String> {
    let mut registers = BTreeMap::new();
    if scope.is_empty() {
        return Ok(registers);
    }
    let mut query = c
        .prepare("SELECT key,value FROM sync_info WHERE key GLOB ?1")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([format!("{KEY_PREFIX}*")], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        if let Some(id) = key
            .strip_prefix(KEY_PREFIX)
            .filter(|id| scope.contains(*id))
        {
            registers.insert(
                id.to_owned(),
                serde_json::from_str(&value).map_err(|e| e.to_string())?,
            );
        }
    }
    Ok(registers)
}

const EXTENSION: RegisterExtension = RegisterExtension {
    namespace: "import-playlist-order-v1",
    writer_key: "import-playlist-order-writer",
    cache_dir: "import-playlist-order-sync-cache",
    validate_key: |key| {
        if valid_playlist(key) {
            Ok(())
        } else {
            Err("导入歌单排序同步键无效".into())
        }
    },
    validate_value: validate,
    project,
    write: |c, key, register| write(c, key, register).map_err(|e| e.to_string()),
    selected,
};

pub(super) async fn exchange(
    db: &Database,
    cfg: &Config,
    secret: &Secret,
    owner: &str,
    session: &str,
    library: &Snapshot,
) -> Result<bool, String> {
    let scope = scope(library);
    if scope.is_empty() {
        return Ok(false);
    }
    EXTENSION
        .exchange(db, cfg, secret, owner, session, scope)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repositories::imported_entries::deterministic_id;
    use crate::sync::model::Record;
    use serde_json::json;

    const PLAYLIST: &str = "import:8076ad4b-2861-4be1-8b08-a6a0fb0b0579";
    const TRACK: &str = "bilibili:BV1qFuQz2EVx:235";

    #[test]
    fn wire_format_preserves_entry_and_track_keys_and_rejects_invalid_values() {
        let slot = deterministic_id(PLAYLIST, 3);
        assert!(validate(&json!([slot, TRACK])).is_ok());
        assert!(validate(&json!([])).is_ok());
        assert!(validate(&json!([TRACK, TRACK])).is_err());
        let upper_hash = format!("entry:{}", slot["entry:".len()..].to_ascii_uppercase());
        assert!(validate(&json!([upper_hash])).is_err());
        for invalid in [
            "entry:123",
            "bilibili:BV1qFuQz2EVx:0235",
            "bilibili:BV1qFuQz2EVx:+235",
            "bilibili:BV1qFuQz2EVx:0",
            "bilibili:BV1qFuQz2EVx:235:1",
            "bilibili:BV:235",
        ] {
            assert!(validate(&json!([invalid])).is_err(), "{invalid}");
        }
        for invalid in ["import:copy", "import:", &PLAYLIST["import:".len()..]] {
            assert!((EXTENSION.validate_key)(invalid).is_err(), "{invalid}");
        }
        assert!((EXTENSION.validate_key)(PLAYLIST).is_ok());
    }

    #[test]
    fn local_order_is_distinct_from_absence_and_projection_requires_a_core_playlist() {
        let c = Connection::open_in_memory().unwrap();
        c.execute(
            "CREATE TABLE sync_info(key TEXT PRIMARY KEY,value TEXT)",
            [],
        )
        .unwrap();
        let root = std::env::temp_dir().join(format!("playlist-order-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let slot = deterministic_id(PLAYLIST, 3);
        let ordered = [slot, TRACK.to_owned()];
        assert_eq!(positions(&c, PLAYLIST).unwrap(), None);
        save(&c, &root, PLAYLIST, &ordered).unwrap();
        let first = read(&c, PLAYLIST).unwrap();
        save(&c, &root, PLAYLIST, &ordered).unwrap();
        assert_eq!(read(&c, PLAYLIST).unwrap(), first);
        assert_eq!(positions(&c, PLAYLIST).unwrap(), Some(ordered.to_vec()));
        save(&c, &root, "import:copy", &[]).unwrap();
        assert_eq!(positions(&c, "import:copy").unwrap(), Some(vec![]));

        let mut library = Snapshot::empty("42");
        for playlist in [PLAYLIST, "import:copy", &PLAYLIST["import:".len()..]] {
            library.records.insert(
                format!("playlist:{playlist}"),
                Record {
                    kind: "playlist".into(),
                    fields: BTreeMap::from([("id".into(), json!(playlist))]),
                },
            );
        }
        assert_eq!(scope(&library), BTreeSet::from([PLAYLIST.to_owned()]));
        assert_eq!(
            project(&c, &scope(&library)).unwrap(),
            BTreeMap::from([(PLAYLIST.to_owned(), first)])
        );
        library.records.remove(&format!("playlist:{PLAYLIST}"));
        assert!(project(&c, &scope(&library)).unwrap().is_empty());
        assert_eq!(positions(&c, PLAYLIST).unwrap(), Some(ordered.to_vec()));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
