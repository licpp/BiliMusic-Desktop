//! Imported song identity is a playlist slot, never a replacement Track identity.
//! Registers own the slots. playlist_items is only their local playback projection.
use super::library::TrackInput;
use crate::sync::causal::{self, Candidate, Cell, Dot, Register};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(include_str!("../../../migrations/0010_import_entries.sql"))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Song {
    pub source_id: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Value {
    pub playlist_id: String,
    pub order: usize,
    pub song: Song,
    #[serde(default)]
    pub track: Option<TrackInput>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub legacy: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub entry_id: String,
    pub playlist_id: String,
    pub order: usize,
    pub song: Song,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedRow {
    pub order: usize,
    pub song: Song,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub entry_id: String,
    pub expected_revision: String,
    pub track: TrackInput,
    pub mode: String,
}

pub fn deterministic_id(playlist: &str, order: usize) -> String {
    format!(
        "entry:{}",
        causal::hash(format!("{playlist}\n{order}").as_bytes())
    )
}
fn valid_playlist(id: &str) -> bool {
    id.starts_with("import:") && id.len() <= 100 && !id.contains(['|', '\n', '\r'])
}
fn valid_song(s: &Song) -> bool {
    !s.source_id.is_empty()
        && s.source_id.len() <= 2000
        && !s.title.trim().is_empty()
        && s.title.chars().count() <= 1000
        && s.artists.len() <= 50
        && s.artists.iter().all(|s| s.len() <= 1000)
        && s.aliases.len() <= 50
        && s.aliases.iter().all(|s| s.len() <= 2000)
        && s.duration_seconds
            .is_none_or(|s| s.is_finite() && (0.0..=604800.0).contains(&s))
        && s.album.as_ref().is_none_or(|s| s.len() <= 2000)
        && s.cover_url.as_ref().is_none_or(|s| s.len() <= 4000)
}
fn valid_track(t: &TrackInput) -> bool {
    t.bvid.len() == 12
        && t.bvid.starts_with("BV")
        && t.bvid.bytes().all(|c| c.is_ascii_alphanumeric())
        && t.cid > 0
        && t.page > 0
        && t.id == format!("bilibili:{}:{}", t.bvid, t.cid)
        && !t.title.trim().is_empty()
        && t.title.chars().count() <= 1000
        && (0..=604800).contains(&t.duration_seconds)
        && t.source_title.len() <= 8000
        && t.cover_url.as_ref().is_none_or(|s| s.len() <= 4000)
}
pub fn validate(key: &str, reg: &Register) -> Result<(), String> {
    if !key.starts_with("entry:") || !causal::valid_hash(&key[6..]) || reg.values.is_empty() {
        return Err("导入条目身份无效".into());
    }
    let mut check = Register::default();
    check.merge(reg)?;
    for v in &reg.values {
        if let Cell::Value(value) = &v.cell {
            let value: Value = serde_json::from_value(value.clone()).map_err(err)?;
            if !valid_playlist(&value.playlist_id)
                || value.order >= 5000
                || !valid_song(&value.song)
                || deterministic_id(&value.playlist_id, value.order) != key
                || value.track.as_ref().is_some_and(|t| !valid_track(t))
                || value
                    .mode
                    .as_deref()
                    .is_some_and(|m| !matches!(m, "automatic" | "manual"))
                || value.track.is_some() != value.mode.is_some()
            {
                return Err("导入条目内容无效".into());
            }
        }
    }
    Ok(())
}
pub fn read(c: &Connection, key: &str) -> Result<Register, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT register FROM imported_entries WHERE entry_id=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
        .map(|r| r.unwrap_or_default())
}
pub fn revision(r: &Register) -> String {
    causal::hash(&serde_json::to_vec(r).expect("register serialization"))
}
/// Causal dominance is handled by Register::merge. Among concurrent values a
/// deletion wins, then manual selection, then a deterministic operation order.
pub fn selected(r: &Register) -> Option<Value> {
    if r.values.iter().any(|v| {
        matches!(&v.cell, Cell::Missing) || matches!(&v.cell,Cell::Value(j) if j["deleted"]==true)
    }) {
        return None;
    }
    r.values
        .iter()
        .filter_map(|c| match &c.cell {
            Cell::Value(j) => serde_json::from_value::<Value>(j.clone())
                .ok()
                .map(|v| (c, v)),
            _ => None,
        })
        .max_by(|(a, x), (b, y)| {
            (!x.legacy, x.mode.as_deref() == Some("manual"), &a.dot).cmp(&(
                !y.legacy,
                y.mode.as_deref() == Some("manual"),
                &b.dot,
            ))
        })
        .map(|(_, v)| v)
}
pub fn registers(c: &Connection, local_only: bool) -> Result<BTreeMap<String, Register>, String> {
    init(c).map_err(err)?;
    let mut q=c.prepare(if local_only {"SELECT entry_id,register FROM imported_entries WHERE local_revision>0 ORDER BY entry_id"} else {"SELECT entry_id,register FROM imported_entries ORDER BY entry_id"}).map_err(err)?;
    q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .map(|r| {
            let (k, v) = r.map_err(err)?;
            Ok((k, serde_json::from_str(&v).map_err(err)?))
        })
        .collect()
}
fn playlist_entries(
    c: &Connection,
    playlist: &str,
) -> Result<Vec<(String, Register, Value)>, String> {
    init(c).map_err(err)?;
    let mut query = c
        .prepare("SELECT entry_id,register FROM imported_entries WHERE playlist_id=?1")
        .map_err(err)?;
    let rows = query
        .query_map([playlist], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(err)?;
    let mut values = Vec::new();
    for row in rows {
        let (key, json) = row.map_err(err)?;
        let register = serde_json::from_str(&json).map_err(err)?;
        if let Some(value) = selected(&register).filter(|value| value.playlist_id == playlist) {
            values.push((key, register, value));
        }
    }
    values.sort_by(|(ka, _, a), (kb, _, b)| {
        (a.mode.as_deref() != Some("manual"), a.order, ka).cmp(&(
            b.mode.as_deref() != Some("manual"),
            b.order,
            kb,
        ))
    });
    Ok(values)
}

pub(super) fn entry_ids_by_track(
    c: &Connection,
    playlist: &str,
) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::new();
    for (key, _, value) in playlist_entries(c, playlist)? {
        if let Some(track) = value.track {
            entries.entry(track.id).or_insert(key);
        }
    }
    Ok(entries)
}

pub fn list(c: &Connection, playlist: &str) -> Result<Vec<Entry>, String> {
    let values = playlist_entries(c, playlist)?;
    let mut used = BTreeSet::new();
    let mut entries = Vec::new();
    for (entry_id, r, v) in values {
        let duplicate = v.track.as_ref().is_some_and(|t| !used.insert(t.id.clone()));
        entries.push(Entry {
            entry_id,
            playlist_id: v.playlist_id,
            order: v.order,
            song: v.song,
            track_id: if duplicate {
                None
            } else {
                v.track.map(|t| t.id)
            },
            mode: if duplicate { None } else { v.mode },
            revision: revision(&r),
            message: duplicate.then(|| "该视频已被歌单中另一首歌曲使用，请重新匹配".into()),
        });
    }
    entries.sort_by(|a, b| a.order.cmp(&b.order).then(a.entry_id.cmp(&b.entry_id)));
    Ok(entries)
}

pub(super) fn has_entries(c: &Connection, playlist: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM imported_entries WHERE playlist_id=?1)",
        [playlist],
        |row| row.get(0),
    )
}
/// Recover old local queue presentation only when provenance is unambiguous.
/// Multiple playlists can intentionally label one BVID/CID differently.
pub fn track_contexts(c: &Connection, ids: &BTreeSet<String>) -> Result<Vec<Entry>, String> {
    let mut matches: BTreeMap<String, Option<Entry>> = BTreeMap::new();
    for (entry_id, register) in registers(c, false)? {
        let Some(value) = selected(&register) else {
            continue;
        };
        let Some(track) = value.track else { continue };
        if !ids.contains(&track.id) {
            continue;
        }
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM playlist_items WHERE playlist_id=?1 AND track_id=?2)",
                params![value.playlist_id, track.id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            continue;
        }
        let entry = Entry {
            entry_id,
            playlist_id: value.playlist_id,
            order: value.order,
            song: value.song,
            track_id: Some(track.id.clone()),
            mode: value.mode,
            revision: revision(&register),
            message: None,
        };
        matches
            .entry(track.id)
            .and_modify(|prior| *prior = None)
            .or_insert(Some(entry));
    }
    Ok(matches.into_values().flatten().collect())
}
fn runtime(c: &Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT value FROM imported_entry_runtime WHERE key=?1",
        [key],
        |r| r.get(0),
    )
    .optional()
    .map_err(err)
}
fn put_runtime(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO imported_entry_runtime VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(err)?;
    Ok(())
}
fn next_dot(c: &Connection) -> Result<Dot, String> {
    let Some(path) = c.path().filter(|p| !p.is_empty() && *p != ":memory:") else {
        return Ok(Dot {
            actor: uuid::Uuid::new_v4().to_string(),
            seq: 1,
        });
    };
    let parent = std::path::Path::new(path)
        .parent()
        .ok_or("数据库路径无效")?;
    let root = parent.join("import-entry-writers");
    let mut instance = runtime(c, "instance")?.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut seq = runtime(c, "sequence")?
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let mut lease = crate::sync::actor::Lease::open(&root.join(&instance), &instance)?;
    if !lease.consistent(&BTreeMap::from([("imports".into(), seq)])) {
        instance = uuid::Uuid::new_v4().to_string();
        seq = 0;
        lease = crate::sync::actor::Lease::open(&root.join(&instance), &instance)?;
    }
    let next = seq.checked_add(1).ok_or("导入操作序号耗尽")?;
    lease.reserve("imports", seq, next)?;
    put_runtime(c, "instance", &instance)?;
    put_runtime(c, "sequence", &next.to_string())?;
    Ok(Dot {
        actor: lease.actor().into(),
        seq: next,
    })
}
fn write(
    c: &Connection,
    key: &str,
    playlist: &str,
    reg: &Register,
    local: bool,
) -> Result<(), String> {
    validate(key, reg)?;
    let rev = runtime(c, "revision")?
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let next = if local {
        rev.checked_add(1).ok_or("导入操作序号耗尽")?
    } else {
        0
    };
    c.execute("INSERT INTO imported_entries(entry_id,playlist_id,register,local_revision) VALUES(?1,?2,?3,?4) ON CONFLICT(entry_id) DO UPDATE SET register=excluded.register,local_revision=CASE WHEN excluded.local_revision>0 THEN excluded.local_revision ELSE imported_entries.local_revision END",params![key,playlist,serde_json::to_string(reg).map_err(err)?,next]).map_err(err)?;
    if local {
        put_runtime(c, "revision", &next.to_string())?;
        for candidate in &reg.values {
            if let Cell::Value(j) = &candidate.cell {
                let v: Value = serde_json::from_value(j.clone()).map_err(err)?;
                if let Some(t) = v.track {
                    c.execute("INSERT INTO imported_entry_mirror_intents VALUES(?1,?2,?3) ON CONFLICT(playlist_id,track_id) DO UPDATE SET revision=excluded.revision",params![playlist,t.id,next]).map_err(err)?;
                }
            }
        }
    }
    Ok(())
}
fn assign(
    c: &Connection,
    key: &str,
    playlist: &str,
    previous: &Register,
    cell: Cell,
) -> Result<(), String> {
    let next = runtime(c, "revision")?
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("导入操作序号耗尽")?;
    for candidate in &previous.values {
        if let Cell::Value(j) = &candidate.cell {
            let v: Value = serde_json::from_value(j.clone()).map_err(err)?;
            if let Some(t) = v.track {
                c.execute("INSERT INTO imported_entry_mirror_intents VALUES(?1,?2,?3) ON CONFLICT(playlist_id,track_id) DO UPDATE SET revision=excluded.revision",params![playlist,t.id,next]).map_err(err)?;
            }
        }
    }
    let dot = next_dot(c)?;
    let mut seen = previous.seen.clone();
    seen.insert(&dot);
    write(
        c,
        key,
        playlist,
        &Register {
            seen,
            values: vec![Candidate { dot, cell }],
        },
        true,
    )
}
pub fn seed(
    c: &Connection,
    playlist: &str,
    name: &str,
    source: &str,
    rows: &[SeedRow],
) -> Result<(), String> {
    init(c).map_err(err)?;
    if !valid_playlist(playlist)
        || name.trim().is_empty()
        || name.chars().count() > 80
        || rows.is_empty()
        || rows.len() > 5000
        || !matches!(
            source,
            "text" | "netease" | "qq" | "kugou" | "kuwo" | "migu"
        )
        || rows.iter().any(|r| r.order >= 5000 || !valid_song(&r.song))
        || rows.iter().map(|r| r.order).collect::<BTreeSet<_>>().len() != rows.len()
    {
        return Err("导入内容无效".into());
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    c.execute(
        "INSERT INTO playlists(id,name) VALUES(?1,?2) ON CONFLICT(id) DO NOTHING",
        params![playlist, name.trim()],
    )
    .map_err(err)?;
    for row in rows {
        let key = deterministic_id(playlist, row.order);
        let old = read(c, &key)?;
        if !old.values.is_empty() {
            continue;
        }
        let v = Value {
            playlist_id: playlist.into(),
            order: row.order,
            song: row.song.clone(),
            track: None,
            mode: None,
            deleted: false,
            legacy: false,
        };
        assign(
            c,
            &key,
            playlist,
            &old,
            Cell::Value(serde_json::to_value(v).map_err(err)?),
        )?;
    }
    tx.commit().map_err(err)
}
pub fn bind(c: &Connection, playlist: &str, changes: &[Change]) -> Result<(), String> {
    init(c).map_err(err)?;
    if changes.is_empty()
        || changes.len() > 100
        || changes
            .iter()
            .map(|r| &r.entry_id)
            .collect::<BTreeSet<_>>()
            .len()
            != changes.len()
    {
        return Err("导入操作无效".into());
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM playlists WHERE id=?1)",
            [playlist],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !exists {
        return Err("歌单已删除，请重新打开".into());
    }
    for change in changes {
        if !valid_track(&change.track) || !matches!(change.mode.as_str(), "automatic" | "manual") {
            return Err("歌曲来源不完整，请重新匹配".into());
        }
        let old = read(c, &change.entry_id)?;
        if revision(&old) != change.expected_revision {
            return Err("这首歌已更新，请刷新后重试".into());
        }
        let mut v = selected(&old).ok_or("这首歌已移除，请重新打开")?;
        if v.playlist_id != playlist {
            return Err("导入条目不属于该歌单".into());
        }
        if change.mode == "automatic"
            && list(c, playlist)?
                .iter()
                .any(|r| r.entry_id == change.entry_id && r.track_id.is_some())
        {
            return Err("歌曲已匹配，已保留现有选择".into());
        }
        let already = list(c, playlist)?.into_iter().any(|r| {
            r.entry_id != change.entry_id && r.track_id.as_ref() == Some(&change.track.id)
        });
        let ordinary:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM playlist_items WHERE playlist_id=?1 AND track_id=?2 AND NOT EXISTS(SELECT 1 FROM imported_entry_owned o WHERE o.playlist_id=playlist_items.playlist_id AND o.track_id=playlist_items.track_id))",params![playlist,change.track.id],|r|r.get(0)).map_err(err)?;
        if already || ordinary {
            return Err("该视频已在歌单中，请选择其他视频或分 P".into());
        }
        v.track = Some(change.track.clone());
        v.mode = Some(change.mode.clone());
        v.legacy = false;
        assign(
            c,
            &change.entry_id,
            playlist,
            &old,
            Cell::Value(serde_json::to_value(v).map_err(err)?),
        )?;
    }
    project(c)?;
    tx.commit().map_err(err)
}
fn track_from_database(c: &Connection, id: &str) -> Result<Option<TrackInput>, String> {
    c.query_row("SELECT t.id,s.bvid,s.aid,s.cid,s.page,s.source_title,t.title,t.artist,t.album,t.cover_url,t.duration_seconds,s.uploader_id,s.uploader_name FROM tracks t JOIN source_items s ON s.id=t.source_item_id WHERE t.id=?1",[id],|r|Ok(TrackInput{id:r.get(0)?,bvid:r.get(1)?,aid:r.get(2)?,cid:r.get(3)?,page:r.get(4)?,source_title:r.get(5)?,source_title_context:None,title:r.get(6)?,artist:r.get(7)?,album:r.get(8)?,cover_url:r.get(9)?,duration_seconds:r.get(10)?,uploader_id:r.get(11)?,uploader_name:r.get(12)?})).optional().map_err(err)
}
/// Legacy recovery metadata is imported once, never used as an ongoing second truth.
/// Without an external-song archive we do not guess provenance from import: IDs.
pub fn migrate_archive(c: &Connection, playlist: &str) -> Result<(), String> {
    init(c).map_err(err)?;
    if !valid_playlist(playlist) {
        return Ok(());
    }
    let key = format!("migrated:{playlist}");
    if runtime(c, &key)?.is_some() {
        return Ok(());
    }
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM playlists WHERE id=?1)",
            [playlist],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !exists {
        return Ok(());
    }
    let archive: Option<String> = c
        .query_row(
            "SELECT document FROM playlist_import_archives WHERE playlist_id=?1",
            [playlist],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let Some(archive) = archive else {
        return Ok(());
    };
    let value: serde_json::Value = serde_json::from_str(&archive).map_err(err)?;
    let source = value["source"].as_str().unwrap_or("");
    if !matches!(
        source,
        "text" | "qq" | "netease" | "kugou" | "kuwo" | "migu"
    ) {
        return Ok(());
    }
    let Some(rows) = value["rows"].as_array().filter(|r| r.len() <= 5000) else {
        return Err("旧导入资料无效".into());
    };
    let tx = c.unchecked_transaction().map_err(err)?;
    for (index, row) in rows.iter().enumerate() {
        let order = row["order"].as_u64().map(|v| v as usize).unwrap_or(index);
        if order >= 5000 {
            continue;
        }
        let Ok(song) = serde_json::from_value::<Song>(row["song"].clone()) else {
            continue;
        };
        if !valid_song(&song) {
            continue;
        }
        let id = deterministic_id(playlist, order);
        if !read(c, &id)?.values.is_empty() {
            continue;
        }
        let track = row["chosen"]["track"]["id"]
            .as_str()
            .map(|id| track_from_database(c, id))
            .transpose()?
            .flatten();
        // A missing legacy member is ambiguous (deletion, or a newer core replacement).
        // Do not invent a deletion that could defeat a canonical remote binding.
        let present = track.as_ref().is_some_and(|t| {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM playlist_items WHERE playlist_id=?1 AND track_id=?2)",
                params![playlist, t.id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false)
        });
        if row["status"] == "saved" && !present {
            continue;
        }
        let cell = Cell::Value(
            serde_json::to_value(Value {
                playlist_id: playlist.into(),
                order,
                song,
                mode: track.as_ref().filter(|_| present).map(|_| "manual".into()),
                track: track.filter(|_| present),
                deleted: false,
                legacy: true,
            })
            .map_err(err)?,
        );
        // Same legacy slot and contents have the same operation ID on every device.
        let digest = causal::hash(&serde_json::to_vec(&cell).map_err(err)?);
        let mut bytes = [0u8; 16];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = u8::from_str_radix(&digest[i * 2..i * 2 + 2], 16).unwrap()
        }
        bytes[6] = (bytes[6] & 15) | 0x40;
        bytes[8] = (bytes[8] & 63) | 0x80;
        let dot = Dot {
            actor: uuid::Uuid::from_bytes(bytes).to_string(),
            seq: 1,
        };
        let mut reg = Register::default();
        reg.seen.insert(&dot);
        reg.values.push(Candidate { dot, cell });
        write(c, &id, playlist, &reg, true)?;
    }
    put_runtime(c, &key, "1")?;
    project(c)?;
    tx.commit().map_err(err)
}
pub fn migrate_all(c: &Connection) -> Result<(), String> {
    init(c).map_err(err)?;
    let mut q = c
        .prepare("SELECT playlist_id FROM playlist_import_archives ORDER BY playlist_id")
        .map_err(err)?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    for id in ids {
        migrate_archive(c, &id)?
    }
    Ok(())
}
pub fn merge(c: &Connection, remote: &BTreeMap<String, Register>) -> Result<(), String> {
    init(c).map_err(err)?;
    for (key, r) in remote {
        validate(key, r)?;
        let old = read(c, key)?;
        let mut merged = old.clone();
        merged.merge(r)?;
        let playlist = r
            .values
            .iter()
            .chain(old.values.iter())
            .find_map(|c| match &c.cell {
                Cell::Value(v) => v["playlistId"].as_str(),
                _ => None,
            })
            .map(str::to_owned)
            .or_else(|| {
                c.query_row(
                    "SELECT playlist_id FROM imported_entries WHERE entry_id=?1",
                    [key],
                    |r| r.get(0),
                )
                .optional()
                .ok()
                .flatten()
            })
            .ok_or("导入删除缺少条目身份")?;
        write(c, key, &playlist, &merged, false)?;
    }
    project(c)
}
/// Materialize winning bindings without changing Track identity or global overrides.
pub fn project(c: &Connection) -> Result<(), String> {
    init(c).map_err(err)?;
    let regs = registers(c, false)?;
    // Remember every alternative, not just the winner, so old core membership cannot revive a losing binding.
    for r in regs.values() {
        for v in &r.values {
            if let Cell::Value(j) = &v.cell {
                let v: Value = serde_json::from_value(j.clone()).map_err(err)?;
                if let Some(t) = v.track {
                    c.execute(
                        "INSERT OR IGNORE INTO imported_entry_owned VALUES(?1,?2)",
                        params![v.playlist_id, t.id],
                    )
                    .map_err(err)?;
                }
            }
        }
    }
    let candidates = super::track_cleanup::track_ids(
        c,
        "DELETE FROM playlist_items WHERE EXISTS(SELECT 1 FROM imported_entry_owned o
             WHERE o.playlist_id=playlist_items.playlist_id AND o.track_id=playlist_items.track_id)
         RETURNING track_id",
        [],
    )
    .map_err(err)?;
    let mut winners = regs
        .into_iter()
        .filter_map(|(key, r)| selected(&r).map(|v| (key, r, v)))
        .collect::<Vec<_>>();
    winners.sort_by(|(ka, _, a), (kb, _, b)| {
        (a.mode.as_deref() != Some("manual"), a.order, ka).cmp(&(
            b.mode.as_deref() != Some("manual"),
            b.order,
            kb,
        ))
    });
    let mut used = BTreeSet::new();
    for (_, _, v) in winners {
        let Some(t) = v.track else { continue };
        if !used.insert((v.playlist_id.clone(), t.id.clone())) {
            continue;
        }
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM playlists WHERE id=?1)",
                [&v.playlist_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            continue;
        }
        c.execute("INSERT INTO source_items(id,provider,bvid,aid,cid,page,source_title,uploader_id,uploader_name) VALUES(?1,'bilibili',?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO NOTHING",params![t.id,t.bvid,t.aid,t.cid,t.page,t.source_title,t.uploader_id,t.uploader_name]).map_err(err)?;
        c.execute("INSERT INTO tracks(id,source_item_id,title,artist,album,cover_url,duration_seconds) VALUES(?1,?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING",params![t.id,t.title,t.artist,t.album,t.cover_url,t.duration_seconds]).map_err(err)?;
        if let Some(context) = &t.source_title_context {
            let mut context = context.clone();
            let previous = super::source_titles::get(c, &t.id).map_err(err)?;
            context.preserve_membership(previous.as_ref());
            super::source_titles::save(c, &t.id, &context).map_err(err)?;
        }
        c.execute("INSERT INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,?3) ON CONFLICT(playlist_id,track_id) DO UPDATE SET position=excluded.position",params![v.playlist_id,t.id,v.order as i64]).map_err(err)?;
    }
    super::track_cleanup::collect_unreferenced(c, &candidates).map_err(err)
}
pub fn owned(c: &Connection, playlist: &str, track: &str) -> rusqlite::Result<bool> {
    init(c)?;
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM imported_entry_owned WHERE playlist_id=?1 AND track_id=?2)",
        params![playlist, track],
        |r| r.get(0),
    )
}
pub fn remove(c: &Connection, playlist: &str, track: Option<&str>) -> Result<(), String> {
    init(c).map_err(err)?;
    for (key, r) in registers(c, false)? {
        if let Some(mut v) = selected(&r).filter(|v| {
            v.playlist_id == playlist
                && track.is_none_or(|id| v.track.as_ref().is_some_and(|t| t.id == id))
        }) {
            v.deleted = true;
            assign(
                c,
                &key,
                playlist,
                &r,
                Cell::Value(serde_json::to_value(&v).map_err(err)?),
            )?;
            if let Some(t) = v.track {
                c.execute(
                    "INSERT OR IGNORE INTO imported_entry_owned VALUES(?1,?2)",
                    params![playlist, t.id],
                )
                .map_err(err)?;
            }
        }
    }
    Ok(())
}

pub fn remove_missing(
    c: &Connection,
    playlist: &str,
    entry_id: &str,
    expected_revision: &str,
) -> Result<(), String> {
    init(c).map_err(err)?;
    let tx = c.unchecked_transaction().map_err(err)?;
    let old = read(c, entry_id)?;
    let mut entry = selected(&old).ok_or("这首歌已移除，请刷新歌单")?;
    if entry.playlist_id != playlist {
        return Err("导入条目不属于该歌单".into());
    }
    if revision(&old) != expected_revision
        || (entry.track.is_some()
            && list(c, playlist)?
                .iter()
                .any(|row| row.entry_id == entry_id && row.track_id.is_some()))
    {
        return Err("这首歌已更新，请刷新后重试".into());
    }
    entry.deleted = true;
    assign(
        c,
        entry_id,
        playlist,
        &old,
        Cell::Value(serde_json::to_value(entry).map_err(err)?),
    )?;
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    const LIST: &str = "import:11111111-1111-4111-8111-111111111111";
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c
    }
    fn song(title: &str) -> Song {
        Song {
            source_id: format!("qq:{title}"),
            title: title.into(),
            artists: vec!["歌手".into()],
            aliases: vec![],
            duration_seconds: Some(240.0),
            album: None,
            cover_url: None,
        }
    }
    fn rows() -> Vec<SeedRow> {
        vec![
            SeedRow {
                order: 0,
                song: song("一"),
            },
            SeedRow {
                order: 1,
                song: song("二"),
            },
            SeedRow {
                order: 2,
                song: song("三"),
            },
        ]
    }
    fn track(cid: i64) -> TrackInput {
        TrackInput {
            id: format!("bilibili:BV1GJ411x7h7:{cid}"),
            bvid: "BV1GJ411x7h7".into(),
            aid: None,
            cid,
            page: 1,
            source_title: format!("真实视频 {cid}"),
            source_title_context: None,
            title: format!("真实视频 {cid}"),
            artist: None,
            album: None,
            cover_url: None,
            duration_seconds: 240,
            uploader_id: None,
            uploader_name: None,
        }
    }
    fn edit(c: &Connection, order: usize, cid: i64, mode: &str) {
        let row = list(c, LIST)
            .unwrap()
            .into_iter()
            .find(|r| r.order == order)
            .unwrap();
        bind(
            c,
            LIST,
            &[Change {
                entry_id: row.entry_id,
                expected_revision: row.revision,
                track: track(cid),
                mode: mode.into(),
            }],
        )
        .unwrap()
    }
    fn replicate(a: &Connection, b: &Connection) {
        let tx = b.unchecked_transaction().unwrap();
        merge(b, &registers(a, false).unwrap()).unwrap();
        tx.commit().unwrap()
    }
    #[test]
    fn removing_unmatched_slot_survives_sync_and_reseeding() {
        let a = db();
        let b = db();
        for database in [&a, &b] {
            seed(database, LIST, "歌单", "qq", &rows()).unwrap();
        }
        replicate(&a, &b);
        replicate(&b, &a);
        let entry = list(&a, LIST).unwrap().remove(1);
        assert!(remove_missing(&a, "import:other", &entry.entry_id, &entry.revision).is_err());
        remove_missing(&a, LIST, &entry.entry_id, &entry.revision).unwrap();
        edit(&b, 1, 9, "manual");
        replicate(&a, &b);
        replicate(&b, &a);
        for database in [&a, &b] {
            seed(database, LIST, "歌单", "qq", &rows()).unwrap();
            let positions: Vec<_> = list(database, LIST)
                .unwrap()
                .iter()
                .map(|r| r.order)
                .collect();
            assert_eq!(positions, [0, 2]);
        }
    }

    #[test]
    fn removing_unmatched_slot_cannot_delete_a_new_binding() {
        let c = db();
        seed(&c, LIST, "歌单", "qq", &rows()).unwrap();
        let before = list(&c, LIST).unwrap().remove(1);
        edit(&c, 1, 9, "manual");
        let matched = list(&c, LIST).unwrap().remove(1);
        assert!(remove_missing(&c, LIST, &before.entry_id, &before.revision).is_err());
        assert!(remove_missing(&c, LIST, &matched.entry_id, &matched.revision).is_err());
        assert_eq!(list(&c, LIST).unwrap()[1].track_id, Some(track(9).id));
    }

    #[test]
    fn removing_duplicate_unmatched_slot_keeps_the_winning_binding() {
        let a = db();
        let b = db();
        seed(&a, LIST, "歌单", "qq", &rows()).unwrap();
        seed(&b, LIST, "歌单", "qq", &rows()).unwrap();
        edit(&a, 0, 9, "manual");
        edit(&b, 1, 9, "manual");
        replicate(&a, &b);
        let entries = list(&b, LIST).unwrap();
        assert!(entries[1].track_id.is_none() && entries[1].message.is_some());
        remove_missing(&b, LIST, &entries[1].entry_id, &entries[1].revision).unwrap();
        replicate(&b, &a);
        for database in [&a, &b] {
            assert_eq!(list(database, LIST).unwrap()[0].track_id, Some(track(9).id));
            let position: i64 = database
                .query_row(
                    "SELECT position FROM playlist_items WHERE playlist_id=?1 AND track_id=?2",
                    params![LIST, track(9).id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(position, 0);
        }
    }
    #[test]
    fn stable_slot_seed_is_idempotent_and_does_not_guess_bili_copy_provenance() {
        let c = db();
        seed(&c, LIST, "源歌单", "qq", &rows()).unwrap();
        let before = list(&c, LIST).unwrap();
        seed(&c, LIST, "源歌单", "qq", &rows()).unwrap();
        let after = list(&c, LIST).unwrap();
        assert_eq!(before[0].revision, after[0].revision);
        assert_eq!(after.len(), 3);
        c.execute(
            "INSERT INTO playlists(id,name) VALUES('import:copy','B站复制')",
            [],
        )
        .unwrap();
        migrate_archive(&c, "import:copy").unwrap();
        assert!(list(&c, "import:copy").unwrap().is_empty());
    }
    #[test]
    fn imported_playlist_reorder_keeps_manually_added_tracks_and_updates_the_cover() {
        use crate::infrastructure::repositories::{
            library::LibraryRepository, playlists::PlaylistRepository,
        };
        let mut c = db();
        let root = std::env::temp_dir().join(format!("import-order-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        seed(&c, LIST, "歌单", "qq", &rows()).unwrap();
        edit(&c, 0, 1, "automatic");
        edit(&c, 2, 3, "automatic");
        let mut manual = track(4);
        manual.cover_url = Some("https://i0.hdslb.com/bfs/cover/4.jpg".into());
        LibraryRepository::upsert(&mut c, &manual).unwrap();
        PlaylistRepository::add_tracks(&c, LIST, &[manual.id.clone()], true).unwrap();
        let ids = |cids: &[i64]| cids.iter().map(|&cid| track(cid).id).collect::<Vec<_>>();
        assert!(
            PlaylistRepository::reorder(&mut c, &root, LIST, &ids(&[1, 3, 4]), &ids(&[4, 3, 1]))
                .unwrap()
        );
        assert_eq!(
            PlaylistRepository::get(&c, LIST).unwrap().cover_url,
            manual.cover_url
        );
        let order = |c: &Connection| {
            PlaylistRepository::tracks(c, LIST)
                .unwrap()
                .into_iter()
                .map(|track| track.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(order(&c), ids(&[4, 3, 1]));
        assert_eq!(
            PlaylistRepository::replace_video(&mut c, &root, LIST, &manual.id, &track(5), None)
                .unwrap(),
            None
        );
        assert_eq!(order(&c), ids(&[5, 3, 1]));
        edit(&c, 1, 2, "automatic");
        assert_eq!(order(&c), ids(&[5, 2, 3, 1]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacements_keep_order_other_lists_favorites_and_global_edits() {
        let c = db();
        seed(&c, LIST, "歌单", "qq", &rows()).unwrap();
        edit(&c, 0, 1, "automatic");
        edit(&c, 2, 3, "automatic");
        edit(&c, 1, 2, "automatic");
        c.execute("INSERT INTO playlists(id,name) VALUES('other','其他')", [])
            .unwrap();
        c.execute(
            "INSERT INTO playlist_items(playlist_id,track_id,position) VALUES('other',?1,0)",
            [&track(2).id],
        )
        .unwrap();
        c.execute("INSERT INTO favorites(track_id) VALUES(?1)", [&track(2).id])
            .unwrap();
        c.execute(
            "INSERT INTO metadata_overrides(track_id,title) VALUES(?1,'用户编辑')",
            [&track(2).id],
        )
        .unwrap();
        edit(&c, 1, 4, "manual");
        let ids = super::super::playlists::PlaylistRepository::tracks(&c, LIST)
            .unwrap()
            .into_iter()
            .map(|t| t.cid)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![1, 4, 3]);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            super::super::playlists::PlaylistRepository::tracks(&c, "other").unwrap()[0].title,
            "用户编辑"
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM metadata_overrides", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn stale_bind_and_duplicate_target_roll_back_the_whole_batch() {
        let c = db();
        seed(&c, LIST, "歌单", "text", &rows()).unwrap();
        let old = list(&c, LIST).unwrap()[0].clone();
        edit(&c, 0, 1, "manual");
        assert!(
            bind(
                &c,
                LIST,
                &[Change {
                    entry_id: old.entry_id,
                    expected_revision: old.revision,
                    track: track(2),
                    mode: "automatic".into()
                }]
            )
            .is_err()
        );
        let all = list(&c, LIST).unwrap();
        assert!(
            bind(
                &c,
                LIST,
                &[
                    Change {
                        entry_id: all[1].entry_id.clone(),
                        expected_revision: all[1].revision.clone(),
                        track: track(3),
                        mode: "automatic".into()
                    },
                    Change {
                        entry_id: all[2].entry_id.clone(),
                        expected_revision: all[2].revision.clone(),
                        track: track(1),
                        mode: "manual".into()
                    }
                ]
            )
            .is_err()
        );
        assert!(list(&c, LIST).unwrap()[1].track_id.is_none());
    }
    #[test]
    fn concurrent_manual_beats_auto_and_same_slot_never_duplicates() {
        let a = db();
        let b = db();
        seed(&a, LIST, "歌单", "qq", &rows()).unwrap();
        seed(&b, LIST, "歌单", "qq", &rows()).unwrap();
        replicate(&a, &b);
        replicate(&b, &a);
        edit(&a, 0, 1, "automatic");
        edit(&b, 0, 2, "manual");
        replicate(&a, &b);
        replicate(&b, &a);
        assert_eq!(list(&a, LIST).unwrap()[0].track_id, Some(track(2).id));
        assert_eq!(
            list(&a, LIST).unwrap()[0].revision,
            list(&b, LIST).unwrap()[0].revision
        );
        assert_eq!(
            super::super::playlists::PlaylistRepository::tracks(&a, LIST)
                .unwrap()
                .len(),
            1
        );
        edit(&a, 0, 3, "manual");
        edit(&b, 0, 4, "manual");
        replicate(&a, &b);
        replicate(&b, &a);
        assert_eq!(
            list(&a, LIST).unwrap()[0].track_id,
            list(&b, LIST).unwrap()[0].track_id
        );
    }
    #[test]
    fn deletion_beats_concurrent_replacement_and_core_mirror_cannot_revive() {
        let a = db();
        let b = db();
        seed(&a, LIST, "歌单", "qq", &rows()).unwrap();
        seed(&b, LIST, "歌单", "qq", &rows()).unwrap();
        edit(&a, 0, 1, "manual");
        replicate(&a, &b);
        remove(&a, LIST, Some(&track(1).id)).unwrap();
        project(&a).unwrap();
        edit(&b, 0, 2, "manual");
        replicate(&a, &b);
        replicate(&b, &a);
        assert_eq!(list(&a, LIST).unwrap().len(), 2);
        assert!(
            super::super::playlists::PlaylistRepository::tracks(&a, LIST)
                .unwrap()
                .is_empty()
        );
        let core = crate::sync::storage::export(&b, "42", false).unwrap();
        crate::sync::storage::apply(&a, &core, false).unwrap();
        assert!(
            super::super::playlists::PlaylistRepository::tracks(&a, LIST)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn duplicate_video_from_different_slots_is_visible_as_recoverable_missing() {
        let a = db();
        let b = db();
        seed(&a, LIST, "歌单", "qq", &rows()).unwrap();
        seed(&b, LIST, "歌单", "qq", &rows()).unwrap();
        replicate(&a, &b);
        replicate(&b, &a);
        edit(&a, 0, 1, "manual");
        edit(&b, 1, 1, "manual");
        replicate(&a, &b);
        replicate(&b, &a);
        let rows = list(&a, LIST).unwrap();
        assert_eq!(rows.iter().filter(|r| r.track_id.is_some()).count(), 1);
        assert!(rows[1].message.is_some());
        edit(&a, 1, 2, "automatic");
        assert_eq!(list(&a, LIST).unwrap()[1].track_id, Some(track(2).id));
    }
    #[test]
    fn failed_projection_rolls_back_binding_and_member_together() {
        let c = db();
        seed(&c, LIST, "歌单", "qq", &rows()).unwrap();
        edit(&c, 0, 1, "manual");
        let old = list(&c, LIST).unwrap()[0].clone();
        c.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON playlist_items WHEN NEW.track_id='bilibili:BV1GJ411x7h7:2' BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(
            bind(
                &c,
                LIST,
                &[Change {
                    entry_id: old.entry_id.clone(),
                    expected_revision: old.revision.clone(),
                    track: track(2),
                    mode: "manual".into()
                }]
            )
            .is_err()
        );
        assert_eq!(list(&c, LIST).unwrap()[0].revision, old.revision);
        assert_eq!(
            super::super::playlists::PlaylistRepository::tracks(&c, LIST).unwrap()[0].cid,
            1
        );
    }
    #[test]
    fn independent_legacy_migrations_share_ids_and_modern_selection_beats_stale_baseline() {
        let a = db();
        let b = db();
        let archive = serde_json::json!({"source":"qq","rows":[{"order":0,"song":song("一"),"status":"saved","chosen":{"track":{"id":track(1).id}}},{"order":1,"song":song("二"),"status":"missing"}]});
        for c in [&a, &b] {
            seed(c, LIST, "旧歌单", "qq", &rows()).unwrap();
            edit(c, 0, 1, "manual");
            c.execute_batch("DELETE FROM imported_entries; DELETE FROM imported_entry_runtime; DELETE FROM imported_entry_owned; DELETE FROM imported_entry_mirror_intents;").unwrap();
            c.execute(
                "INSERT INTO playlist_import_archives VALUES(?1,?2,CURRENT_TIMESTAMP)",
                params![LIST, archive.to_string()],
            )
            .unwrap();
            migrate_archive(c, LIST).unwrap();
        }
        assert_eq!(registers(&a, false).unwrap(), registers(&b, false).unwrap());
        assert_eq!(
            list(&a, LIST).unwrap()[0].entry_id,
            list(&b, LIST).unwrap()[0].entry_id
        );
        // An independently upgraded device seeded a canonical source before seeing the old baseline.
        let modern = db();
        seed(&modern, LIST, "歌单", "qq", &rows()).unwrap();
        edit(&modern, 0, 2, "manual");
        replicate(&modern, &a);
        replicate(&a, &modern);
        assert_eq!(list(&a, LIST).unwrap()[0].track_id, Some(track(2).id));
    }
    #[test]
    fn legacy_archive_migration_retains_missing_order_without_manufacturing_tombstones() {
        let a = db();
        seed(&a, LIST, "歌单", "qq", &rows()).unwrap();
        edit(&a, 0, 1, "manual");
        let b = db();
        b.execute("INSERT INTO playlists(id,name) VALUES(?1,'旧歌单')", [LIST])
            .unwrap();
        let archive = serde_json::json!({"source":"qq","rows":[{"order":0,"song":song("一"),"status":"saved","chosen":{"track":{"id":track(999).id}}},{"order":1,"song":song("二"),"status":"missing"}]});
        b.execute(
            "INSERT INTO playlist_import_archives VALUES(?1,?2,CURRENT_TIMESTAMP)",
            params![LIST, archive.to_string()],
        )
        .unwrap();
        migrate_archive(&b, LIST).unwrap();
        assert_eq!(list(&b, LIST).unwrap().len(), 1);
        assert_eq!(list(&b, LIST).unwrap()[0].order, 1);
        replicate(&a, &b);
        assert_eq!(list(&b, LIST).unwrap()[0].track_id, Some(track(1).id));
        let before = registers(&b, false).unwrap();
        migrate_archive(&b, LIST).unwrap();
        assert_eq!(before, registers(&b, false).unwrap());
    }
}

/// Core membership is a compatibility mirror. Only a local slot operation may
/// author its delta; receiving a slot is not another user operation.
pub struct MirrorCapture {
    owned: BTreeSet<(String, String)>,
    dirty: BTreeSet<(String, String)>,
}
impl MirrorCapture {
    pub fn new(c: &Connection, target: &str) -> Result<Self, String> {
        init(c).map_err(err)?;
        let cursor = runtime(c, &format!("mirror:{target}"))?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let mut q = c
            .prepare("SELECT playlist_id,track_id FROM imported_entry_owned")
            .map_err(err)?;
        let owned = q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .collect::<rusqlite::Result<BTreeSet<_>>>()
            .map_err(err)?;
        let mut q = c
            .prepare(
                "SELECT playlist_id,track_id FROM imported_entry_mirror_intents WHERE revision>?1",
            )
            .map_err(err)?;
        let dirty = q
            .query_map([cursor], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?
            .collect::<rusqlite::Result<BTreeSet<_>>>()
            .map_err(err)?;
        Ok(Self { owned, dirty })
    }
    pub fn allow_item(&self, entity: &str) -> bool {
        let Some((playlist, track)) = entity.strip_prefix("item:").and_then(|s| s.split_once('|'))
        else {
            return true;
        };
        let key = (playlist.to_string(), track.to_string());
        !self.owned.contains(&key) || self.dirty.contains(&key)
    }
    pub fn remote_track(&self, id: &str) -> bool {
        self.owned.iter().any(|(_, t)| t == id) && !self.dirty.iter().any(|(_, t)| t == id)
    }
}
pub fn acknowledge_core(c: &Connection, target: &str) -> Result<(), String> {
    let revision = runtime(c, "revision")?.unwrap_or_else(|| "0".into());
    put_runtime(c, &format!("mirror:{target}"), &revision)
}
