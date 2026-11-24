//! Account-scoped chapter lists, published through an optional WebDAV extension.
use super::{
    Config,
    actor::Lease,
    causal::{self, Candidate, Cell, Dot, Register},
    engine::{get as read_state, put as write_state},
    migration::Genesis,
    model::{self, Snapshot},
    protocol_v2::{self, ObjectRef},
    transport::Secret,
    v2_net::Client,
};
use crate::infrastructure::database::{Database, account_session};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const NAMESPACE: &str = "chapters-v1";
const PREFIX: &str = "ext-chapters-v1-";
const MAX_CHAPTERS: usize = 200;
const MAX_TITLE_CHARS: usize = 160;
const MAX_START_MS: u64 = 9_007_199_254_740_991;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedChapter {
    pub start_ms: u64,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct SavedChapters {
    pub session: String,
    pub revision: String,
    pub chapters: Option<Vec<SavedChapter>>,
}

fn valid_key(bvid: &str, cid: i64) -> bool {
    cid > 0
        && bvid.len() == 12
        && bvid.starts_with("BV")
        && bvid.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn validate_list(chapters: &[SavedChapter]) -> Result<(), String> {
    if chapters.is_empty()
        || chapters.len() > MAX_CHAPTERS
        || chapters
            .windows(2)
            .any(|pair| pair[0].start_ms >= pair[1].start_ms)
        || chapters.iter().any(|chapter| {
            chapter.start_ms > MAX_START_MS
                || chapter.title.is_empty()
                || chapter.title.trim() != chapter.title
                || chapter.title.contains(['\r', '\n', '\0'])
                || chapter.title.chars().count() > MAX_TITLE_CHARS
        })
    {
        return Err("章节的时间或标题无效".into());
    }
    Ok(())
}

fn read_register(c: &Connection, bvid: &str, cid: i64) -> Result<Register, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT register_json FROM saved_chapters WHERE bvid=?1 AND cid=?2",
            params![bvid, cid],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    raw.map(|json| serde_json::from_str(&json).map_err(err))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn write_register(c: &Connection, bvid: &str, cid: i64, value: &Register) -> Result<(), String> {
    c.execute(
        "INSERT INTO saved_chapters(bvid,cid,register_json) VALUES(?1,?2,?3)
         ON CONFLICT(bvid,cid) DO UPDATE SET register_json=excluded.register_json",
        params![bvid, cid, serde_json::to_string(value).map_err(err)?],
    )
    .map_err(err)?;
    Ok(())
}

fn selected(register: &Register) -> Option<&Cell> {
    // Causal merging removes superseded operations. Concurrent deletion wins over
    // edits, and concurrent edits select a whole list by the register's stable order.
    register
        .values
        .iter()
        .find(|candidate| candidate.cell == Cell::Missing)
        .or_else(|| register.values.last())
        .map(|candidate| &candidate.cell)
}

fn revision(register: &Register) -> Result<String, String> {
    Ok(causal::hash(&serde_json::to_vec(register).map_err(err)?))
}

fn snapshot(session: String, register: &Register) -> Result<SavedChapters, String> {
    let chapters = match selected(register) {
        Some(Cell::Value(value)) => Some(serde_json::from_value(value.clone()).map_err(err)?),
        Some(Cell::Missing) | None => None,
    };
    Ok(SavedChapters {
        session,
        revision: revision(register)?,
        chapters,
    })
}

pub fn get(db: &Database, bvid: &str, cid: i64) -> Result<SavedChapters, String> {
    if !valid_key(bvid, cid) {
        return Err("章节对应的视频分 P 无效".into());
    }
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    snapshot(
        account_session(&c).map_err(err)?,
        &read_register(&c, bvid, cid)?,
    )
}

#[derive(Default, Serialize, Deserialize)]
struct Writer {
    instance: String,
    sequence: u64,
    revision: u64,
}

fn writer(c: &Connection) -> Result<Writer, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT value FROM sync_info WHERE key='chapters-writer'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    raw.map(|json| serde_json::from_str(&json).map_err(err))
        .transpose()
        .map(Option::unwrap_or_default)
}

pub fn save(
    db: &Database,
    bvid: &str,
    cid: i64,
    expected_session: &str,
    expected_revision: &str,
    chapters: Option<Vec<SavedChapter>>,
) -> Result<SavedChapters, String> {
    if !valid_key(bvid, cid) {
        return Err("章节对应的视频分 P 无效".into());
    }
    let cell = if let Some(chapters) = chapters {
        validate_list(&chapters)?;
        Cell::Value(serde_json::to_value(chapters).map_err(err)?)
    } else {
        Cell::Missing
    };
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    let session = account_session(&c).map_err(err)?;
    if session != expected_session {
        return Err("账号已切换，请重新打开章节编辑".into());
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut register = read_register(&tx, bvid, cid)?;
    if revision(&register)? != expected_revision {
        return Err("章节已在别处修改，请重新打开编辑".into());
    }
    if (register.values.is_empty() && cell == Cell::Missing)
        || (register.values.len() == 1 && register.values[0].cell == cell)
    {
        return snapshot(session, &register);
    }

    let mut state = writer(&tx)?;
    if state.instance.is_empty() {
        state.instance = uuid::Uuid::new_v4().to_string();
    }
    let installation = super::engine::installation(&db.1)?;
    let open = |instance: &str| {
        Lease::open(
            &db.1
                .join("chapters-writer")
                .join(format!("{installation}-{instance}")),
            instance,
        )
    };
    let mut lease = open(&state.instance)?;
    if !lease.consistent(&BTreeMap::from([(NAMESPACE.into(), state.sequence)])) {
        state.instance = uuid::Uuid::new_v4().to_string();
        state.sequence = 0;
        lease = open(&state.instance)?;
    }
    let next = state.sequence.checked_add(1).ok_or("章节操作序号耗尽")?;
    lease.reserve(NAMESPACE, state.sequence, next)?;
    let dot = Dot {
        actor: lease.actor().into(),
        seq: next,
    };
    register.seen.insert(&dot);
    register.values = vec![Candidate { dot, cell }];
    write_register(&tx, bvid, cid, &register)?;

    state.sequence = next;
    state.revision = state.revision.checked_add(1).ok_or("章节版本耗尽")?;
    tx.execute(
        "INSERT INTO sync_info(key,value) VALUES('chapters-writer',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(&state).map_err(err)?],
    )
    .map_err(err)?;
    let result = snapshot(session, &register)?;
    tx.commit().map_err(err)?;
    Ok(result)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    schema: u32,
    namespace: String,
    uid: String,
    vault: String,
    seed: String,
    actor: String,
    generation: u64,
    registers: BTreeMap<String, Register>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Head {
    generation: u64,
    hash: String,
}

#[derive(Serialize, Deserialize)]
struct Pending {
    actor: String,
    head: Head,
    revision: u64,
    bytes: Vec<u8>,
}

#[derive(Default, Serialize, Deserialize)]
struct ExchangeState {
    heads: BTreeMap<String, Head>,
    published_revision: u64,
    pending: Option<Pending>,
    #[serde(default)]
    observed: Option<String>,
    #[serde(default)]
    dirty: bool,
    #[serde(default)]
    deferred: BTreeMap<String, BTreeSet<String>>,
}

fn packet_keys(key: &str) -> Result<(&str, i64), String> {
    let (bvid, cid) = key.split_once(':').ok_or("章节同步键无效")?;
    let number = cid.parse::<i64>().map_err(err)?;
    if !valid_key(bvid, number) || number.to_string() != cid {
        return Err("章节同步键无效".into());
    }
    Ok((bvid, number))
}

fn validate_packet(
    packet: &Packet,
    genesis: &Genesis,
    actor: &str,
    head: &Head,
) -> Result<(), String> {
    if packet.schema != 1
        || packet.namespace != NAMESPACE
        || packet.uid != genesis.uid
        || packet.vault != genesis.vault
        || packet.seed != genesis.seed
        || uuid::Uuid::parse_str(actor).is_err()
        || packet.actor != actor
        || packet.generation == 0
        || packet.generation != head.generation
        || packet.registers.len() > 20_000
    {
        return Err("章节同步身份或版本无效".into());
    }
    for (key, register) in &packet.registers {
        packet_keys(key)?;
        if register.values.is_empty() {
            return Err("章节同步操作无效".into());
        }
        for candidate in &register.values {
            if let Cell::Value(value) = &candidate.cell {
                validate_list(
                    &serde_json::from_value::<Vec<SavedChapter>>(value.clone()).map_err(err)?,
                )?;
            }
        }
        Register::default().merge(register)?;
    }
    Ok(())
}

fn decode_packet(
    bytes: &[u8],
    genesis: &Genesis,
    actor: &str,
    head: &Head,
) -> Result<Packet, String> {
    let packet = protocol_v2::decode(
        bytes,
        &ObjectRef {
            hash: head.hash.clone(),
            bytes: bytes.len() as u64,
            first_seq: 0,
            last_seq: 0,
        },
    )?;
    validate_packet(&packet, genesis, actor, head)?;
    Ok(packet)
}

fn object(genesis: &Genesis, hash: &str) -> String {
    format!(
        "sync-v2/{}/extensions/{NAMESPACE}/{hash}.json.gz",
        genesis.vault
    )
}

fn head_name(head: &Head) -> String {
    format!("{PREFIX}{:020}-{}.head", head.generation, head.hash)
}

fn parse_head(name: &str) -> Option<Head> {
    let (seq, hash) = name
        .strip_prefix(PREFIX)?
        .strip_suffix(".head")?
        .split_once('-')?;
    let generation = seq.parse::<u64>().ok().filter(|value| *value > 0)?;
    if seq.len() != 20 || !causal::valid_hash(hash) {
        return None;
    }
    Some(Head {
        generation,
        hash: hash.into(),
    })
}

fn scope(library: &Snapshot) -> BTreeSet<String> {
    // The core snapshot already excludes local files, unreferenced tracks, and
    // recent plays outside the device's history sync setting and limit.
    library
        .records
        .values()
        .filter(|record| record.kind == "track")
        .map(|record| (model::text(record, "bvid"), model::number(record, "cid")))
        .filter(|(bvid, cid)| valid_key(bvid, *cid))
        .map(|(bvid, cid)| format!("{bvid}:{cid}"))
        .collect()
}

fn project(c: &Connection, scope: &BTreeSet<String>) -> Result<BTreeMap<String, Register>, String> {
    let mut registers = BTreeMap::new();
    if scope.is_empty() {
        return Ok(registers);
    }
    let mut query = c
        .prepare("SELECT bvid,cid,register_json FROM saved_chapters ORDER BY bvid,cid")
        .map_err(err)?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(err)?;
    for row in rows {
        let (bvid, cid, value) = row.map_err(err)?;
        let key = format!("{bvid}:{cid}");
        if scope.contains(&key) {
            registers.insert(key, serde_json::from_str(&value).map_err(err)?);
        }
    }
    Ok(registers)
}

fn projection_digest(registers: &BTreeMap<String, Register>) -> Result<String, String> {
    Ok(causal::hash(&serde_json::to_vec(registers).map_err(err)?))
}

fn freeze(
    registers: BTreeMap<String, Register>,
    genesis: &Genesis,
    owner: &str,
    generation: u64,
    revision: u64,
) -> Result<Pending, String> {
    let packet = Packet {
        schema: 1,
        namespace: NAMESPACE.into(),
        uid: genesis.uid.clone(),
        vault: genesis.vault.clone(),
        seed: genesis.seed.clone(),
        actor: owner.into(),
        generation,
        registers,
    };
    let bytes = protocol_v2::encode(&packet)?;
    let head = Head {
        generation,
        hash: causal::hash(&bytes),
    };
    validate_packet(&packet, genesis, owner, &head)?;
    Ok(Pending {
        actor: owner.into(),
        head,
        revision,
        bytes,
    })
}

pub(super) async fn exchange(
    db: &Database,
    cfg: &Config,
    secret: &Secret,
    owner: &str,
    session: &str,
    library: &Snapshot,
) -> Result<bool, String> {
    let scope = scope(library);
    let target = super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    let genesis = Genesis::for_config(cfg)?;
    let net = Client::cached(cfg, secret, db.1.join("chapter-sync-cache").join(&target))?;
    let with =
        |operation: &mut dyn FnMut(&Connection) -> Result<(), String>| -> Result<(), String> {
            let c = db.0.lock().map_err(|_| "数据库正忙")?;
            super::active(db, &cfg.uid)?;
            let config = super::config_from_connection(&c)?.ok_or("同步连接已改变")?;
            let active_target: String = c
                .query_row(
                    "SELECT value FROM sync_info WHERE key='active_target'",
                    [],
                    |row| row.get(0),
                )
                .map_err(err)?;
            if account_session(&c).map_err(err)? != session
                || config.provider != cfg.provider
                || config.uid != cfg.uid
                || config.url != cfg.url
                || config.history != cfg.history
                || active_target != target
            {
                return Err("同步连接或账号已切换".into());
            }
            let tx = c.unchecked_transaction().map_err(err)?;
            operation(&tx)?;
            tx.commit().map_err(err)
        };
    let mut state = ExchangeState::default();
    with(&mut |c| {
        state = read_state(c, &target, NAMESPACE)?.unwrap_or_default();
        Ok(())
    })?;

    let control = format!("sync-v2/{}/control/", genesis.vault);
    let (owners, _) = net.list(&control).await?;
    if state.heads.keys().any(|actor| !owners.contains(actor)) {
        return Err("已确认的章节同步设备暂不可见".into());
    }

    let mut incoming = Vec::new();
    for actor in owners
        .into_iter()
        .filter(|a| uuid::Uuid::parse_str(a).is_ok())
    {
        let path = format!("{control}{actor}/");
        let heads = net.list(&path).await?.0;
        let mut heads = heads
            .iter()
            .filter_map(|name| parse_head(name))
            .collect::<Vec<_>>();
        heads.sort_unstable_by_key(|head| head.generation);
        let known = state.heads.get(&actor);
        let Some(head) = heads.pop() else {
            if known.is_some() {
                return Err("章节同步提交暂不可见".into());
            }
            continue;
        };
        if heads
            .last()
            .is_some_and(|previous| previous.generation == head.generation)
            || known.is_some_and(|old| {
                old.generation > head.generation
                    || (old.generation == head.generation && old.hash != head.hash)
            })
        {
            return Err("章节同步提交发生回退或分叉".into());
        }
        if known == Some(&head) {
            if state
                .deferred
                .get(&actor)
                .is_none_or(|keys| keys.is_disjoint(&scope))
            {
                continue;
            }
        } else {
            let marker = net
                .get(&format!("{path}{}", head_name(&head)))
                .await?
                .ok_or("章节同步提交暂不可见")?;
            if marker.body != head.hash.as_bytes() {
                return Err("章节同步提交摘要不符".into());
            }
        }
        let body = net
            .get(&object(&genesis, &head.hash))
            .await?
            .ok_or("章节同步对象暂不可见")?;
        let packet = decode_packet(&body.body, &genesis, &actor, &head)?;
        incoming.push((actor, head, packet));
    }

    let mut changed = false;
    with(&mut |c| {
        let mut registers = project(c, &scope)?;
        let before = projection_digest(&registers)?;
        let local_revision = writer(c)?.revision;
        let owner_has_head = state.heads.contains_key(owner);
        // Compare against the last observation made after merging remote data.
        // Only a local edit or a change in library membership can make it dirty.
        state.dirty |= match &state.observed {
            Some(observed) => observed != &before && (local_revision > 0 || owner_has_head),
            None => (local_revision > 0 && !registers.is_empty()) || owner_has_head,
        };
        for (actor, head, packet) in &incoming {
            let mut deferred = BTreeSet::new();
            for (key, remote) in &packet.registers {
                if !scope.contains(key) {
                    deferred.insert(key.clone());
                    continue;
                }
                let (bvid, cid) = packet_keys(key)?;
                let local = registers.entry(key.clone()).or_default();
                let old = selected(local).cloned();
                local.merge(remote)?;
                changed |= old.as_ref() != selected(local);
                write_register(c, bvid, cid, local)?;
            }
            if deferred.is_empty() {
                state.deferred.remove(actor);
            } else {
                state.dirty |= actor == owner;
                state.deferred.insert(actor.clone(), deferred);
            }
            state.heads.insert(actor.clone(), head.clone());
        }
        let observed = if incoming.is_empty() {
            before
        } else {
            projection_digest(&registers)?
        };
        let mut superseded_generation = 0;
        if let Some(pending) = &state.pending {
            if state.heads.get(&pending.actor) == Some(&pending.head) {
                state.published_revision = pending.revision;
                state.pending = None;
            } else if state
                .heads
                .get(&pending.actor)
                .is_some_and(|head| head.generation >= pending.head.generation)
                || decode_packet(&pending.bytes, &genesis, &pending.actor, &pending.head)?
                    .registers
                    .keys()
                    .any(|key| !scope.contains(key))
            {
                if pending.actor == owner {
                    superseded_generation = pending.head.generation;
                }
                state.pending = None;
                state.dirty = true;
            }
        }
        if incoming.is_empty() && !state.dirty && state.observed.as_ref() == Some(&observed) {
            return Ok(());
        }
        state.observed = Some(observed);
        if state.pending.is_none() && state.dirty {
            if !registers.is_empty() || state.heads.contains_key(owner) || superseded_generation > 0
            {
                // A PUT that failed may still become visible. Advance the head
                // instead of reusing that generation with another payload.
                let generation = state
                    .heads
                    .get(owner)
                    .map_or(0, |head| head.generation)
                    .max(superseded_generation)
                    .checked_add(1)
                    .ok_or("章节同步提交序号耗尽")?;
                state.pending = Some(freeze(
                    registers,
                    &genesis,
                    owner,
                    generation,
                    local_revision,
                )?);
            }
            state.dirty = false;
        }
        write_state(c, &target, NAMESPACE, &state)
    })?;

    if let Some(pending) = state.pending.take() {
        let directory = format!("sync-v2/{}/extensions/{NAMESPACE}/", genesis.vault);
        net.mkdir(&directory).await?;
        net.mkdir(&format!("{control}{}/", pending.actor)).await?;
        with(&mut |_| Ok(()))?;
        net.put(&object(&genesis, &pending.head.hash), pending.bytes)
            .await?;
        with(&mut |_| Ok(()))?;
        let marker = format!("{control}{}/{}", pending.actor, head_name(&pending.head));
        net.put(&marker, pending.head.hash.as_bytes().to_vec())
            .await?;
        if net
            .get(&marker)
            .await?
            .is_none_or(|object| object.body != pending.head.hash.as_bytes())
        {
            return Err("章节同步提交尚未确认".into());
        }
        with(&mut |c| {
            state.published_revision = pending.revision;
            state
                .heads
                .insert(pending.actor.clone(), pending.head.clone());
            write_state(c, &target, NAMESPACE, &state)
        })?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::Mutex};

    const BV: &str = "BV1qFuQz2EVx";

    fn database(cfg: &Config, secret: &Secret) -> Database {
        let root = std::env::temp_dir().join(format!("chapter-sync-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("active-profile"), &cfg.uid).unwrap();
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute(
            "INSERT INTO sync_settings VALUES(1,?1)",
            [serde_json::to_string(cfg).unwrap()],
        )
        .unwrap();
        let target =
            super::super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)
                .unwrap();
        super::super::engine::bind_target(&c, cfg, &target).unwrap();
        Database(Mutex::new(c), root)
    }

    fn list(title: &str) -> Vec<SavedChapter> {
        vec![
            SavedChapter {
                start_ms: 0,
                title: title.to_owned(),
            },
            SavedChapter {
                start_ms: 3_652_000,
                title: "跨小时的续帖".into(),
            },
        ]
    }

    fn edit_part(db: &Database, cid: i64, chapters: Option<Vec<SavedChapter>>) -> SavedChapters {
        let old = get(db, BV, cid).unwrap();
        save(db, BV, cid, &old.session, &old.revision, chapters).unwrap()
    }

    fn edit(db: &Database, chapters: Option<Vec<SavedChapter>>) -> SavedChapters {
        edit_part(db, 1, chapters)
    }

    fn track(c: &Connection, cid: i64) -> String {
        let id = format!("bilibili:{BV}:{cid}");
        c.execute(
            "INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili',?2,?3)",
            params![id, BV, cid],
        )
        .unwrap();
        c.execute(
            "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'Test track')",
            [&id],
        )
        .unwrap();
        id
    }

    async fn run(
        db: &Database,
        cfg: &Config,
        secret: &Secret,
        owner: &str,
        session: &str,
    ) -> Result<bool, String> {
        let library = super::super::storage::export(&db.0.lock().unwrap(), &cfg.uid, cfg.history)?;
        exchange(db, cfg, secret, owner, session, &library).await
    }

    #[test]
    fn saved_chapters_require_current_revision_and_account_session() {
        let cfg = Config {
            uid: "42".into(),
            ..Config::default()
        };
        let secret = Secret {
            username: "test".into(),
            password: "test".into(),
        };
        let db = database(&cfg, &secret);
        let initial = get(&db, BV, 1).unwrap();
        assert!(initial.chapters.is_none());
        assert!(
            save(
                &db,
                BV,
                1,
                &initial.session,
                &initial.revision,
                Some(vec![])
            )
            .is_err()
        );
        let mut invalid = list("段名");
        invalid[1].start_ms = invalid[0].start_ms;
        assert!(
            save(
                &db,
                BV,
                1,
                &initial.session,
                &initial.revision,
                Some(invalid)
            )
            .is_err()
        );
        let saved = edit(&db, Some(list("我的段名")));
        assert!(get(&db, BV, 2).unwrap().chapters.is_none());
        assert!(save(&db, BV, 1, &initial.session, &initial.revision, None).is_err());
        assert_eq!(edit(&db, saved.chapters.clone()).revision, saved.revision);
        db.0.lock()
            .unwrap()
            .execute_batch("DROP TABLE temp.account_session")
            .unwrap();
        let reopened = get(&db, BV, 1).unwrap();
        assert_ne!(saved.session, reopened.session);
        assert!(save(&db, BV, 1, &saved.session, &saved.revision, None).is_err());
        assert_eq!(reopened.chapters, Some(list("我的段名")));
        fs::remove_dir_all(db.1).unwrap();
    }

    #[tokio::test]
    async fn only_synced_tracks_publish_chapters_and_membership_changes_need_no_edit() {
        use super::super::test_dav;
        let (cfg, secret, store, server) = test_dav::server().await;
        let db = database(&cfg, &secret);
        let owner = uuid::Uuid::new_v4().to_string();
        let g = Genesis::for_config(&cfg).unwrap();
        let net = Client::new(&cfg, &secret).unwrap();
        net.parents().await.unwrap();
        let control = format!("sync-v2/{}/control/", g.vault);
        net.mkdir(&control).await.unwrap();

        let (orphan, favorite, playlist, recent) = {
            let c = db.0.lock().unwrap();
            (track(&c, 1), track(&c, 2), track(&c, 3), track(&c, 4))
        };
        let session = edit(&db, Some(list("本机章节"))).session;
        run(&db, &cfg, &secret, &owner, &session).await.unwrap();
        assert!(
            !store
                .lock()
                .unwrap()
                .requests
                .iter()
                .any(|(method, _)| method == "PUT")
        );
        assert_eq!(get(&db, BV, 1).unwrap().chapters, Some(list("本机章节")));

        let playlist_id = uuid::Uuid::new_v4().to_string();
        {
            let c = db.0.lock().unwrap();
            c.execute("INSERT INTO favorites(track_id) VALUES(?1)", [&favorite])
                .unwrap();
            c.execute(
                "INSERT INTO playlists(id,name) VALUES(?1,'Test playlist')",
                [&playlist_id],
            )
            .unwrap();
            c.execute(
                "INSERT INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,0)",
                params![playlist_id, playlist],
            )
            .unwrap();
            c.execute("INSERT INTO play_history(track_id) VALUES(?1)", [&recent])
                .unwrap();
        }
        for cid in 2..=4 {
            edit_part(&db, cid, Some(list("分 P 章节")));
        }
        let latest = async || {
            let path = format!("{control}{owner}/");
            let head = net
                .list(&path)
                .await
                .unwrap()
                .0
                .iter()
                .filter_map(|name| parse_head(name))
                .max_by_key(|head| head.generation)
                .unwrap();
            let body = net
                .get(&object(&g, &head.hash))
                .await
                .unwrap()
                .unwrap()
                .body;
            decode_packet(&body, &g, &owner, &head)
                .unwrap()
                .registers
                .into_keys()
                .collect::<BTreeSet<_>>()
        };
        run(&db, &cfg, &secret, &owner, &session).await.unwrap();
        assert_eq!(
            latest().await,
            BTreeSet::from([format!("{BV}:2"), format!("{BV}:3")])
        );

        edit_part(&db, 2, Some(list("尚未发布的章节修改")));
        store.lock().unwrap().fault = Some(test_dav::Fault {
            ordinal: None,
            method: Some("PUT".into()),
            contains: PREFIX.into(),
            failure: test_dav::Failure::DelayPut,
        });
        assert!(run(&db, &cfg, &secret, &owner, &session).await.is_err());
        {
            let c = db.0.lock().unwrap();
            c.execute("DELETE FROM favorites WHERE track_id=?1", [&favorite])
                .unwrap();
            c.execute("INSERT INTO favorites(track_id) VALUES(?1)", [&orphan])
                .unwrap();
        }
        run(&db, &cfg, &secret, &owner, &session).await.unwrap();
        assert_eq!(
            latest().await,
            BTreeSet::from([format!("{BV}:1"), format!("{BV}:3")])
        );
        store.lock().unwrap().flush_delayed();
        run(&db, &cfg, &secret, &owner, &session).await.unwrap();
        assert_eq!(
            latest().await,
            BTreeSet::from([format!("{BV}:1"), format!("{BV}:3")])
        );
        assert_eq!(
            get(&db, BV, 2).unwrap().chapters,
            Some(list("尚未发布的章节修改"))
        );
        assert_eq!(get(&db, BV, 4).unwrap().chapters, Some(list("分 P 章节")));
        fs::remove_dir_all(db.1).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn remote_history_chapters_wait_for_history_sync_without_echo() {
        use super::super::test_dav;
        let (mut cfg, secret, store, server) = test_dav::server().await;
        cfg.history = true;
        let without_history = Config {
            history: false,
            ..cfg.clone()
        };
        let a = database(&cfg, &secret);
        let b = database(&without_history, &secret);
        let owner = uuid::Uuid::new_v4().to_string();
        let peer = uuid::Uuid::new_v4().to_string();
        let net = Client::new(&cfg, &secret).unwrap();
        let g = Genesis::for_config(&cfg).unwrap();
        net.parents().await.unwrap();
        net.mkdir(&format!("sync-v2/{}/control/", g.vault))
            .await
            .unwrap();
        for db in [&a, &b] {
            let c = db.0.lock().unwrap();
            c.execute(
                "INSERT INTO play_history(track_id) VALUES(?1)",
                [track(&c, 1)],
            )
            .unwrap();
        }

        let a_session = edit(&a, Some(list("历史中的章节"))).session;
        run(&a, &cfg, &secret, &owner, &a_session).await.unwrap();
        let b_session = get(&b, BV, 1).unwrap().session;
        assert!(
            !run(&b, &without_history, &secret, &peer, &b_session)
                .await
                .unwrap()
        );
        assert!(get(&b, BV, 1).unwrap().chapters.is_none());

        b.0.lock()
            .unwrap()
            .execute(
                "UPDATE sync_settings SET json=?1",
                [serde_json::to_string(&cfg).unwrap()],
            )
            .unwrap();
        store.lock().unwrap().requests.clear();
        assert!(run(&b, &cfg, &secret, &peer, &b_session).await.unwrap());
        assert_eq!(get(&b, BV, 1).unwrap().chapters, Some(list("历史中的章节")));
        assert!(
            !store
                .lock()
                .unwrap()
                .requests
                .iter()
                .any(|(method, path)| method == "PUT"
                    || (method == "GET" && path.contains("/extensions/chapters-v1/")))
        );

        for db in [a, b] {
            fs::remove_dir_all(db.1).unwrap();
        }
        server.abort();
    }

    #[tokio::test]
    async fn dav_restores_edits_and_deletions_without_echo_or_legacy_heads() {
        use super::super::{protocol_v2, test_dav};
        use std::{sync::Arc, time::Duration};
        use tokio::sync::Notify;
        let (cfg, secret, store, server) = test_dav::server().await;
        let a = database(&cfg, &secret);
        let b = database(&cfg, &secret);
        for db in [&a, &b] {
            let c = db.0.lock().unwrap();
            c.execute("INSERT INTO favorites(track_id) VALUES(?1)", [track(&c, 1)])
                .unwrap();
        }
        let owner = uuid::Uuid::new_v4().to_string();
        let peer = uuid::Uuid::new_v4().to_string();
        let g = Genesis::for_config(&cfg).unwrap();
        let net = Client::new(&cfg, &secret).unwrap();
        net.parents().await.unwrap();
        net.mkdir(&format!("sync-v2/{}/control/", g.vault))
            .await
            .unwrap();

        let a_start = edit(&a, Some(list("初稿")));
        run(&a, &cfg, &secret, &owner, &a_start.session)
            .await
            .unwrap();
        assert!(
            protocol_v2::discover(&net, &g.uid, &g.vault, &g.seed, &owner, 0)
                .await
                .unwrap()
                .is_none()
        );
        let b_before_switch = get(&b, BV, 1).unwrap();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        store.lock().unwrap().gate = Some(test_dav::Gate {
            method: "GET".into(),
            contains: "/extensions/chapters-v1/".into(),
            entered: entered.clone(),
            release: release.clone(),
        });
        let switch_session = async {
            entered.notified().await;
            b.0.lock()
                .unwrap()
                .execute_batch("DROP TABLE temp.account_session")
                .unwrap();
            release.notify_one();
        };
        let (in_flight, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(
                run(&b, &cfg, &secret, &peer, &b_before_switch.session),
                switch_session
            )
        })
        .await
        .unwrap();
        assert!(in_flight.unwrap_err().contains("账号已切换"));
        let b_start = get(&b, BV, 1).unwrap();
        assert!(b_start.chapters.is_none());
        store.lock().unwrap().requests.clear();
        assert!(
            run(&b, &cfg, &secret, &peer, &b_start.session)
                .await
                .unwrap()
        );
        assert_eq!(get(&b, BV, 1).unwrap().chapters, a_start.chapters);
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(method, _)| method != "PUT")
        );
        assert!(
            save(
                &b,
                BV,
                1,
                &b_start.session,
                &b_start.revision,
                Some(list("过期编辑"))
            )
            .is_err()
        );

        edit(&a, Some(list("离线改名")));
        edit(&b, None);
        run(&a, &cfg, &secret, &owner, &a_start.session)
            .await
            .unwrap();
        run(&b, &cfg, &secret, &peer, &b_start.session)
            .await
            .unwrap();
        assert!(
            run(&a, &cfg, &secret, &owner, &a_start.session)
                .await
                .unwrap()
        );
        assert!(get(&a, BV, 1).unwrap().chapters.is_none());
        assert!(get(&b, BV, 1).unwrap().chapters.is_none());

        edit(&a, Some(list("重新确认")));
        store.lock().unwrap().fail_head_once = true;
        assert!(
            run(&a, &cfg, &secret, &owner, &a_start.session)
                .await
                .is_err()
        );
        store.lock().unwrap().requests.clear();
        run(&a, &cfg, &secret, &owner, &a_start.session)
            .await
            .unwrap();
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(method, _)| method != "PUT")
        );
        run(&b, &cfg, &secret, &peer, &b_start.session)
            .await
            .unwrap();
        assert_eq!(get(&b, BV, 1).unwrap().chapters, Some(list("重新确认")));
        for db in [a, b] {
            fs::remove_dir_all(db.1).unwrap();
        }
        server.abort();
    }
}
