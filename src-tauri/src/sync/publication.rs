//! Durable immutable upload plans. Lost replies replay the same generation and exact bytes.
use super::{
    actor::Lease,
    causal::{Domain, hash},
    outbox,
    protocol_v2::{Head, Manifest, Publication},
};
use rusqlite::{Connection, OptionalExtension, params};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn domain(d: Domain) -> &'static str {
    match d {
        Domain::Library => "library",
        Domain::Progress => "progress",
        Domain::Statistics => "statistics",
    }
}
pub fn init(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS sync_v2_publications(target TEXT NOT NULL,actor TEXT NOT NULL,generation INTEGER NOT NULL,committed_head TEXT,pending TEXT,PRIMARY KEY(target,actor));
    CREATE TABLE IF NOT EXISTS sync_v2_manifests(target TEXT NOT NULL,actor TEXT NOT NULL,domain TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(target,actor,domain));").map_err(err)
}
fn validate(p: &Publication) -> Result<(), String> {
    p.head.filename()?;
    p.manifest.validate()?;
    if p.manifest.actor != p.head.actor
        || p.manifest.scope.uid != p.head.uid
        || p.manifest.scope.vault != p.head.vault
        || p.manifest.scope.seed != p.head.seed
        || p.manifest.last_seq() != p.through
        || p.last_batch_hash
            .as_ref()
            .is_some_and(|h| !super::causal::valid_hash(h))
        || (p.last_batch_hash.is_none() && (p.through != 0 || !p.manifest.tail.is_empty()))
    {
        return Err("发布计划身份不一致".into());
    }
    let manifest_hash = hash(&serde_json::to_vec(&p.manifest).map_err(err)?);
    if p.head
        .domains
        .get(&p.manifest.scope.domain)
        .is_none_or(|h| h.self_seq != p.through || h.manifest_hash != manifest_hash)
    {
        return Err("发布计划清单不一致".into());
    }
    let base = format!("sync-v2/{}/", p.head.vault);
    for (path, bytes) in &p.objects {
        if !super::v2_net::valid_path(path)
            || !path.starts_with(&base)
            || bytes.len() > 12 * 1024 * 1024
        {
            return Err("发布计划对象路径或大小无效".into());
        }
        let digest = path
            .rsplit('/')
            .next()
            .unwrap()
            .trim_end_matches(".gz")
            .trim_end_matches(".json");
        if hash(bytes) != digest {
            return Err("发布计划对象摘要不符".into());
        }
    }
    Ok(())
}
pub fn pending(c: &Connection, target: &str, actor: &str) -> Result<Option<Publication>, String> {
    init(c)?;
    let raw: Option<String> = c
        .query_row(
            "SELECT pending FROM sync_v2_publications WHERE target=?1 AND actor=?2",
            params![target, actor],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .flatten();
    raw.map(|s| {
        let p: Publication = serde_json::from_str(&s).map_err(err)?;
        validate(&p)?;
        Ok(p)
    })
    .transpose()
}
pub fn committed(c: &Connection, target: &str, actor: &str) -> Result<Option<Head>, String> {
    init(c)?;
    let raw: Option<String> = c
        .query_row(
            "SELECT committed_head FROM sync_v2_publications WHERE target=?1 AND actor=?2",
            params![target, actor],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .flatten();
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}
pub fn manifest(
    c: &Connection,
    target: &str,
    actor: &str,
    d: Domain,
) -> Result<Option<Manifest>, String> {
    init(c)?;
    let raw: Option<String> = c
        .query_row(
            "SELECT json FROM sync_v2_manifests WHERE target=?1 AND actor=?2 AND domain=?3",
            params![target, actor, domain(d)],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}
pub fn save(
    c: &Connection,
    target: &str,
    lease: &mut Lease,
    p: &Publication,
) -> Result<(), String> {
    init(c)?;
    validate(p)?;
    if lease.actor() != p.head.actor {
        return Err("不能保存其他安装的发布计划".into());
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    if let Some(old) = pending(c, target, lease.actor())? {
        if serde_json::to_vec(&old).map_err(err)? == serde_json::to_vec(p).map_err(err)? {
            return tx.commit().map_err(err);
        }
        return Err("上次发布尚未确认，必须先重放原计划".into());
    }
    let generation: u64 = c
        .query_row(
            "SELECT generation FROM sync_v2_publications WHERE target=?1 AND actor=?2",
            params![target, lease.actor()],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .unwrap_or(0);
    if p.head.generation != generation.checked_add(1).ok_or("提交代耗尽")? {
        return Err("发布代不连续".into());
    }
    if let Some(old) = committed(c, target, lease.actor())? {
        if old.uid != p.head.uid || old.vault != p.head.vault || old.seed != p.head.seed {
            return Err("发布计划跨越了同步库".into());
        }
        for (d, h) in old.domains {
            if d != p.manifest.scope.domain && p.head.domains.get(&d) != Some(&h) {
                return Err("发布计划丢失另一数据域的提交".into());
            }
        }
    }
    lease.reserve("head", generation, p.head.generation)?;
    c.execute("INSERT INTO sync_v2_publications(target,actor,generation,pending) VALUES(?1,?2,?3,?4) ON CONFLICT(target,actor) DO UPDATE SET generation=excluded.generation,pending=excluded.pending",params![target,p.head.actor,p.head.generation,serde_json::to_string(p).map_err(err)?]).map_err(err)?;
    tx.commit().map_err(err)
}
/// Call only after the exact immutable remote head was read back and verified.
pub fn acknowledge(c: &Connection, target: &str, p: &Publication) -> Result<(), String> {
    init(c)?;
    let tx = c.unchecked_transaction().map_err(err)?;
    let Some(saved) = pending(c, target, &p.head.actor)? else {
        if committed(c, target, &p.head.actor)? == Some(p.head.clone()) {
            return tx.commit().map_err(err);
        }
        return Err("发布计划不存在或已被更新".into());
    };
    if serde_json::to_vec(&saved).map_err(err)? != serde_json::to_vec(p).map_err(err)? {
        return Err("发布确认与冻结计划不同".into());
    }
    if let Some(hash) = &p.last_batch_hash {
        outbox::acknowledge_in_transaction(c, target, p.manifest.scope.domain, p.through, hash)?;
    }
    c.execute("UPDATE sync_v2_publications SET pending=NULL,committed_head=?3 WHERE target=?1 AND actor=?2",params![target,p.head.actor,serde_json::to_string(&p.head).map_err(err)?]).map_err(err)?;
    c.execute("INSERT INTO sync_v2_manifests VALUES(?1,?2,?3,?4) ON CONFLICT(target,actor,domain) DO UPDATE SET json=excluded.json",params![target,p.head.actor,domain(p.manifest.scope.domain),serde_json::to_string(&p.manifest).map_err(err)?]).map_err(err)?;
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::super::{
        causal::{Cell, Document, Scope, key},
        protocol_v2,
    };
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    #[test]
    fn bootstrap_ack_never_consumes_edits_created_during_upload() {
        let c = Connection::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut lease = Lease::open(&dir, &uuid::Uuid::new_v4().to_string()).unwrap();
        let root = Document::empty(Scope {
            uid: "42".into(),
            vault: uuid::Uuid::new_v4().to_string(),
            seed: "a".repeat(64),
            domain: Domain::Library,
        });
        outbox::initialize(&c, "t", &lease, &root).unwrap();
        let p =
            protocol_v2::bootstrap_checkpoint(&root, lease.actor(), 1, BTreeMap::new()).unwrap();
        save(&c, "t", &mut lease, &p).unwrap();
        outbox::mutate(&c, "t", Domain::Library, &mut lease, |_| {
            Ok((
                (),
                BTreeMap::from([(key("playlist:x", "__present"), Cell::Value(json!(true)))]),
            ))
        })
        .unwrap();
        acknowledge(&c, "t", &p).unwrap();
        acknowledge(&c, "t", &p).unwrap();
        assert_eq!(outbox::pending(&c, "t", Domain::Library).unwrap().len(), 1);
        assert_eq!(committed(&c, "t", lease.actor()).unwrap(), Some(p.head));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn restart_replays_exact_plan_and_acknowledges_only_its_prefix() {
        let c = Connection::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let instance = uuid::Uuid::new_v4().to_string();
        let mut lease = Lease::open(&dir, &instance).unwrap();
        let actor = lease.actor().to_owned();
        let root = Document::empty(Scope {
            uid: "42".into(),
            vault: instance.clone(),
            seed: "a".repeat(64),
            domain: Domain::Library,
        });
        outbox::initialize(&c, "t", &lease, &root).unwrap();
        outbox::mutate(&c, "t", Domain::Library, &mut lease, |_| {
            Ok((
                (),
                BTreeMap::from([
                    (key("playlist:x", "__present"), Cell::Value(json!(true))),
                    (key("playlist:x", "name"), Cell::Value(json!("one"))),
                ]),
            ))
        })
        .unwrap();
        let batches = outbox::pending(&c, "t", Domain::Library).unwrap();
        let p = protocol_v2::build(
            &root,
            &outbox::overlay(&c, "t", Domain::Library).unwrap(),
            &batches,
            None,
            &actor,
            1,
            BTreeMap::new(),
        )
        .unwrap()
        .unwrap();
        save(&c, "t", &mut lease, &p).unwrap();
        let mut restarted = Lease::open(&dir, &instance).unwrap();
        let restored = pending(&c, "t", &actor).unwrap().unwrap();
        assert_eq!(
            serde_json::to_vec(&restored).unwrap(),
            serde_json::to_vec(&p).unwrap()
        );
        save(&c, "t", &mut restarted, &p).unwrap();
        outbox::mutate(&c, "t", Domain::Library, &mut restarted, |_| {
            Ok((
                (),
                BTreeMap::from([(key("playlist:x", "name"), Cell::Value(json!("two")))]),
            ))
        })
        .unwrap();
        acknowledge(&c, "t", &p).unwrap();
        acknowledge(&c, "t", &p).unwrap();
        assert!(pending(&c, "t", &actor).unwrap().is_none());
        assert_eq!(outbox::pending(&c, "t", Domain::Library).unwrap().len(), 1);
        assert_eq!(
            outbox::overlay(&c, "t", Domain::Library)
                .unwrap()
                .materialize()
                .unwrap()
                .0["playlist:x"]["name"],
            json!("two")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
