//! Shared v2 executor. Network IO never holds a database lock; all local views and intents
//! are committed together, and only the first account bootstrap may read the v1 cloud.
use super::{
    Config, Database, Outcome,
    actor::Lease,
    causal::{self, Cell, Document, Domain, Register},
    migration::Genesis,
    model::{Conflict, Snapshot},
    outbox,
    projection::{self, Facts, View},
    protocol_v2::{self, Head},
    publication, storage,
    transport::Secret,
    upgrade_merge,
    v2_net::Client,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
type Docs = BTreeMap<Domain, Document>;
#[cfg(test)]
tokio::task_local! { pub(super) static BEFORE_PROJECT: Box<dyn Fn(&Database)>; }
fn check_current(c: &Connection, cfg: &Config, expected: &View) -> Result<(), String> {
    if projection::capture(c, &cfg.uid, cfg.history)? != *expected {
        return Err("同步期间本机资料已变化，已保留最新修改，请重试".into());
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selected {
    token: String,
    choices: Facts,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct CandidateOption {
    pub cell: Cell,
    pub label: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ConflictMenu {
    pub token: String,
    pub options: BTreeMap<String, Vec<CandidateOption>>,
}
pub fn validate_resolution(value: &str) -> bool {
    matches!(value, "local" | "remote")
        || (value.len() <= 8 * 1024 * 1024
            && serde_json::from_str::<Selected>(value)
                .is_ok_and(|s| causal::valid_hash(&s.token) && s.choices.len() <= 150_000))
}
fn save_menu(
    c: &Connection,
    target: &str,
    proof: &str,
    current: &View,
    docs: &Docs,
    conflicts: &[Conflict],
) -> Result<(), String> {
    let mut options = BTreeMap::new();
    for conflict in conflicts {
        let key = causal::key(&conflict.key, &conflict.field);
        let local = match conflict.field.as_str() {
            "__record" => current
                .snapshot
                .records
                .get(&conflict.key)
                .map(|r| Cell::Value(serde_json::to_value(r).unwrap()))
                .unwrap_or(Cell::Missing),
            "__parent" => Cell::Value(conflict.local.clone()),
            "__present" => Cell::Value(current.snapshot.records.contains_key(&conflict.key).into()),
            _ => current.facts.get(&key).cloned().unwrap_or(Cell::Missing),
        };
        let mut cells = vec![local.clone()];
        let register = docs[&Domain::Library].registers.get(&key);
        if let Some(reg) = register {
            for candidate in &reg.values {
                if !cells.contains(&candidate.cell) {
                    cells.push(candidate.cell.clone());
                }
            }
        }
        if conflict.field == "__present" {
            // A delete can be concurrent with a FIELD edit, while the existence
            // register itself only contains false. Recovery is still a real choice.
            for present in [true, false] {
                let cell = Cell::Value(present.into());
                if !cells.contains(&cell) {
                    cells.push(cell);
                }
            }
        }
        let remote = if conflict.remote.is_null() {
            Cell::Missing
        } else {
            Cell::Value(conflict.remote.clone())
        };
        if register.is_none() && !cells.contains(&remote) {
            cells.push(remote);
        }
        options.insert(
            key,
            cells
                .into_iter()
                .enumerate()
                .map(|(i, cell)| CandidateOption {
                    cell,
                    label: if i == 0 {
                        "本机".into()
                    } else {
                        format!("云端 {i}")
                    },
                })
                .collect(),
        );
    }
    put(c, target, "conflict-proof", &proof)?;
    put(
        c,
        target,
        "conflict-menu",
        &ConflictMenu {
            token: proof.into(),
            options,
        },
    )
}
fn selected(
    c: &Connection,
    target: &str,
    proof: &str,
    value: Option<&Selected>,
    conflicts: &[Conflict],
) -> Result<Option<Facts>, String> {
    let Some(input) = value.filter(|s| s.token == proof) else {
        return Ok(None);
    };
    let menu: ConflictMenu = get(c, target, "conflict-menu")?.ok_or("请先预览同步冲突")?;
    if menu.token != proof {
        return Ok(None);
    }
    if input.choices.len() != conflicts.len() {
        return Err("请为每项冲突选择保留内容".into());
    }
    for conflict in conflicts {
        let key = causal::key(&conflict.key, &conflict.field);
        let choice = input.choices.get(&key).ok_or("尚有冲突未选择")?;
        if menu
            .options
            .get(&key)
            .is_none_or(|values| !values.iter().any(|v| &v.cell == choice))
        {
            return Err("冲突候选已变化，请重新预览".into());
        }
    }
    Ok(Some(input.choices.clone()))
}
const LIBRARY_DOMAINS: [Domain; 2] = [Domain::Library, Domain::Progress];
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Serialize, Deserialize)]
struct Runtime {
    instance: String,
    genesis: Genesis,
    joined: bool,
    bootstrap: bool,
    anchor: Snapshot,
    old_base: Option<Snapshot>,
    observed: View,
    contexts: BTreeMap<Domain, BTreeMap<String, Register>>,
    needs_seed: BTreeSet<Domain>,
}
pub(super) fn get<T: DeserializeOwned>(
    c: &Connection,
    target: &str,
    key: &str,
) -> Result<Option<T>, String> {
    c.query_row(
        "SELECT json FROM sync_v2_state WHERE target=?1 AND key=?2",
        params![target, key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(err)?
    .map(|s| serde_json::from_str(&s).map_err(|_| "新版同步本机状态损坏".into()))
    .transpose()
}
pub(super) fn put<T: Serialize>(
    c: &Connection,
    target: &str,
    key: &str,
    value: &T,
) -> Result<(), String> {
    c.execute("INSERT INTO sync_v2_state VALUES(?1,?2,?3) ON CONFLICT(target,key) DO UPDATE SET json=excluded.json",params![target,key,serde_json::to_string(value).map_err(err)?]).map_err(err)?;
    Ok(())
}
fn with<T>(
    db: &Database,
    cfg: &Config,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    super::active(db, &cfg.uid)?;
    f(&c)
}
pub(super) fn bind_target(c: &Connection, cfg: &Config, target: &str) -> Result<(), String> {
    // Freeze the scheduler namespace before migration replaces the legacy device ID.
    let tx = c.unchecked_transaction().map_err(err)?;
    c.execute(
        "INSERT OR IGNORE INTO sync_info VALUES('scheduler_binding',?1)",
        [&cfg.device_id],
    )
    .map_err(err)?;
    c.execute("INSERT INTO sync_info VALUES('active_target',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [target]).map_err(err)?;
    tx.commit().map_err(err)
}
pub(super) fn installation(root: &Path) -> Result<String, String> {
    use std::io::Write;
    let path = root.join("sync-installation");
    match std::fs::read_to_string(&path) {
        Ok(id) if uuid::Uuid::parse_str(&id).is_ok() => Ok(id),
        Ok(_) => Err("同步安装身份损坏，本机资料已保留".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = uuid::Uuid::new_v4().to_string();
            match std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
            {
                Ok(mut file) => {
                    file.write_all(id.as_bytes()).map_err(err)?;
                    file.sync_all().map_err(err)?;
                    Ok(id)
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => installation(root),
                Err(e) => Err(err(e)),
            }
        }
        Err(e) => Err(err(e)),
    }
}
fn lease(db: &Database, target: &str, state: &Runtime) -> Result<Lease, String> {
    let install = installation(&db.1)?;
    Lease::open(
        &db.1
            .join("sync-v2")
            .join(target)
            .join(format!("{install}-{}", state.instance)),
        &state.instance,
    )
}
fn docs(c: &Connection, target: &str) -> Result<Docs, String> {
    LIBRARY_DOMAINS
        .into_iter()
        .map(|d| outbox::confirmed(c, target, d).map(|doc| (d, doc)))
        .collect()
}
fn overlays(c: &Connection, target: &str) -> Result<Docs, String> {
    LIBRARY_DOMAINS
        .into_iter()
        .map(|d| outbox::overlay(c, target, d).map(|doc| (d, doc)))
        .collect()
}
pub(super) async fn heads(
    net: &Client<'_>,
    g: &Genesis,
    known: &BTreeMap<String, Head>,
) -> Result<BTreeMap<String, Head>, String> {
    let (names, _) = net.list(&format!("sync-v2/{}/control/", g.vault)).await?;
    let actors: BTreeSet<_> = names
        .into_iter()
        .filter(|n| uuid::Uuid::parse_str(n).is_ok())
        .collect();
    if known.keys().any(|a| !actors.contains(a)) {
        return Err("已确认的同步设备提交暂不可见，已保留本机数据".into());
    }
    let mut result = BTreeMap::new();
    for actor in actors {
        let old = known.get(&actor);
        if let Some(head) = protocol_v2::discover(
            net,
            &g.uid,
            &g.vault,
            &g.seed,
            &actor,
            old.map_or(0, |h| h.generation),
        )
        .await?
        {
            if old.is_some_and(|h| h.generation == head.generation && h != &head) {
                return Err("同步提交身份发生分叉".into());
            }
            if old.is_some_and(|h| {
                h.domains.iter().any(|(d, previous)| {
                    head.domains
                        .get(d)
                        .is_none_or(|next| next.self_seq < previous.self_seq)
                })
            }) {
                return Err("同步提交的数据域覆盖水位发生回退".into());
            }
            result.insert(actor, head);
        }
    }
    Ok(result)
}
pub(super) async fn receive_domain(
    net: &Client<'_>,
    mut doc: Document,
    heads: &BTreeMap<String, Head>,
    known: &BTreeMap<String, Head>,
) -> Result<Document, String> {
    let d = doc.scope.domain;
    let mut pending = Vec::new();
    for head in heads.values() {
        let Some(domain) = head
            .domains
            .get(&d)
            .filter(|v| known.get(&head.actor).and_then(|h| h.domains.get(&d)) != Some(*v))
        else {
            continue;
        };
        let plan = protocol_v2::load_receive(net, &doc, &head.actor, &domain.manifest_hash).await?;
        if plan.through != domain.self_seq {
            return Err("同步提交与清单覆盖水位不符".into());
        }
        doc.join(&plan.checkpoint)?;
        pending.extend(plan.batches);
    }
    // A writer's tail may depend on a PREFIX of another writer whose own later
    // operations depend back on it. Retain verified prefixes within this exchange;
    // commit nothing to SQLite unless every advertised tail is covered.
    while !pending.is_empty() {
        let before = pending.len();
        let mut remaining = Vec::new();
        for batch in pending {
            match doc.apply(&batch) {
                Ok(_) => {}
                Err(e) if e.contains("因果依赖尚未完整接收") => remaining.push(batch),
                Err(e) if e.contains("增量序列存在缺口") => remaining.push(batch),
                Err(e) => return Err(e),
            }
        }
        if remaining.len() == before {
            return Err("同步提交的因果依赖尚未完整可见，请稍后重试".into());
        }
        pending = remaining;
    }
    Ok(doc)
}

async fn read_anchor(net: &Client<'_>, g: &Genesis) -> Result<Snapshot, String> {
    let root = format!("sync-v2/{}/bootstrap/", g.vault);
    let (files, _) = net.list(&root).await?;
    let mut combined: Docs = LIBRARY_DOMAINS
        .into_iter()
        .map(|d| (d, Document::empty(g.scope(d))))
        .collect();
    let mut found = false;
    for name in files {
        let Some(hash) = name
            .strip_suffix(".json.gz")
            .filter(|s| causal::valid_hash(s))
        else {
            continue;
        };
        let obj = net
            .get(&format!("{root}{name}"))
            .await?
            .ok_or("迁移原始材料暂不可见")?;
        let input: Docs = protocol_v2::decode(
            &obj.body,
            &protocol_v2::ObjectRef {
                hash: hash.into(),
                bytes: obj.body.len() as u64,
                first_seq: 0,
                last_seq: 0,
            },
        )?;
        for (d, doc) in input {
            if !LIBRARY_DOMAINS.contains(&d) || doc.scope != g.scope(d) {
                return Err("迁移原始材料身份无效".into());
            }
            combined.get_mut(&d).unwrap().join(&doc)?;
        }
        found = true;
    }
    if !found {
        return Err("迁移原始材料暂不可见，请重试".into());
    }
    projection::snapshot(
        &combined[&Domain::Library],
        &combined[&Domain::Progress],
        true,
    )
}
fn fingerprint(state: &Runtime, current: &View, remote: &Docs) -> Result<String, String> {
    Ok(causal::hash(
        &serde_json::to_vec(&(
            &state.genesis,
            &state.anchor,
            &state.old_base,
            current,
            remote,
        ))
        .map_err(err)?,
    ))
}
fn conflict_value(cell: Option<&Cell>) -> Value {
    match cell {
        Some(Cell::Value(v)) => v.clone(),
        _ => Value::Null,
    }
}
fn causal_conflicts(doc: &Document, current: &View) -> Result<Vec<Conflict>, String> {
    let (_, keys) = doc.materialize()?;
    let mut result = Vec::new();
    for key in keys {
        let (entity, field): (String, String) = serde_json::from_str(&key).map_err(err)?;
        if entity.starts_with("favorite:") || field == "__order"
            || upgrade_merge::automatic_field(&field)
            || doc.scope.domain == Domain::Progress
        {
            continue;
        }
        let local = current.facts.get(&key);
        let reg = &doc.registers[&key];
        let remote = reg
            .values
            .iter()
            .find(|v| Some(&v.cell) != local)
            .or_else(|| reg.values.first());
        result.push(Conflict {
            key: entity,
            field,
            local: conflict_value(local),
            remote: conflict_value(remote.map(|v| &v.cell)),
        });
    }
    Ok(result)
}
fn existence(doc: &Document) -> Result<BTreeSet<String>, String> {
    let mut set = BTreeSet::new();
    for (key, reg) in &doc.registers {
        let (entity, field): (String, String) = serde_json::from_str(key).map_err(err)?;
        if field == "__present"
            && reg
                .values
                .iter()
                .any(|v| v.cell == Cell::Value(false.into()))
        {
            set.insert(entity);
        }
    }
    Ok(set)
}
fn relation_conflicts(doc: &Document) -> Result<Vec<Conflict>, String> {
    let rows = projection::rows(doc)?;
    let mut conflicts = vec![];
    for (entity, row) in &rows {
        let parent = if entity.starts_with("item:") {
            row.get("playlistId")
                .and_then(Value::as_str)
                .map(|v| format!("playlist:{v}"))
        } else if entity.starts_with("collection:") {
            row.get("folderId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|v| format!("collectionFolder:{v}"))
        } else {
            None
        };
        if let Some(parent) = parent.filter(|p| !rows.contains_key(p)) {
            conflicts.push(Conflict {
                key: entity.clone(),
                field: "__parent".into(),
                local: Value::String(parent),
                remote: Value::Null,
            });
        }
    }
    Ok(conflicts)
}
fn resolve(
    doc: &Document,
    current: &View,
    side: &str,
    selected: Option<&Facts>,
) -> Result<Facts, String> {
    let mut changes = Facts::new();
    for c in causal_conflicts(doc, current)? {
        let key = causal::key(&c.key, &c.field);
        let register = &doc.registers[&key];
        let own = current
            .facts
            .get(&key)
            .cloned()
            .unwrap_or(if c.field == "__present" {
                Cell::Value(false.into())
            } else {
                Cell::Missing
            });
        let chosen = if let Some(cell) = selected.and_then(|s| s.get(&key)) {
            cell.clone()
        } else if side == "local" {
            own.clone()
        } else if c.field == "__present" {
            Cell::Value((own != Cell::Value(true.into())).into())
        } else {
            register
                .values
                .iter()
                .find(|v| v.cell != own)
                .or_else(|| register.values.first())
                .map(|v| v.cell.clone())
                .unwrap_or(Cell::Missing)
        };
        changes.insert(key, chosen);
    }
    for c in relation_conflicts(doc)? {
        let keep = selected
            .and_then(|s| s.get(&causal::key(&c.key, &c.field)))
            .map_or(side == "local", |v| *v == Cell::Value(c.local.clone()));
        if keep {
            let parent = c.local.as_str().ok_or("恢复引用无效")?;
            let present = causal::key(parent, "__present");
            if !doc.registers.contains_key(&present) {
                return Err("缺少父记录恢复材料，请保留云端删除或从备份恢复".into());
            }
            changes.insert(present, Cell::Value(true.into()));
        } else {
            changes.insert(causal::key(&c.key, "__present"), Cell::Value(false.into()));
        }
    }
    let restored: Vec<String> = changes
        .iter()
        .filter_map(|(key, value)| {
            let (entity, field): (String, String) = serde_json::from_str(key).ok()?;
            (field == "__present" && value == &Cell::Value(true.into())).then_some(entity)
        })
        .collect();
    for entity in restored {
        let recovery = current.snapshot.records.get(&entity).cloned().or_else(|| {
            doc.registers
                .get(&causal::key(&entity, "__record"))?
                .values
                .iter()
                .find_map(|v| {
                    if let Cell::Value(value) = &v.cell {
                        serde_json::from_value::<super::model::Record>(value.clone()).ok()
                    } else {
                        None
                    }
                })
        });
        if let Some(record) = recovery {
            for (field, value) in record.fields {
                let key = causal::key(&entity, &field);
                if !changes.contains_key(&key)
                    && doc
                        .registers
                        .get(&key)
                        .is_none_or(|r| !r.values.iter().any(|v| matches!(v.cell, Cell::Value(_))))
                {
                    changes.insert(key, Cell::Value(value));
                }
            }
        }
    }
    Ok(changes)
}
fn enqueue(
    c: &Connection,
    target: &str,
    d: Domain,
    lease: &mut Lease,
    changes: Facts,
    context: Option<&BTreeMap<String, Register>>,
) -> Result<(), String> {
    if changes.is_empty() {
        return Ok(());
    }
    outbox::mutate_in_transaction(c, target, d, lease, context, |_| Ok(((), changes)))
}
fn capture_edits(
    c: &Connection,
    cfg: &Config,
    target: &str,
    state: &mut Runtime,
    lease: &mut Lease,
) -> Result<(), String> {
    if !state.joined {
        return Ok(());
    }
    let current = projection::capture(c, &cfg.uid, cfg.history)?;
    for d in LIBRARY_DOMAINS {
        if d == Domain::Progress && !cfg.history {
            continue;
        }
        let mut changes = projection::delta(&state.observed.facts, &current.facts, d)?;
        changes.retain(|key, value| {
            let Ok((entity, field)) = serde_json::from_str::<(String, String)>(key) else {
                return true;
            };
            // The top-200 query is a bounded local VIEW, not an explicit global
            // deletion. An offline device may have just played the aged-out song.
            if d == Domain::Progress
                && entity.starts_with("history:")
                && field == "__present"
                && value == &Cell::Value(false.into())
            {
                return false;
            }
            if d == Domain::Library && !current.snapshot.records.contains_key(&entity) {
                // Dropping the last LOCAL reference is not a global deletion of song
                // metadata: another device/domain can concurrently add a reference.
                // Unreferenced facts stay hidden by snapshot.compact. An explicit
                // lyric reset still deletes its selection when the track is visible.
                if entity.starts_with("track:") {
                    return false;
                }
                if let Some(id) = entity.strip_prefix("lyric:") {
                    return current
                        .snapshot
                        .records
                        .contains_key(&format!("track:{id}"));
                }
            }
            true
        });
        enqueue(c, target, d, lease, changes, state.contexts.get(&d))?;
        // Only locally assigned fields advance the displayed context before a successful receive.
        if let Some(batch) = outbox::pending(c, target, d)?.last() {
            let context = state.contexts.entry(d).or_default();
            for (key, reg) in &batch.registers {
                context.insert(key.clone(), reg.clone());
            }
        }
    }
    state.observed = current;
    put(c, target, "runtime", state)
}
async fn publish(
    db: &Database,
    cfg: &Config,
    target: &str,
    net: &Client<'_>,
    state: &mut Runtime,
    lease: &mut Lease,
) -> Result<(), String> {
    if state.bootstrap {
        let input: Docs = with(db, cfg, |c| {
            get(c, target, "anchor-docs")?.ok_or("迁移原始备份缺失".into())
        })?;
        let bytes = protocol_v2::encode(&input)?;
        let root = format!("sync-v2/{}/bootstrap/", state.genesis.vault);
        for path in [
            "sync-v2/".to_owned(),
            format!("sync-v2/{}/", state.genesis.vault),
            root.clone(),
        ] {
            net.mkdir(&path).await?;
        }
        let path = format!("{root}{}.json.gz", causal::hash(&bytes));
        net.put(&path, bytes.clone()).await?;
        if net.get(&path).await?.is_none_or(|o| o.body != bytes) {
            return Err("迁移原始备份尚未确认".into());
        }
    }
    if let Some(p) = with(db, cfg, |c| publication::pending(c, target, lease.actor()))? {
        p.publish(net).await?;
        with(db, cfg, |c| publication::acknowledge(c, target, &p))?;
    }
    for d in LIBRARY_DOMAINS {
        let plan = with(db, cfg, |c| {
            let head = publication::committed(c, target, lease.actor())?;
            let generation = head
                .as_ref()
                .map_or(0, |h| h.generation)
                .checked_add(1)
                .ok_or("提交代耗尽")?;
            let other = head.as_ref().map(|h| h.domains.clone()).unwrap_or_default();
            let confirmed = outbox::confirmed(c, target, d)?;
            let overlay = outbox::overlay(c, target, d)?;
            let queue = outbox::pending(c, target, d)?;
            let previous = publication::manifest(c, target, lease.actor(), d)?;
            let p = if !queue.is_empty() {
                protocol_v2::build(
                    &confirmed,
                    &overlay,
                    &queue,
                    previous.as_ref(),
                    lease.actor(),
                    generation,
                    other,
                )?
            } else if state.needs_seed.contains(&d)
                && head.as_ref().is_none_or(|h| !h.domains.contains_key(&d))
            {
                Some(protocol_v2::bootstrap_checkpoint(
                    &confirmed,
                    lease.actor(),
                    generation,
                    other,
                )?)
            } else {
                None
            };
            if let Some(p) = &p {
                publication::save(c, target, lease, p)?;
            }
            Ok(p)
        })?;
        if let Some(p) = plan {
            p.publish(net).await?;
            with(db, cfg, |c| publication::acknowledge(c, target, &p))?;
        }
        state.needs_seed.remove(&d);
        with(db, cfg, |c| put(c, target, "runtime", state))?;
    }
    if state.bootstrap {
        state.genesis.publish(net).await?;
        state.bootstrap = false;
        with(db, cfg, |c| put(c, target, "runtime", state))?;
    }
    Ok(())
}
fn outcome(view: &View, conflicts: Vec<Conflict>, changed: bool) -> Outcome {
    Outcome {
        skipped: false,
        conflicts,
        records: view.snapshot.records.len(),
        bytes: serde_json::to_vec(view).map_or(0, |v| v.len()),
        changed,
    }
}
/// Connection preview probes v2 first, and never creates a v1 file or v2 commit.
pub async fn probe(cfg: &Config, secret: &Secret) -> Result<(), String> {
    let net = Client::new(cfg, secret)?;
    let g = Genesis::for_config(cfg)?;
    let remote = heads(&net, &g, &BTreeMap::new()).await?;
    if !remote
        .values()
        .any(|h| h.domains.contains_key(&Domain::Library))
    {
        if g.exists(&net).await? {
            return Err("新版同步库提交暂不可见".into());
        }
        super::dav::read(cfg, secret).await?;
    }
    Ok(())
}
pub async fn sync(
    db: &Database,
    cfg: &Config,
    secret: &Secret,
    resolution: Option<&str>,
    preview: bool,
) -> Result<Outcome, String> {
    let target = storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    with(db, cfg, |c| bind_target(c, cfg, &target))?;
    let net = Client::cached(cfg, secret, db.1.join("sync-v2-cache").join(&target));
    let net = net?;
    let mut state: Option<Runtime> = with(db, cfg, |c| get(c, &target, "runtime"))?;
    let known: BTreeMap<String, Head> = with(db, cfg, |c| {
        Ok(get(c, &target, "heads")?.unwrap_or_default())
    })?;
    let g = Genesis::for_config(cfg)?;
    let mut lease_existing = if let Some(runtime) = state.as_mut() {
        Some(with(db, cfg, |c| {
            let tx = c.unchecked_transaction().map_err(err)?;
            let (lease, recovered) = super::recovery::ensure(
                c,
                &db.1,
                "sync-v2",
                &target,
                &mut runtime.instance,
                &LIBRARY_DOMAINS,
                &mut runtime.contexts,
            )?;
            if recovered {
                super::devices::init(c)?;
                c.execute("DELETE FROM sync_device_meta WHERE target=?1 AND key IN ('heartbeat','refreshed')", [&target]).map_err(err)?;
            }
            put(c, &target, "runtime", runtime)?;
            tx.commit().map_err(err)?;
            Ok(lease)
        })?)
    } else {
        None
    };
    if let (Some(runtime), Some(lease)) = (state.as_mut(), lease_existing.as_mut()) {
        if runtime.genesis != g {
            return Err("本机同步库身份不一致".into());
        }
        if !preview && runtime.joined {
            with(db, cfg, |c| {
                let tx = c.unchecked_transaction().map_err(err)?;
                capture_edits(c, cfg, &target, runtime, lease)?;
                tx.commit().map_err(err)
            })?;
            publish(db, cfg, &target, &net, runtime, lease).await?;
        }
    }
    let remote_heads = heads(&net, &g, &known).await?;
    if let Some(runtime) = &state {
        if runtime.joined && remote_heads.is_empty() {
            return Err("新版云端提交暂不可见，已保留本机数据".into());
        }
    }
    let mut remote = if state.is_some() {
        with(db, cfg, |c| docs(c, &target))?
    } else {
        LIBRARY_DOMAINS
            .into_iter()
            .map(|d| (d, Document::empty(g.scope(d))))
            .collect()
    };
    let has_library = remote_heads
        .values()
        .any(|h| h.domains.contains_key(&Domain::Library));
    if state.is_none() && !has_library {
        if g.exists(&net).await? {
            return Err("新版同步库数据暂不可见，请重试".into());
        }
        let legacy =
            super::dav::read_cached(cfg, secret, Some(&db.1.join("sync-cache").join(&target)))
                .await?;
        let dav = legacy.dav.as_ref().ok_or("旧同步因果数据缺失")?;
        for d in LIBRARY_DOMAINS {
            let mut doc = super::migration::import_legacy(&g, &dav.doc, d)?;
            if let Some(linked) = &dav.linked {
                doc.join(&super::migration::import_legacy(&g, &linked.doc, d)?)?;
            }
            remote.insert(d, doc);
        }
    } else {
        for d in LIBRARY_DOMAINS {
            remote.insert(
                d,
                receive_domain(&net, remote[&d].clone(), &remote_heads, &known).await?,
            );
        }
    }
    // The first local target record is a durable migration receipt/backup, not a cloud write.
    if state.is_none() {
        let current = with(db, cfg, |c| projection::capture(c, &cfg.uid, cfg.history))?;
        let anchor = if !has_library {
            projection::snapshot(&remote[&Domain::Library], &remote[&Domain::Progress], true)?
        } else {
            read_anchor(&net, &g).await?
        };
        let old_base = with(db, cfg, |c| {
            storage::bind_legacy(c, &cfg.provider, &target)?;
            c.query_row(
                "SELECT json FROM sync_target_base WHERE target=?1",
                [&target],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(|s| serde_json::from_str::<Snapshot>(&s).map_err(err))
            .transpose()
        })?;
        let runtime = Runtime {
            instance: uuid::Uuid::new_v4().to_string(),
            genesis: g.clone(),
            joined: false,
            bootstrap: !has_library,
            anchor,
            old_base,
            observed: current.clone(),
            contexts: BTreeMap::new(),
            needs_seed: if !has_library {
                LIBRARY_DOMAINS.into_iter().collect()
            } else {
                BTreeSet::new()
            },
        };
        let lease = lease(db, &target, &runtime)?;
        with(db, cfg, |c| {
            let tx = c.unchecked_transaction().map_err(err)?;
            for doc in remote.values() {
                outbox::initialize(c, &target, &lease, doc)?;
            }
            put(c, &target, "upgrade-backup", &current)?;
            if runtime.bootstrap {
                put(c, &target, "anchor-docs", &remote)?;
            }
            put(c, &target, "runtime", &runtime)?;
            tx.commit().map_err(err)
        })?;
        lease_existing = Some(lease);
        state = Some(runtime);
    }
    let mut state = state.unwrap();
    let mut lease = lease_existing.unwrap();
    with(db, cfg, |c| {
        let tx = c.unchecked_transaction().map_err(err)?;
        // Capture edits made during network IO against the last actually displayed field contexts.
        if !preview {
            capture_edits(c, cfg, &target, &mut state, &mut lease)?;
        }
        for doc in remote.values() {
            let mut confirmed = outbox::confirmed(c, &target, doc.scope.domain)?;
            confirmed.join(doc)?;
            c.execute(
                "UPDATE sync_v2_documents SET confirmed=?3 WHERE target=?1 AND domain=?2",
                params![
                    target,
                    doc.scope.domain.name(),
                    serde_json::to_string(&confirmed).map_err(err)?
                ],
            )
            .map_err(err)?;
        }
        put(c, &target, "heads", &remote_heads)?;
        tx.commit().map_err(err)
    })?;
    let current = with(db, cfg, |c| projection::capture(c, &cfg.uid, cfg.history))?;
    let mut all = with(db, cfg, |c| overlays(c, &target))?;
    let mut proof = fingerprint(&state, &current, &all)?;
    let envelope = resolution
        .filter(|s| !matches!(*s, "local" | "remote"))
        .map(serde_json::from_str::<Selected>)
        .transpose()
        .map_err(|_| "冲突选择格式无效")?;
    let previous_proof: Option<String> = with(db, cfg, |c| get(c, &target, "conflict-proof"))?;
    let choice = resolution.filter(|side| {
        matches!(*side, "local" | "remote") && previous_proof.as_deref() == Some(&proof)
    });
    let mut conflicts = causal_conflicts(&all[&Domain::Library], &current)?;
    conflicts.extend(relation_conflicts(&all[&Domain::Library])?);
    let had_causal_conflicts = !conflicts.is_empty();
    if !conflicts.is_empty() {
        let selections = with(db, cfg, |c| {
            selected(c, &target, &proof, envelope.as_ref(), &conflicts)
        })?;
        with(db, cfg, |c| {
            save_menu(c, &target, &proof, &current, &all, &conflicts)
        })?;
        if preview || (choice.is_none() && selections.is_none()) {
            return Ok(outcome(&current, conflicts, false));
        }
        let changes = resolve(
            &all[&Domain::Library],
            &current,
            choice.unwrap_or("remote"),
            selections.as_ref(),
        )?;
        with(db, cfg, |c| {
            let tx = c.unchecked_transaction().map_err(err)?;
            check_current(c, cfg, &current)?;
            enqueue(c, &target, Domain::Library, &mut lease, changes, None)?;
            tx.commit().map_err(err)
        })?;
        all = with(db, cfg, |c| overlays(c, &target))?;
        proof = fingerprint(&state, &current, &all)?;
    }
    if !state.joined {
        let snapshot =
            projection::snapshot(&all[&Domain::Library], &all[&Domain::Progress], cfg.history)?;
        let mut anchor = state.anchor.clone();
        let mut previous = state.old_base.clone();
        if !cfg.history {
            anchor.compact(false);
            if let Some(b) = &mut previous {
                b.compact(false);
            }
        }
        let deleted = existence(&all[&Domain::Library])?;
        let p = upgrade_merge::prepare_automatic(
            &g.scope(Domain::Library),
            &anchor,
            previous.as_ref(),
            &current.snapshot,
            &snapshot,
            &deleted,
            None,
        )?;
        let join_choice = if had_causal_conflicts { None } else { choice };
        let conflicts: Vec<_> = p
            .conflicts()
            .iter()
            .map(|c| Conflict {
                key: c.entity.clone(),
                field: c.field.clone(),
                local: conflict_value(Some(&c.local)),
                remote: conflict_value(Some(&c.remote)),
            })
            .collect();
        let selections = if had_causal_conflicts {
            None
        } else {
            with(db, cfg, |c| {
                selected(c, &target, &proof, envelope.as_ref(), &conflicts)
            })?
        };
        with(db, cfg, |c| {
            save_menu(c, &target, &proof, &current, &all, &conflicts)
        })?;
        if preview || (!conflicts.is_empty() && join_choice.is_none() && selections.is_none()) {
            return Ok(outcome(&current, conflicts, false));
        }
        let decisions = if join_choice.is_some() || selections.is_some() {
            Some(
                p.decisions(
                    p.conflicts()
                        .iter()
                        .map(|c| {
                            let side = selections
                                .as_ref()
                                .and_then(|s| s.get(&c.id))
                                .map_or(join_choice == Some("local"), |v| *v == c.local);
                            (
                                c.id.clone(),
                                if side {
                                    upgrade_merge::Choice::Local
                                } else {
                                    upgrade_merge::Choice::Remote
                                },
                            )
                        })
                        .collect(),
                ),
            )
        } else {
            None
        };
        let plan = upgrade_merge::prepare_automatic(
            &g.scope(Domain::Library),
            &anchor,
            previous.as_ref(),
            &current.snapshot,
            &snapshot,
            &deleted,
            decisions.as_ref(),
        )?;
        let remote_rows = projection::rows(&all[&Domain::Library])?;
        let mut extra = Facts::new();
        for (key, value) in &current.facts {
            let (entity, field): (String, String) = serde_json::from_str(key).map_err(err)?;
            if field != "creatorNote" && field != "__order" {
                continue;
            }
            if !plan.merged().records.contains_key(&entity) {
                continue;
            }
            let remote_value = remote_rows
                .get(&entity)
                .and_then(|r| r.get(&field))
                .cloned()
                .map(Cell::Value);
            if remote_value.as_ref() == Some(value) {
                continue;
            }
            let take_local = selections
                .as_ref()
                .and_then(|s| s.get(key))
                .map_or(join_choice == Some("local"), |v| v == value);
            if remote_value.is_none() || take_local {
                extra.insert(key.clone(), value.clone());
            }
        }
        let changes = plan.changes()?;
        with(db, cfg, |c| {
            let tx = c.unchecked_transaction().map_err(err)?;
            check_current(c, cfg, &current)?;
            for d in LIBRARY_DOMAINS {
                let filtered = changes
                    .iter()
                    .filter_map(|(k, v)| {
                        let (e, _): (String, String) = serde_json::from_str(k).ok()?;
                        (projection::domain_of(e.split(':').next().unwrap_or_default()) == d)
                            .then_some((k.clone(), v.clone()))
                    })
                    .collect();
                enqueue(c, &target, d, &mut lease, filtered, None)?;
            }
            enqueue(c, &target, Domain::Library, &mut lease, extra, None)?;
            put(c, &target, "runtime", &state)?;
            tx.commit().map_err(err)
        })?;
        all = with(db, cfg, |c| overlays(c, &target))?;
    } else if preview {
        return Ok(outcome(&current, vec![], false));
    }
    #[cfg(test)]
    let _ = BEFORE_PROJECT.try_with(|hook| hook(db));
    let after = with(db, cfg, |c| {
        let tx = c.unchecked_transaction().map_err(err)?;
        check_current(c, cfg, &current)?;
        let after = projection::apply(
            c,
            &all[&Domain::Library],
            &all[&Domain::Progress],
            cfg.history,
        )?;
        state.joined = true;
        state.observed = after.clone();
        state.contexts = all
            .iter()
            .map(|(d, doc)| (*d, doc.registers.clone()))
            .collect();
        put(c, &target, "runtime", &state)?;
        let mut saved = super::config_from_connection(c)?.unwrap_or_else(|| cfg.clone());
        saved.initialized = true;
        saved.device_id = lease.actor().into();
        c.execute("INSERT INTO sync_settings(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json",[serde_json::to_string(&saved).map_err(err)?]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(after)
    })?;
    net.parents().await?;
    publish(db, cfg, &target, &net, &mut state, &mut lease).await?;
    with(db, cfg, |c| {
        c.execute("INSERT INTO sync_info(key,value) VALUES(?1,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[format!("last_success:{target}")]).map_err(err)?;
        Ok(())
    })?;
    Ok(outcome(&after, vec![], after != current))
}

#[cfg(test)]
mod tests {
    use super::*;
    const LIST: &str = "00000000-0000-4000-8000-000000000001";
    fn device(cfg: &Config) -> Database {
        let dir = std::env::temp_dir().join(format!("v2-executor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("active-profile"), &cfg.uid).unwrap();
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute(
            "INSERT INTO sync_settings VALUES(1,?1)",
            [serde_json::to_string(cfg).unwrap()],
        )
        .unwrap();
        Database(std::sync::Mutex::new(c), dir)
    }
    fn change(db: &Database, sql: &str) {
        db.0.lock().unwrap().execute_batch(sql).unwrap();
    }
    async fn run(db: &Database, cfg: &Config, secret: &Secret) -> Outcome {
        sync(db, cfg, secret, None, false).await.unwrap()
    }
    fn value(db: &Database, column: &str) -> String {
        db.0.lock()
            .unwrap()
            .query_row(
                &format!("SELECT {column} FROM playlists WHERE id=?1"),
                [LIST],
                |r| r.get(0),
            )
            .unwrap()
    }
    #[tokio::test]
    async fn favorites_join_add_wins_and_later_unlike_propagates_without_prompts() {
        let (cfg,secret,_store,server)=super::super::test_dav::server().await;
        let a=device(&cfg);let b=device(&cfg);
        for db in [&a,&b] {change(db,"INSERT INTO source_items(id,provider,bvid,cid) VALUES('bilibili:BV123:1','bilibili','BV123',1);INSERT INTO tracks(id,source_item_id,title) VALUES('bilibili:BV123:1','bilibili:BV123:1','song');INSERT INTO favorites(track_id) VALUES('bilibili:BV123:1');");}
        run(&a,&cfg,&secret).await;run(&b,&cfg,&secret).await;
        change(&a,"DELETE FROM favorites");run(&a,&cfg,&secret).await;
        // Upgrading an old local database with a like must not require a choice.
        let c=device(&cfg);change(&c,"INSERT INTO source_items(id,provider,bvid,cid) VALUES('bilibili:BV123:1','bilibili','BV123',1);INSERT INTO tracks(id,source_item_id,title) VALUES('bilibili:BV123:1','bilibili:BV123:1','song');INSERT INTO favorites(track_id) VALUES('bilibili:BV123:1');");
        for db in [&c,&a,&b] {assert!(run(db,&cfg,&secret).await.conflicts.is_empty());}
        let count=|db:&Database|db.0.lock().unwrap().query_row("SELECT COUNT(*) FROM favorites",[],|r|r.get::<_,i64>(0)).unwrap();
        assert_eq!(count(&a),1);assert_eq!(count(&b),1);
        // A normal cancellation AFTER seeing the like still removes it everywhere.
        change(&b,"DELETE FROM favorites");
        for db in [&b,&a,&c] {assert!(run(db,&cfg,&secret).await.conflicts.is_empty());assert_eq!(count(db),0);}
        server.abort();for db in [&a,&b,&c] {std::fs::remove_dir_all(&db.1).unwrap();}
    }
    #[tokio::test]
    async fn large_library_sort_preferences_are_sparse_and_concurrent_changes_converge() {
        use crate::interface::list_preferences::{self,Preference};
        let (cfg,secret,_store,server)=super::super::test_dav::server().await;
        let a=device(&cfg);let b=device(&cfg);
        {
            let c=a.0.lock().unwrap();let tx=c.unchecked_transaction().unwrap();
            for list in 0..15 {c.execute("INSERT INTO playlists(id,name) VALUES(?1,?2)",params![format!("00000000-0000-4000-8000-{list:012}"),format!("List {list}")]).unwrap();}
            for cid in 1..=500 {
                let id=format!("bilibili:BVsort{cid}:{cid}");
                c.execute("INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili',?2,?3)",params![id,format!("BVsort{cid}"),cid]).unwrap();
                c.execute("INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'song')",[&id]).unwrap();
                for list in 0..15 {c.execute("INSERT INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,?3)",params![format!("00000000-0000-4000-8000-{list:012}"),id,cid]).unwrap();}
            }tx.commit().unwrap();
        }
        run(&a,&cfg,&secret).await;run(&b,&cfg,&secret).await;
        let entity="playlist:00000000-0000-4000-8000-000000000000";
        let before=with(&a,&cfg,|c|projection::capture(c,&cfg.uid,false)).unwrap();
        list_preferences::save(&a.0.lock().unwrap(),&[Preference{entity:entity.into(),display_rank:Some("10000000000000000000".into()),sort_rule:Some("name:asc".into())}]).unwrap();
        let after=with(&a,&cfg,|c|projection::capture(c,&cfg.uid,false)).unwrap();
        let edits=after.facts.iter().filter(|(k,v)|before.facts.get(*k)!=Some(*v)).collect::<Vec<_>>();
        assert_eq!(edits.len(),2);assert!(edits.iter().all(|(key,_)|!key.contains("position")));
        let (outcome,usage)=super::super::traffic::capture(run(&a,&cfg,&secret)).await;
        assert!(outcome.conflicts.is_empty());
        assert!(usage.uploaded_bytes<32_000,"one sort change uploaded {} bytes",usage.uploaded_bytes);
        eprintln!("15 playlists × 500 items: sort change uploaded {} bytes",usage.uploaded_bytes);
        list_preferences::save(&b.0.lock().unwrap(),&[Preference{entity:entity.into(),display_rank:None,sort_rule:Some("date:desc".into())}]).unwrap();
        for d in [&b,&a,&b,&a] {assert!(run(d,&cfg,&secret).await.conflicts.is_empty());}
        let read=|d:&Database|d.0.lock().unwrap().query_row("SELECT sort_rule FROM list_preferences WHERE entity=?1",[entity],|r|r.get::<_,String>(0)).unwrap();
        assert_eq!(read(&a),read(&b));
        for d in [&a,&b] {assert_eq!(d.0.lock().unwrap().query_row("SELECT COUNT(*) FROM playlist_items WHERE position BETWEEN 1 AND 500",[],|r|r.get::<_,i64>(0)).unwrap(),7500);}
        server.abort();std::fs::remove_dir_all(a.1).unwrap();std::fs::remove_dir_all(b.1).unwrap();
    }
    #[tokio::test]
    async fn real_executor_bootstraps_joins_and_merges_offline_fields_without_upload_echo() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"),
        );
        assert!(run(&a, &cfg, &secret).await.conflicts.is_empty());
        assert!(run(&b, &cfg, &secret).await.conflicts.is_empty());
        assert_eq!(value(&b, "name"), "initial");
        change(&a, "UPDATE playlists SET name='A name'");
        change(&b, "UPDATE playlists SET description='B description'");
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        run(&a, &cfg, &secret).await;
        assert_eq!(value(&a, "description"), "B description");
        assert_eq!(value(&b, "name"), "A name");
        let before = store.lock().unwrap().files.len();
        run(&b, &cfg, &secret).await;
        run(&a, &cfg, &secret).await;
        assert_eq!(store.lock().unwrap().files.len(), before);
        server.abort();
        std::fs::remove_dir_all(a.1).unwrap();
        std::fs::remove_dir_all(b.1).unwrap();
    }
    #[tokio::test]
    async fn real_executor_auto_merges_small_edits_but_confirms_delete_vs_edit() {
        let (cfg, secret, _, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"),
        );
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        change(&a, "UPDATE playlists SET name='A choice'");
        change(&b, "UPDATE playlists SET name='B choice'");
        run(&a, &cfg, &secret).await;
        assert!(run(&b, &cfg, &secret).await.conflicts.is_empty());
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        assert_eq!(value(&a, "name"), value(&b, "name"));
        assert!(["A choice", "B choice"].contains(&value(&a, "name").as_str()));
        // Ordinary offline edits must also expose delete-vs-edit, even without a new presence=true.
        change(&a, "DELETE FROM playlists");
        change(&b, "UPDATE playlists SET name='edited while offline'");
        run(&a, &cfg, &secret).await;
        assert!(
            run(&b, &cfg, &secret)
                .await
                .conflicts
                .iter()
                .any(|c| c.field == "__present")
        );
        assert!(
            sync(&b, &cfg, &secret, Some("local"), false)
                .await
                .unwrap()
                .conflicts
                .is_empty()
        );
        run(&a, &cfg, &secret).await;
        assert_eq!(value(&a, "name"), "edited while offline");
        server.abort();
        std::fs::remove_dir_all(a.1).unwrap();
        std::fs::remove_dir_all(b.1).unwrap();
    }
    fn target(cfg: &Config, secret: &Secret) -> String {
        storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username).unwrap()
    }
    fn menu(db: &Database, cfg: &Config, secret: &Secret) -> ConflictMenu {
        get(&db.0.lock().unwrap(), &target(cfg, secret), "conflict-menu")
            .unwrap()
            .unwrap()
    }
    fn all_local(menu: &ConflictMenu) -> String {
        serde_json::to_string(&Selected {
            token: menu.token.clone(),
            choices: menu
                .options
                .iter()
                .map(|(k, v)| (k.clone(), v[0].cell.clone()))
                .collect(),
        })
        .unwrap()
    }
    fn copy_database(from: &Database, cfg: &Config) -> Database {
        let copy = device(cfg);
        let path = copy.1.join("copied.sqlite");
        from.0
            .lock()
            .unwrap()
            .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        *copy.0.lock().unwrap() = Connection::open(path).unwrap();
        copy
    }
    #[tokio::test]
    async fn three_concurrent_metadata_candidates_converge_automatically_and_remain_archived() {
        let (cfg, secret, _, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let c = device(&cfg);
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"),
        );
        for d in [&a, &b, &c] {
            run(d, &cfg, &secret).await;
        }
        change(
            &a,
            "UPDATE playlists SET name='A',description='A description'",
        );
        change(
            &b,
            "UPDATE playlists SET name='B',description='B description'",
        );
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        change(
            &c,
            "UPDATE playlists SET name='C',description='C description'",
        );
        for d in [&c, &b, &a, &c, &b] {
            assert!(run(d, &cfg, &secret).await.conflicts.is_empty());
        }
        for d in [&a, &b, &c] {
            assert_eq!(value(d, "name"), value(&a, "name"));
            assert_eq!(value(d, "description"), value(&a, "description"));
        }
        // All concurrent source candidates stay recoverable in the causal archive.
        let docs = with(&a, &cfg, |conn| overlays(conn, &target(&cfg, &secret))).unwrap();
        let reg =
            &docs[&Domain::Library].registers[&causal::key(&format!("playlist:{LIST}"), "name")];
        assert_eq!(reg.values.len(), 3);
        for d in [a, b, c] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn upgrading_old_synced_data_is_not_skipped_and_joined_devices_never_read_v1() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let old = device(&cfg);
        let first = device(&cfg);
        change(
            &old,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','legacy initial')"),
        );
        let initial = storage::export(&old.0.lock().unwrap(), &cfg.uid, false).unwrap();
        let mut legacy = super::super::dav::Doc::empty(&cfg.uid);
        let writer = uuid::Uuid::new_v4().to_string();
        legacy.update(&writer, &initial).unwrap();
        let path = format!("/dav/BiliMusic-sync-v1/42/{writer}.json");
        store.lock().unwrap().files.insert(
            path.clone(),
            (serde_json::to_vec(&legacy).unwrap(), 1_700_000_000),
        );
        run(&first, &cfg, &secret).await;
        assert_eq!(value(&first, "name"), "legacy initial");
        // Old client changed AND successfully synced to v1 after v2 bootstrap.
        change(&old, "UPDATE playlists SET name='old late edit'");
        let late = storage::export(&old.0.lock().unwrap(), &cfg.uid, false).unwrap();
        legacy.update(&writer, &late).unwrap();
        store
            .lock()
            .unwrap()
            .files
            .insert(path, (serde_json::to_vec(&legacy).unwrap(), 1_700_000_001));
        old.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO sync_target_base VALUES(?1,?2)",
                params![target(&cfg, &secret), serde_json::to_string(&late).unwrap()],
            )
            .unwrap();
        store.lock().unwrap().requests.clear();
        assert!(run(&old, &cfg, &secret).await.conflicts.is_empty());
        run(&first, &cfg, &secret).await;
        assert_eq!(value(&first, "name"), "legacy initial");
        // The known cloud value wins an ambiguous legacy edit, with no dialog.
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(_, p)| p.contains("/sync-v2/")
                    || p.ends_with("/42/")
                    || p.ends_with("/BiliMusic-sync-v1/"))
        );
        for d in [old, first] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn copied_database_and_lost_reply_rotate_writer_and_preserve_pending_intentions() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"),
        );
        run(&a, &cfg, &secret).await;
        change(&a, "UPDATE playlists SET name='pending'");
        store.lock().unwrap().fail_head_once = true;
        assert!(sync(&a, &cfg, &secret, None, false).await.is_err());
        let b = copy_database(&a, &cfg);
        let old: Runtime = get(&a.0.lock().unwrap(), &target(&cfg, &secret), "runtime")
            .unwrap()
            .unwrap();
        let old_actor = lease(&a, &target(&cfg, &secret), &old)
            .unwrap()
            .actor()
            .to_owned();
        change(&b, "UPDATE playlists SET description='copied device'");
        assert!(run(&b, &cfg, &secret).await.conflicts.is_empty());
        run(&a, &cfg, &secret).await;
        assert_eq!(value(&a, "name"), "pending");
        assert_eq!(value(&a, "description"), "copied device");
        let new: Runtime = get(&b.0.lock().unwrap(), &target(&cfg, &secret), "runtime")
            .unwrap()
            .unwrap();
        assert_ne!(
            old_actor,
            lease(&b, &target(&cfg, &secret), &new).unwrap().actor()
        );
        // External watermark survives database rollback; the original also rotates safely.
        let snapshot = a.1.join("before-rollback.sqlite");
        a.0.lock()
            .unwrap()
            .execute("VACUUM INTO ?1", [snapshot.to_str().unwrap()])
            .unwrap();
        change(&a, "UPDATE playlists SET description='after snapshot'");
        run(&a, &cfg, &secret).await;
        *a.0.lock().unwrap() = Connection::open(&snapshot).unwrap();
        assert!(run(&a, &cfg, &secret).await.conflicts.is_empty());
        assert_eq!(value(&a, "description"), "after snapshot");
        for d in [a, b] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn concurrent_bootstrap_uses_one_vault_and_preserves_both_initial_libraries() {
        let (cfg, secret, _, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','one')"),
        );
        change(
            &b,
            "INSERT INTO playlists(id,name) VALUES('00000000-0000-4000-8000-000000000002','two')",
        );
        // Freeze both bootstrap receipts before either writer publishes.
        assert!(
            sync(&a, &cfg, &secret, None, true)
                .await
                .unwrap()
                .conflicts
                .is_empty()
        );
        assert!(
            sync(&b, &cfg, &secret, None, true)
                .await
                .unwrap()
                .conflicts
                .is_empty()
        );
        let (ra, rb) = tokio::join!(
            sync(&a, &cfg, &secret, None, false),
            sync(&b, &cfg, &secret, None, false)
        );
        assert!(ra.unwrap().conflicts.is_empty());
        assert!(rb.unwrap().conflicts.is_empty());
        for d in [&a, &b] {
            run(d, &cfg, &secret).await;
            assert_eq!(
                d.0.lock()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                2
            );
        }
        for d in [a, b] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn history_scope_toggle_is_not_a_remote_delete_and_corrupt_objects_never_replace_sql() {
        let (mut cfg, secret, store, server) = super::super::test_dav::server().await;
        cfg.history = true;
        let a = device(&cfg);
        let b = device(&cfg);
        change(
            &a,
            "INSERT INTO source_items(id,provider,bvid,cid) VALUES('bilibili:BV123:1','bilibili','BV123',1); INSERT INTO tracks(id,source_item_id,title) VALUES('bilibili:BV123:1','bilibili:BV123:1','Track'); INSERT INTO play_history(track_id) VALUES('bilibili:BV123:1'); INSERT INTO playback_positions(track_id,seconds,observed_at) VALUES('bilibili:BV123:1',20,200);",
        );
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        let mut disabled = cfg.clone();
        disabled.history = false;
        run(&a, &disabled, &secret).await;
        run(&b, &cfg, &secret).await;
        assert_eq!(
            b.0.lock()
                .unwrap()
                .query_row("SELECT seconds FROM playback_positions", [], |r| r
                    .get::<_, f64>(0))
                .unwrap(),
            20.0
        );
        run(&a, &cfg, &secret).await;
        // A new cold client must not commit even a partially validated incoming library.
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','remote')"),
        );
        run(&a, &cfg, &secret).await;
        let cold = device(&cfg);
        change(
            &cold,
            "INSERT INTO playlists(id,name) VALUES('00000000-0000-4000-8000-000000000002','local retained')",
        );
        let object = store
            .lock()
            .unwrap()
            .files
            .keys()
            .find(|p| p.contains("/objects/") && p.ends_with(".json.gz"))
            .unwrap()
            .clone();
        store.lock().unwrap().files.get_mut(&object).unwrap().0 = b"corrupted".to_vec();
        assert!(sync(&cold, &cfg, &secret, None, false).await.is_err());
        assert_eq!(
            cold.0
                .lock()
                .unwrap()
                .query_row("SELECT name FROM playlists", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "local retained"
        );
        for d in [a, b, cold] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn orphan_member_edit_requires_parent_recovery_instead_of_silent_loss() {
        let (cfg, secret, _, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','parent')"),
        );
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        change(&a, "DELETE FROM playlists");
        change(
            &b,
            &format!(
                "INSERT INTO source_items(id,provider,bvid,cid) VALUES('bilibili:BV123:1','bilibili','BV123',1); INSERT INTO tracks(id,source_item_id,title) VALUES('bilibili:BV123:1','bilibili:BV123:1','Track'); INSERT INTO playlist_items(playlist_id,track_id,position) VALUES('{LIST}','bilibili:BV123:1',0)"
            ),
        );
        run(&a, &cfg, &secret).await;
        let outcome = run(&b, &cfg, &secret).await;
        assert!(outcome.conflicts.iter().any(|c| c.field == "__parent"));
        let choice = all_local(&menu(&b, &cfg, &secret));
        assert!(
            sync(&b, &cfg, &secret, Some(&choice), false)
                .await
                .unwrap()
                .conflicts
                .is_empty()
        );
        run(&a, &cfg, &secret).await;
        for d in [&a, &b] {
            assert_eq!(value(d, "name"), "parent");
            assert_eq!(
                d.0.lock()
                    .unwrap()
                    .query_row("SELECT COUNT(*) FROM playlist_items", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        for d in [a, b] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn repeated_edits_bound_head_markers_and_skip_confirmed_directory_creation() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        change(
            &a,
            &format!("INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"),
        );
        run(&a, &cfg, &secret).await;
        store.lock().unwrap().requests.clear();
        for i in 0..34 {
            change(
                &a,
                &format!("UPDATE playlists SET description='change {i}'"),
            );
            assert!(run(&a, &cfg, &secret).await.conflicts.is_empty());
        }
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(method, _)| method != "MKCOL")
        );
        let marker_count = store
            .lock()
            .unwrap()
            .files
            .keys()
            .filter(|p| p.contains("/control/"))
            .count();
        assert!(marker_count < 24, "obsolete marker count: {marker_count}");
        let b = device(&cfg);
        assert!(run(&b, &cfg, &secret).await.conflicts.is_empty());
        assert_eq!(value(&b, "description"), "change 33");
        // A server-side directory removal invalidates cached mkdir confirmations on 409.
        store
            .lock()
            .unwrap()
            .dirs
            .retain(|d| !d.contains("/objects/"));
        change(&a, "UPDATE playlists SET description='directory recovery'");
        assert!(run(&a, &cfg, &secret).await.conflicts.is_empty());
        for d in [a, b] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn notes_and_order_are_replicated_without_received_echo_or_history_side_effects() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        change(
            &a,
            &format!(
                "INSERT INTO collection_folders(id,name,scope) VALUES('{LIST}','UP','creators'); INSERT INTO collections(bvid,folder_id) VALUES('up:123','{LIST}'); INSERT INTO creator_notes VALUES('up:123','original'); INSERT INTO playlists(id,name,created_at) VALUES('{LIST}','older','2025-01-01 00:00:00'); INSERT INTO playlists(id,name,created_at) VALUES('00000000-0000-4000-8000-000000000002','newer','2026-01-01 00:00:00')"
            ),
        );
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        change(&a, "UPDATE creator_notes SET note='changed note'");
        change(&b, "UPDATE collection_folders SET name='B folder'");
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        run(&a, &cfg, &secret).await;
        let order = |db: &Database| {
            let c = db.0.lock().unwrap();
            let mut q = c
                .prepare("SELECT id FROM playlists ORDER BY created_at DESC,rowid DESC")
                .unwrap();
            q.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(order(&a), order(&b));
        assert!(order(&a)[0].ends_with("0002"));
        for d in [&a, &b] {
            assert_eq!(
                d.0.lock()
                    .unwrap()
                    .query_row("SELECT note FROM creator_notes", [], |r| r
                        .get::<_, String>(0))
                    .unwrap(),
                "changed note"
            );
            assert_eq!(
                d.0.lock()
                    .unwrap()
                    .query_row("SELECT name FROM collection_folders", [], |r| r
                        .get::<_, String>(0))
                    .unwrap(),
                "B folder"
            );
        }
        change(&a, "UPDATE creator_notes SET note=''");
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        assert_eq!(
            b.0.lock()
                .unwrap()
                .query_row("SELECT note FROM creator_notes", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            ""
        );
        store.lock().unwrap().requests.clear();
        run(&a, &cfg, &secret).await;
        run(&b, &cfg, &secret).await;
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(m, _)| m != "PUT")
        );
        for d in [a, b] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
}
