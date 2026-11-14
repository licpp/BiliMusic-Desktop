//! Confirmed causal state and a durable overlay. No network IO belongs inside these transactions.
use super::{
    actor::Lease,
    causal::{Batch, Cell, Document, Domain},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;
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
    c.execute_batch("CREATE TABLE IF NOT EXISTS sync_v2_documents(target TEXT NOT NULL,domain TEXT NOT NULL,actor TEXT NOT NULL,confirmed TEXT NOT NULL,allocated INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(target,domain));
    CREATE TABLE IF NOT EXISTS sync_v2_outbox(target TEXT NOT NULL,domain TEXT NOT NULL,actor TEXT NOT NULL,seq INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(target,domain,actor,seq));").map_err(err)
}
pub fn initialize(
    c: &Connection,
    target: &str,
    lease: &Lease,
    seed: &Document,
) -> Result<(), String> {
    init(c)?;
    if !seed.valid() {
        return Err("迁移种子状态无效".into());
    }
    let existing: Option<(String, String)> = c
        .query_row(
            "SELECT actor,confirmed FROM sync_v2_documents WHERE target=?1 AND domain=?2",
            params![target, domain(seed.scope.domain)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((actor, doc)) = existing {
        let old: Document = serde_json::from_str(&doc).map_err(err)?;
        if actor != lease.actor() || old.scope != seed.scope {
            return Err("已有同步状态需要恢复，不能覆盖或更换其身份".into());
        }
        return Ok(());
    }
    if seed.frontier.contains_key(lease.actor()) {
        return Err("新写入身份已存在于迁移种子".into());
    }
    c.execute(
        "INSERT INTO sync_v2_documents(target,domain,actor,confirmed) VALUES(?1,?2,?3,?4)",
        params![
            target,
            domain(seed.scope.domain),
            lease.actor(),
            serde_json::to_string(seed).map_err(err)?
        ],
    )
    .map_err(err)?;
    Ok(())
}
pub fn confirmed(c: &Connection, target: &str, d: Domain) -> Result<Document, String> {
    let raw: String = c
        .query_row(
            "SELECT confirmed FROM sync_v2_documents WHERE target=?1 AND domain=?2",
            params![target, domain(d)],
            |r| r.get(0),
        )
        .map_err(err)?;
    let doc: Document = serde_json::from_str(&raw).map_err(err)?;
    if !doc.valid() {
        return Err("本机增量状态损坏".into());
    }
    Ok(doc)
}
pub fn pending(c: &Connection, target: &str, d: Domain) -> Result<Vec<Batch>, String> {
    let mut q = c
        .prepare(
            "SELECT payload,hash FROM sync_v2_outbox WHERE target=?1 AND domain=?2 ORDER BY seq",
        )
        .map_err(err)?;
    let mut result = Vec::new();
    for row in q
        .query_map(params![target, domain(d)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(err)?
    {
        let (raw, hash) = row.map_err(err)?;
        let batch: Batch = serde_json::from_str(&raw).map_err(err)?;
        if batch.hash()? != hash {
            return Err("待上传批次摘要不符".into());
        }
        result.push(batch)
    }
    Ok(result)
}
pub fn overlay(c: &Connection, target: &str, d: Domain) -> Result<Document, String> {
    let mut doc = confirmed(c, target, d)?;
    for b in pending(c, target, d)? {
        doc.apply(&b)?;
    }
    Ok(doc)
}
/// The edit, dot allocation and durable payload commit together. Callers return canonical deltas.
pub fn mutate<T>(
    c: &Connection,
    target: &str,
    d: Domain,
    lease: &mut Lease,
    edit: impl FnOnce(&Connection) -> Result<(T, BTreeMap<String, Cell>), String>,
) -> Result<T, String> {
    let tx = c.unchecked_transaction().map_err(err)?;
    let result = mutate_in_transaction(c, target, d, lease, None, edit)?;
    tx.commit().map_err(err)?;
    Ok(result)
}
pub fn mutate_in_transaction<T>(
    c: &Connection,
    target: &str,
    d: Domain,
    lease: &mut Lease,
    observed: Option<&BTreeMap<String, super::causal::Register>>,
    edit: impl FnOnce(&Connection) -> Result<(T, BTreeMap<String, Cell>), String>,
) -> Result<T, String> {
    c.execute(
        "UPDATE sync_v2_documents SET allocated=allocated WHERE target=?1 AND domain=?2",
        params![target, domain(d)],
    )
    .map_err(err)?;
    let (actor, allocated): (String, u64) = c
        .query_row(
            "SELECT actor,allocated FROM sync_v2_documents WHERE target=?1 AND domain=?2",
            params![target, domain(d)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    if actor != lease.actor() {
        return Err("当前安装不能使用另一设备的写入身份".into());
    }
    let doc = overlay(c, target, d)?;
    let (result, changes) = edit(c)?;
    let batch = if let Some(context) = observed {
        doc.make_observed_batch(lease.actor(), changes, context)?
    } else {
        doc.make_batch(lease.actor(), changes)?
    };
    if let Some(batch) = batch {
        if batch.seq != allocated.checked_add(1).ok_or("写入序号耗尽")? {
            return Err("本机写入序列不连续".into());
        }
        // Reserve before SQL commit. A failed commit burns this actor sequence, never reuses it.
        lease.reserve(domain(d), allocated, batch.seq)?;
        c.execute(
            "INSERT INTO sync_v2_outbox VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                target,
                domain(d),
                batch.actor,
                batch.seq,
                batch.hash()?,
                serde_json::to_string(&batch).map_err(err)?
            ],
        )
        .map_err(err)?;
        c.execute(
            "UPDATE sync_v2_documents SET allocated=?3 WHERE target=?1 AND domain=?2",
            params![target, domain(d), batch.seq],
        )
        .map_err(err)?;
    }
    Ok(result)
}
/// Acknowledge the exact frozen prefix, folding it into confirmed state before deleting it.
pub fn acknowledge(
    c: &Connection,
    target: &str,
    d: Domain,
    through: u64,
    last_hash: &str,
) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(err)?;
    acknowledge_in_transaction(c, target, d, through, last_hash)?;
    tx.commit().map_err(err)
}
pub(super) fn acknowledge_in_transaction(
    c: &Connection,
    target: &str,
    d: Domain,
    through: u64,
    last_hash: &str,
) -> Result<(), String> {
    let batches = pending(c, target, d)?;
    let Some(last) = batches.iter().find(|b| b.seq == through) else {
        return Err("发布确认前缀不存在".into());
    };
    if last.hash()? != last_hash {
        return Err("发布确认摘要不一致".into());
    }
    let mut doc = confirmed(c, target, d)?;
    for batch in batches.iter().filter(|b| b.seq <= through) {
        doc.apply(batch)?;
    }
    c.execute(
        "UPDATE sync_v2_documents SET confirmed=?3 WHERE target=?1 AND domain=?2",
        params![target, domain(d), serde_json::to_string(&doc).map_err(err)?],
    )
    .map_err(err)?;
    c.execute(
        "DELETE FROM sync_v2_outbox WHERE target=?1 AND domain=?2 AND seq<=?3",
        params![target, domain(d), through],
    )
    .map_err(err)?;
    Ok(())
}
pub fn receive(
    c: &Connection,
    target: &str,
    remote: &Document,
    project: impl FnOnce(&Connection, &Document) -> Result<(), String>,
) -> Result<(), String> {
    let d = remote.scope.domain;
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut doc = confirmed(c, target, d)?;
    doc.join(remote)?;
    c.execute(
        "UPDATE sync_v2_documents SET confirmed=?3 WHERE target=?1 AND domain=?2",
        params![target, domain(d), serde_json::to_string(&doc).map_err(err)?],
    )
    .map_err(err)?;
    let material = overlay(c, target, d)?;
    project(c, &material)?;
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::super::causal::{self, Scope};
    use super::*;
    use serde_json::json;
    fn fixture() -> (Connection, Lease, std::path::PathBuf) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE business(value TEXT);")
            .unwrap();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let lease = Lease::open(&dir, &uuid::Uuid::new_v4().to_string()).unwrap();
        let doc = Document::empty(Scope {
            uid: "42".into(),
            vault: uuid::Uuid::new_v4().to_string(),
            seed: "a".repeat(64),
            domain: Domain::Library,
        });
        initialize(&c, "t", &lease, &doc).unwrap();
        (c, lease, dir)
    }
    fn edit(c: &Connection, l: &mut Lease, value: &str) {
        mutate(c, "t", Domain::Library, l, |c| {
            c.execute("INSERT INTO business VALUES(?1)", [value])
                .map_err(err)?;
            Ok((
                (),
                BTreeMap::from([
                    (
                        causal::key("playlist:x", "__present"),
                        Cell::Value(json!(true)),
                    ),
                    (causal::key("playlist:x", "name"), Cell::Value(json!(value))),
                ]),
            ))
        })
        .unwrap();
    }
    #[test]
    fn business_rollback_and_exact_prefix_ack_preserve_new_edits() {
        let (c, mut lease, dir) = fixture();
        assert!(
            mutate::<()>(&c, "t", Domain::Library, &mut lease, |c| {
                c.execute("INSERT INTO business VALUES('rollback')", [])
                    .unwrap();
                Err("failure".into())
            })
            .is_err()
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM business", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        edit(&c, &mut lease, "one");
        let frozen = pending(&c, "t", Domain::Library).unwrap();
        edit(&c, &mut lease, "two");
        acknowledge(&c, "t", Domain::Library, 1, &frozen[0].hash().unwrap()).unwrap();
        assert_eq!(pending(&c, "t", Domain::Library).unwrap().len(), 1);
        assert_eq!(
            overlay(&c, "t", Domain::Library)
                .unwrap()
                .materialize()
                .unwrap()
                .0["playlist:x"]["name"],
            json!("two")
        );
        assert_eq!(
            confirmed(&c, "t", Domain::Library)
                .unwrap()
                .materialize()
                .unwrap()
                .0["playlist:x"]["name"],
            json!("one")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn remote_receive_keeps_outbox_without_republishing_received_state() {
        let (c, mut lease, dir) = fixture();
        edit(&c, &mut lease, "local");
        let mut remote = confirmed(&c, "t", Domain::Library).unwrap();
        let batch = remote
            .make_batch(
                &uuid::Uuid::new_v4().to_string(),
                BTreeMap::from([
                    (
                        causal::key("playlist:y", "__present"),
                        Cell::Value(json!(true)),
                    ),
                    (
                        causal::key("playlist:y", "name"),
                        Cell::Value(json!("remote")),
                    ),
                ]),
            )
            .unwrap()
            .unwrap();
        remote.apply(&batch).unwrap();
        receive(&c, "t", &remote, |_, view| {
            assert_eq!(view.materialize()?.0.len(), 2);
            Ok(())
        })
        .unwrap();
        assert_eq!(pending(&c, "t", Domain::Library).unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn outside_watermark_detects_database_rollback_instead_of_reusing_dots() {
        let (c, mut lease, dir) = fixture();
        edit(&c, &mut lease, "one");
        c.execute("DELETE FROM sync_v2_outbox", []).unwrap();
        c.execute("UPDATE sync_v2_documents SET allocated=0", [])
            .unwrap();
        assert!(
            mutate(&c, "t", Domain::Library, &mut lease, |_| Ok((
                (),
                BTreeMap::from([(
                    causal::key("playlist:x", "name"),
                    Cell::Value(json!("reused"))
                )])
            )))
            .is_err()
        );
        assert!(pending(&c, "t", Domain::Library).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
