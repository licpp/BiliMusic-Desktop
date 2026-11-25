//! Optional order of the favorites view. The library snapshot owns membership.
use super::{
    Config,
    causal::{Cell, Register},
    model,
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

const KEY: &str = "favorite-order";
const MAX_TRACKS: usize = 10_000;

fn invalid(message: impl ToString) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.to_string())
}

fn read(c: &Connection) -> rusqlite::Result<Register> {
    let raw: Option<String> = c
        .query_row("SELECT value FROM sync_info WHERE key=?1", [KEY], |row| {
            row.get(0)
        })
        .optional()?;
    raw.map(|json| serde_json::from_str(&json).map_err(invalid))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn write(c: &Connection, register: &Register) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (KEY, serde_json::to_string(register).map_err(invalid)?),
    )?;
    Ok(())
}

fn selected(register: &Register) -> Option<&Cell> {
    register.values.last().map(|candidate| &candidate.cell)
}

fn validate(value: &Value) -> Result<(), String> {
    let Some(ids) = value.as_array().filter(|ids| ids.len() <= MAX_TRACKS) else {
        return Err("我喜欢的排序记录无效".into());
    };
    let mut seen = BTreeSet::new();
    for value in ids {
        let id = value
            .as_str()
            .filter(|id| id.len() <= 160 && model::track_identity(id).is_some())
            .ok_or("我喜欢的排序包含无效歌曲")?;
        if !seen.insert(id) {
            return Err("我喜欢的排序包含重复歌曲".into());
        }
    }
    Ok(())
}

pub(crate) fn positions(c: &Connection) -> rusqlite::Result<String> {
    match selected(&read(c)?) {
        Some(Cell::Value(order)) => serde_json::to_string(order).map_err(invalid),
        _ => Ok("[]".into()),
    }
}

pub(crate) fn save(c: &Connection, root: &Path, ordered: &[String]) -> rusqlite::Result<()> {
    let mut register = read(c)?;
    let value = serde_json::to_value(ordered).map_err(invalid)?;
    validate(&value).map_err(invalid)?;
    let cell = Cell::Value(value);
    if register.values.len() == 1 && selected(&register) == Some(&cell) {
        return Ok(());
    }
    register_extension::edit_register(c, root, &EXTENSION, &mut register, cell).map_err(invalid)?;
    write(c, &register)
}

const EXTENSION: RegisterExtension = RegisterExtension {
    namespace: "favorite-order-v1",
    writer_key: "favorite-order-writer",
    cache_dir: "favorite-order-sync-cache",
    validate_key: |key| {
        if key == KEY {
            Ok(())
        } else {
            Err("我喜欢的同步键无效".into())
        }
    },
    validate_value: validate,
    project: |c, _| {
        let register = read(c).map_err(|e| e.to_string())?;
        Ok(if register.values.is_empty() {
            BTreeMap::new()
        } else {
            BTreeMap::from([(KEY.into(), register)])
        })
    },
    write: |c, _, register| write(c, register).map_err(|e| e.to_string()),
    selected,
};

pub(super) async fn exchange(
    db: &Database,
    cfg: &Config,
    secret: &Secret,
    owner: &str,
    session: &str,
) -> Result<bool, String> {
    EXTENSION
        .exchange(
            db,
            cfg,
            secret,
            owner,
            session,
            BTreeSet::from([KEY.into()]),
        )
        .await
}
