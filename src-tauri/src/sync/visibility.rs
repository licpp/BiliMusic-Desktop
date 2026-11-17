//! Optional personal filters. No new records or fields enter the legacy library protocol.
use super::{
    Config,
    actor::Lease,
    causal::{self, Candidate, Cell, Dot, Register},
    migration::Genesis,
    transport::Secret,
    v2_net::Client,
};
use crate::infrastructure::database::{Database, account_session};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub scope: String,
    pub target: String,
    pub hidden: bool,
}
fn valid(scope: &str, target: &str) -> bool {
    let bv = |s: &str| {
        s.len() == 12 && s.starts_with("BV") && s.bytes().all(|b| b.is_ascii_alphanumeric())
    };
    let positive = |s: &str| s.parse::<i64>().is_ok_and(|n| n > 0 && n.to_string() == s);
    if let Some(video) = scope.strip_prefix("video:") {
        return bv(video) && target.strip_prefix("cid:").is_some_and(positive);
    }
    scope.strip_prefix("season:").is_some_and(|ids| {
        let ids = ids.split(':').collect::<Vec<_>>();
        ids.len() == 2 && ids.iter().all(|s| positive(s))
    }) && bv(target)
}
pub(super) fn hidden(r: &Register) -> bool {
    r.values.iter().any(|v| v.cell == Cell::Value(true.into()))
}
pub fn rules(c: &Connection) -> Result<Vec<Rule>, String> {
    let mut q = c
        .prepare("SELECT scope,target,register FROM content_visibility ORDER BY scope,target")
        .map_err(err)?;
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(err)?;
    rows.map(|r| {
        let (s, t, j) = r.map_err(err)?;
        let reg: Register = serde_json::from_str(&j).map_err(err)?;
        Ok(Rule {
            scope: s,
            target: t,
            hidden: hidden(&reg),
        })
    })
    .collect()
}
fn get(c: &Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT value FROM visibility_runtime WHERE key=?1",
        [key],
        |r| r.get(0),
    )
    .optional()
    .map_err(err)
}
fn put(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO visibility_runtime VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(err)?;
    Ok(())
}
fn read_reg(c: &Connection, s: &str, t: &str) -> Result<Register, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT register FROM content_visibility WHERE scope=?1 AND target=?2",
            params![s, t],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    raw.map(|j| serde_json::from_str(&j).map_err(err))
        .transpose()
        .map(|r| r.unwrap_or_default())
}
pub fn save(db: &Database, expected: &str, changes: &[Rule]) -> Result<(), String> {
    if changes.len() > 10000
        || changes.iter().any(|r| !valid(&r.scope, &r.target))
        || changes
            .iter()
            .map(|r| (&r.scope, &r.target))
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != changes.len()
    {
        return Err("隐藏规则无效".into());
    }
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    if account_session(&c).map_err(err)? != expected {
        return Err("账号已切换，请重新操作".into());
    }
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut instance = get(&c, "instance")?.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let installation = super::engine::installation(&db.1)?;
    let mut seq = get(&c, "sequence")?
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let path = |i: &str| {
        db.1.join("visibility-writer")
            .join(format!("{installation}-{i}"))
    };
    let mut lease = Lease::open(&path(&instance), &instance)?;
    if !lease.consistent(&BTreeMap::from([("visibility".into(), seq)])) {
        instance = uuid::Uuid::new_v4().to_string();
        seq = 0;
        lease = Lease::open(&path(&instance), &instance)?;
    }
    let effective = changes
        .iter()
        .filter_map(|r| match read_reg(&c, &r.scope, &r.target) {
            Ok(reg)
                if !reg.values.is_empty()
                    && reg
                        .values
                        .iter()
                        .all(|v| v.cell == Cell::Value(r.hidden.into())) =>
            {
                None
            }
            other => Some(other.map(|reg| (r, reg))),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if effective.is_empty() {
        return Ok(());
    }
    let next = seq.checked_add(1).ok_or("隐藏操作序号耗尽")?;
    lease.reserve("visibility", seq, next)?;
    for (rule, reg) in effective {
        let dot = Dot {
            actor: lease.actor().into(),
            seq: next,
        };
        let mut seen = reg.seen;
        seen.insert(&dot);
        let r = Register {
            seen,
            values: vec![Candidate {
                dot,
                cell: Cell::Value(rule.hidden.into()),
            }],
        };
        c.execute("INSERT INTO content_visibility VALUES(?1,?2,?3) ON CONFLICT(scope,target) DO UPDATE SET register=excluded.register",params![rule.scope,rule.target,serde_json::to_string(&r).map_err(err)?]).map_err(err)?;
    }
    let revision = get(&c, "revision")?
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("隐藏规则版本耗尽")?;
    put(&c, "revision", &revision.to_string())?;
    put(&c, "instance", &instance)?;
    put(&c, "sequence", &next.to_string())?;
    tx.commit().map_err(err)
}
pub fn allowed(c: &Connection, bvid: &str, cid: i64, season: Option<&str>) -> Result<bool, String> {
    if season.is_some_and(|s| s.starts_with("season:"))
        && hidden(&read_reg(c, season.unwrap(), bvid)?)
    {
        return Ok(false);
    }
    Ok(!hidden(&read_reg(
        c,
        &format!("video:{bvid}"),
        &format!("cid:{cid}"),
    )?))
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Packet {
    schema: u32,
    uid: String,
    vault: String,
    seed: String,
    namespace: String,
    actor: String,
    generation: u64,
    registers: BTreeMap<String, Register>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    owner: String,
    packet: Packet,
    hash: String,
    bytes: Vec<u8>,
    revision: u64,
}
fn object(g: &Genesis, hash: &str) -> String {
    format!(
        "sync-v2/{}/extensions/visibility-v1/{hash}.json.gz",
        g.vault
    )
}
fn prefix() -> &'static str {
    "ext-visibility-v1-"
}
fn marker(p: &Pending) -> String {
    format!("{}{:020}-{}.head", prefix(), p.packet.generation, p.hash)
}
fn validate(p: &Packet, g: &Genesis) -> Result<(), String> {
    if p.schema != 1
        || p.namespace != "visibility-v1"
        || p.uid != g.uid
        || p.vault != g.vault
        || p.seed != g.seed
        || uuid::Uuid::parse_str(&p.actor).is_err()
        || p.generation == 0
        || p.registers.len() > 20000
    {
        return Err("隐藏规则同步身份无效".into());
    }
    for (key, r) in &p.registers {
        let (s, t): (String, String) = serde_json::from_str(key).map_err(err)?;
        if !valid(&s, &t)
            || r.values.is_empty()
            || r.values
                .iter()
                .any(|v| !matches!(v.cell, Cell::Value(serde_json::Value::Bool(_))))
        {
            return Err("隐藏规则同步内容无效".into());
        }
        let mut check = Register::default();
        check.merge(r)?;
    }
    Ok(())
}
fn merge(c: &Connection, p: &Packet) -> Result<(), String> {
    for (key, remote) in &p.registers {
        let (s, t): (String, String) = serde_json::from_str(key).map_err(err)?;
        let mut local = read_reg(c, &s, &t)?;
        local.merge(remote)?;
        c.execute("INSERT INTO content_visibility VALUES(?1,?2,?3) ON CONFLICT(scope,target) DO UPDATE SET register=excluded.register",params![s,t,serde_json::to_string(&local).map_err(err)?]).map_err(err)?;
    }
    Ok(())
}

/// Full snapshots contain only personal registers, never source catalogues. Each actor's
/// newest snapshot stands alone, so interrupted uploads cannot create missing dependencies.
/// The marker lives beside core heads: old clients ignore its non-numeric filename.
pub(super) async fn exchange(
    db: &Database,
    cfg: &Config,
    secret: &Secret,
    owner: &str,
) -> Result<bool, String> {
    let target = super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    let g = Genesis::for_config(cfg)?;
    let net = Client::cached(cfg, secret, db.1.join("visibility-cache").join(&target))?;
    let session = {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        account_session(&c).map_err(err)?
    };
    let with = |f: &dyn Fn(&Connection) -> Result<(), String>| -> Result<(), String> {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        super::active(db, &cfg.uid)?;
        let current = super::config_from_connection(&c)?.ok_or("同步连接已改变")?;
        if current.provider != cfg.provider
            || current.url != cfg.url
            || current.uid != cfg.uid
            || account_session(&c).map_err(err)? != session
        {
            return Err("同步连接或账号已切换".into());
        }
        let tx = c.unchecked_transaction().map_err(err)?;
        f(&c)?;
        tx.commit().map_err(err)
    };
    let before = {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        serde_json::to_string(&rules(&c)?).map_err(err)?
    };
    let (owners, _) = net.list(&format!("sync-v2/{}/control/", g.vault)).await?;
    {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        let mut q = c
            .prepare("SELECT actor FROM visibility_heads WHERE target=?1")
            .map_err(err)?;
        for actor in q
            .query_map([&target], |r| r.get::<_, String>(0))
            .map_err(err)?
        {
            if !owners.contains(&actor.map_err(err)?) {
                return Err("已确认的隐藏规则设备暂不可见，已保留本机设置".into());
            }
        }
    }
    for actor in owners
        .into_iter()
        .filter(|a| uuid::Uuid::parse_str(a).is_ok())
    {
        let path = format!("sync-v2/{}/control/{actor}/", g.vault);
        let (files, _) = net.list(&path).await?;
        let mut heads = files
            .into_iter()
            .filter_map(|n| {
                let rest = n.strip_prefix(prefix())?.strip_suffix(".head")?;
                let (seq, hash) = rest.split_once('-')?;
                if seq.len() != 20 || !causal::valid_hash(hash) {
                    return None;
                }
                Some((seq.parse::<u64>().ok()?, hash.to_owned(), n))
            })
            .collect::<Vec<_>>();
        heads.sort();
        let known = {
            let c = db.0.lock().map_err(|_| "数据库正忙")?;
            c.query_row(
                "SELECT generation,hash FROM visibility_heads WHERE target=?1 AND actor=?2",
                params![target, actor],
                |r| Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(err)?
        };
        let Some((generation, hash, name)) = heads.last() else {
            if known.is_some() {
                return Err("隐藏规则提交暂不可见".into());
            }
            continue;
        };
        if heads.iter().filter(|h| h.0 == *generation).count() != 1 {
            return Err("隐藏规则提交发生分叉".into());
        }
        if let Some((old, old_hash)) = &known {
            if generation < old || generation == old && hash != old_hash {
                return Err("隐藏规则同步水位回退或分叉".into());
            }
            if generation == old {
                continue;
            }
        }
        let head = net
            .get(&format!("{path}{name}"))
            .await?
            .ok_or("隐藏规则提交暂不可见")?;
        if head.body != hash.as_bytes() {
            return Err("隐藏规则提交摘要不符".into());
        }
        let body = net
            .get(&object(&g, hash))
            .await?
            .ok_or("隐藏规则同步对象缺失")?;
        let packet: Packet = super::protocol_v2::decode(
            &body.body,
            &super::protocol_v2::ObjectRef {
                hash: hash.clone(),
                bytes: body.body.len() as u64,
                first_seq: 0,
                last_seq: 0,
            },
        )?;
        validate(&packet, &g)?;
        if packet.actor != actor || packet.generation != *generation {
            return Err("隐藏规则提交身份无效".into());
        }
        with(&|c| {
            merge(c, &packet)?;
            c.execute("INSERT INTO visibility_heads VALUES(?1,?2,?3,?4) ON CONFLICT(target,actor) DO UPDATE SET generation=excluded.generation,hash=excluded.hash",params![target,actor,generation,hash]).map_err(err)?;
            Ok(())
        })?;
    }
    let mut frozen = None;
    // Freeze under the same session guard as projection. Per-target cursors acknowledge
    // local intent revisions; receiving a register never increments that revision.
    with(&|c| {
        let existing: Option<String> = c
            .query_row(
                "SELECT pending FROM visibility_publications WHERE target=?1",
                [&target],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        if existing.is_some() {
            return Ok(());
        }
        let revision = get(c, "revision")?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let old: Option<String> = c
            .query_row(
                "SELECT committed FROM visibility_publications WHERE target=?1",
                [&target],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        let old = old
            .map(|s| serde_json::from_str::<Pending>(&s).map_err(err))
            .transpose()?;
        if revision <= old.as_ref().map_or(0, |p| p.revision) {
            return Ok(());
        }
        let mut q = c
            .prepare("SELECT scope,target,register FROM content_visibility ORDER BY scope,target")
            .map_err(err)?;
        let mut regs = BTreeMap::new();
        for row in q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?
        {
            let (s, t, j) = row.map_err(err)?;
            regs.insert(
                serde_json::to_string(&(s, t)).map_err(err)?,
                serde_json::from_str::<Register>(&j).map_err(err)?,
            );
        }
        let generation = old
            .as_ref()
            .filter(|p| p.owner == owner)
            .map_or(Ok(1), |p| {
                p.packet
                    .generation
                    .checked_add(1)
                    .ok_or("隐藏规则提交序号耗尽")
            })?;
        let packet = Packet {
            schema: 1,
            uid: g.uid.clone(),
            vault: g.vault.clone(),
            seed: g.seed.clone(),
            namespace: "visibility-v1".into(),
            actor: owner.into(),
            generation,
            registers: regs,
        };
        validate(&packet, &g)?;
        let bytes = super::protocol_v2::encode(&packet)?;
        let pending = Pending {
            owner: owner.into(),
            packet,
            hash: causal::hash(&bytes),
            bytes,
            revision,
        };
        c.execute("INSERT INTO visibility_publications(target,pending) VALUES(?1,?2) ON CONFLICT(target) DO UPDATE SET pending=excluded.pending",params![target,serde_json::to_string(&pending).map_err(err)?]).map_err(err)?;
        Ok(())
    })?;
    {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        let raw: Option<String> = c
            .query_row(
                "SELECT pending FROM visibility_publications WHERE target=?1",
                [&target],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        if let Some(raw) = raw {
            frozen = Some(serde_json::from_str::<Pending>(&raw).map_err(err)?);
        }
    }
    if let Some(p) = frozen {
        validate(&p.packet, &g)?;
        let decoded: Packet = super::protocol_v2::decode(
            &p.bytes,
            &super::protocol_v2::ObjectRef {
                hash: p.hash.clone(),
                bytes: p.bytes.len() as u64,
                first_seq: 0,
                last_seq: 0,
            },
        )?;
        if p.owner != p.packet.actor || p.revision == 0 || decoded != p.packet {
            return Err("隐藏规则待提交内容无效".into());
        }
        for dir in [
            format!("sync-v2/{}/extensions/", g.vault),
            format!("sync-v2/{}/extensions/visibility-v1/", g.vault),
            format!("sync-v2/{}/control/{}/", g.vault, p.owner),
        ] {
            net.mkdir(&dir).await?;
        }
        with(&|_| Ok(()))?;
        net.put(&object(&g, &p.hash), p.bytes.clone()).await?;
        let path = format!("sync-v2/{}/control/{}/{}", g.vault, p.owner, marker(&p));
        net.put(&path, p.hash.as_bytes().to_vec()).await?;
        if net
            .get(&path)
            .await?
            .is_none_or(|b| b.body != p.hash.as_bytes())
        {
            return Err("隐藏规则提交尚未确认".into());
        }
        with(&|c| {
            c.execute("UPDATE visibility_publications SET pending=NULL,committed=?2 WHERE target=?1 AND pending=?2",params![target,serde_json::to_string(&p).map_err(err)?]).map_err(err)?;
            Ok(())
        })?;
    }
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    Ok(before != serde_json::to_string(&rules(&c)?).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    const BV: &str = "BV1QrSeY2ETh";
    fn device(cfg: &Config) -> Database {
        let root = std::env::temp_dir().join(format!("visibility-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("active-profile"), &cfg.uid).unwrap();
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute(
            "INSERT INTO sync_settings VALUES(1,?1)",
            [serde_json::to_string(cfg).unwrap()],
        )
        .unwrap();
        Database(std::sync::Mutex::new(c), root)
    }
    fn edit(db: &Database, value: bool) {
        let session = {
            let c = db.0.lock().unwrap();
            account_session(&c).unwrap()
        };
        save(
            db,
            &session,
            &[Rule {
                scope: format!("video:{BV}"),
                target: "cid:1".into(),
                hidden: value,
            }],
        )
        .unwrap()
    }
    fn state(db: &Database) -> Register {
        read_reg(&db.0.lock().unwrap(), &format!("video:{BV}"), "cid:1").unwrap()
    }
    fn receive(db: &Database, remote: &Register) {
        let c = db.0.lock().unwrap();
        let mut r = read_reg(&c, &format!("video:{BV}"), "cid:1").unwrap();
        r.merge(remote).unwrap();
        c.execute("INSERT INTO content_visibility VALUES(?1,'cid:1',?2) ON CONFLICT(scope,target) DO UPDATE SET register=excluded.register",params![format!("video:{BV}"),serde_json::to_string(&r).unwrap()]).unwrap();
    }
    #[test]
    fn restores_are_causal_and_concurrent_hide_wins_without_user_choices() {
        let cfg = Config {
            uid: "42".into(),
            ..Config::default()
        };
        let a = device(&cfg);
        let b = device(&cfg);
        let c = device(&cfg);
        edit(&a, true);
        receive(&b, &state(&a));
        receive(&c, &state(&a));
        edit(&a, false);
        edit(&a, true);
        edit(&b, false);
        let ar = state(&a);
        let br = state(&b);
        receive(&a, &br);
        receive(&b, &ar);
        receive(&c, &br);
        receive(&c, &ar);
        assert_eq!(state(&a), state(&b));
        assert_eq!(state(&a), state(&c));
        assert!(hidden(&state(&a)));
        edit(&b, false);
        receive(&a, &state(&b));
        receive(&c, &state(&b));
        assert!(!hidden(&state(&a)));
        assert_eq!(state(&a), state(&c));
        // Reordered duplicate delivery cannot resurrect a removed candidate.
        receive(&a, &ar);
        receive(&a, &br);
        assert!(!hidden(&state(&a)));
        for db in [a, b, c] {
            std::fs::remove_dir_all(db.1).unwrap();
        }
    }
    #[test]
    fn source_identity_scope_and_account_session_are_preserved() {
        let db = device(&Config::default());
        edit(&db, true);
        let c = db.0.lock().unwrap();
        assert!(!allowed(&c, BV, 1, None).unwrap());
        assert!(allowed(&c, BV, 2, None).unwrap());
        assert!(allowed(&c, "BVanother", 1, None).unwrap());
        drop(c);
        let revision = get(&db.0.lock().unwrap(), "revision").unwrap();
        edit(&db, true);
        assert_eq!(get(&db.0.lock().unwrap(), "revision").unwrap(), revision);
        assert!(
            save(
                &db,
                "stale-session",
                &[Rule {
                    scope: format!("video:{BV}"),
                    target: "cid:1".into(),
                    hidden: false
                }]
            )
            .is_err()
        );
        assert!(hidden(&state(&db)));
        let session = account_session(&db.0.lock().unwrap()).unwrap();
        assert!(
            save(
                &db,
                &session,
                &[Rule {
                    scope: format!("video:{BV}"),
                    target: "cid:01".into(),
                    hidden: false
                }]
            )
            .is_err()
        );
        save(
            &db,
            &session,
            &[Rule {
                scope: "season:1:2".into(),
                target: BV.into(),
                hidden: true,
            }],
        )
        .unwrap();
        let c = db.0.lock().unwrap();
        assert!(!allowed(&c, BV, 999, Some("season:1:2")).unwrap());
        assert!(allowed(&c, BV, 999, Some("season:1:3")).unwrap());
        drop(c);
        std::fs::remove_dir_all(db.1).unwrap();
    }
    #[test]
    fn sqlite_rollback_rotates_writer_instead_of_reusing_an_operation_dot() {
        let db = device(&Config::default());
        edit(&db, true);
        let old = state(&db).values[0].dot.actor.clone();
        edit(&db, false);
        put(&db.0.lock().unwrap(), "sequence", "0").unwrap();
        edit(&db, true);
        assert_ne!(state(&db).values[0].dot.actor, old);
        std::fs::remove_dir_all(db.1).unwrap();
    }
    #[tokio::test]
    async fn real_dav_bootstrap_restore_no_echo_and_old_core_discovery() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let owner = uuid::Uuid::new_v4().to_string();
        let owner_b = uuid::Uuid::new_v4().to_string();
        let g = Genesis::for_config(&cfg).unwrap();
        let net = Client::new(&cfg, &secret).unwrap();
        net.parents().await.unwrap();
        net.mkdir(&format!("sync-v2/{}/", g.vault)).await.unwrap();
        net.mkdir(&format!("sync-v2/{}/control/", g.vault))
            .await
            .unwrap();
        edit(&a, true);
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        assert!(
            super::super::protocol_v2::discover(&net, &g.uid, &g.vault, &g.seed, &owner, 0)
                .await
                .unwrap()
                .is_none(),
            "old core ignores optional marker filenames"
        );
        store.lock().unwrap().requests.clear();
        assert!(exchange(&b, &cfg, &secret, &owner_b).await.unwrap());
        assert!(hidden(&state(&b)));
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(method, _)| method != "PUT"),
            "receiving preferences must not echo an upload"
        );
        edit(&b, false);
        exchange(&b, &cfg, &secret, &owner_b).await.unwrap();
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        assert!(!hidden(&state(&a)));
        store.lock().unwrap().requests.clear();
        super::super::v2_net::discovery_round(async {
            let _ = net
                .list(&format!("sync-v2/{}/control/", g.vault))
                .await
                .unwrap();
            for actor in [&owner, &owner_b] {
                let _ = net
                    .list(&format!("sync-v2/{}/control/{actor}/", g.vault))
                    .await
                    .unwrap();
            }
            let count = store.lock().unwrap().requests.len();
            exchange(&a, &cfg, &secret, &owner).await.unwrap();
            assert_eq!(
                store.lock().unwrap().requests.len(),
                count,
                "idle extension reuses core discovery without more requests"
            );
        })
        .await;
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap();
        }
    }
    #[tokio::test]
    async fn ambiguous_put_replays_frozen_bytes_then_publishes_newer_restore() {
        use super::super::test_dav::{Failure, Fault};
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let owner = uuid::Uuid::new_v4().to_string();
        let g = Genesis::for_config(&cfg).unwrap();
        let net = Client::new(&cfg, &secret).unwrap();
        net.parents().await.unwrap();
        net.mkdir(&format!("sync-v2/{}/", g.vault)).await.unwrap();
        net.mkdir(&format!("sync-v2/{}/control/", g.vault))
            .await
            .unwrap();
        edit(&a, true);
        store.lock().unwrap().fault = Some(Fault {
            ordinal: None,
            method: Some("PUT".into()),
            contains: "ext-visibility-v1-".into(),
            failure: Failure::After(503),
        });
        assert!(exchange(&a, &cfg, &secret, &owner).await.is_err());
        let pending: String =
            a.0.lock()
                .unwrap()
                .query_row("SELECT pending FROM visibility_publications", [], |r| {
                    r.get(0)
                })
                .unwrap();
        edit(&a, false);
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        let committed: String =
            a.0.lock()
                .unwrap()
                .query_row("SELECT committed FROM visibility_publications", [], |r| {
                    r.get(0)
                })
                .unwrap();
        assert_eq!(
            pending, committed,
            "retry never regenerates an uncertain publication"
        );
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        exchange(&b, &cfg, &secret, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(!hidden(&state(&b)));
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap();
        }
    }
    #[test]
    fn one_thousand_filters_are_one_compressed_object_not_one_thousand_requests() {
        let db = device(&Config::default());
        let session = account_session(&db.0.lock().unwrap()).unwrap();
        let changes = (1..=1000)
            .map(|n| Rule {
                scope: format!("video:{BV}"),
                target: format!("cid:{n}"),
                hidden: true,
            })
            .collect::<Vec<_>>();
        save(&db, &session, &changes).unwrap();
        let c = db.0.lock().unwrap();
        let mut regs = BTreeMap::new();
        for r in rules(&c).unwrap() {
            regs.insert(
                serde_json::to_string(&(&r.scope, &r.target)).unwrap(),
                read_reg(&c, &r.scope, &r.target).unwrap(),
            );
        }
        let bytes = super::super::protocol_v2::encode(&regs).unwrap();
        assert!(
            bytes.len() < 30_000,
            "1000 rules compressed to {} bytes",
            bytes.len()
        );
        drop(c);
        std::fs::remove_dir_all(db.1).unwrap();
    }

    #[test]
    fn random_offline_edits_duplicate_delivery_and_final_restore_converge() {
        for seed in 0..32u64 {
            let mut random = seed + 1;
            let mut next = || {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                random
            };
            let actors = (0..4)
                .map(|_| uuid::Uuid::new_v4().to_string())
                .collect::<Vec<_>>();
            let mut replicas = vec![vec![Register::default(); 8]; 4];
            let mut sequences = [0u64; 4];
            for _ in 0..500 {
                let device = (next() % 4) as usize;
                let key = (next() % 8) as usize;
                if next() % 3 == 0 {
                    let other = (next() % 4) as usize;
                    let remote = replicas[other][key].clone();
                    replicas[device][key].merge(&remote).unwrap();
                    replicas[device][key].merge(&remote).unwrap();
                } else {
                    sequences[device] += 1;
                    let dot = Dot {
                        actor: actors[device].clone(),
                        seq: sequences[device],
                    };
                    let mut seen = replicas[device][key].seen.clone();
                    seen.insert(&dot);
                    replicas[device][key] = Register {
                        seen,
                        values: vec![Candidate {
                            dot,
                            cell: Cell::Value((next() % 2 == 0).into()),
                        }],
                    };
                }
            }
            for key in 0..8 {
                let mut left = Register::default();
                let mut right = Register::default();
                for replica in &replicas {
                    left.merge(&replica[key]).unwrap()
                }
                for replica in replicas.iter().rev() {
                    right.merge(&replica[key]).unwrap()
                }
                assert_eq!(left, right, "seed={seed},key={key}");
                sequences[0] += 1;
                let dot = Dot {
                    actor: actors[0].clone(),
                    seq: sequences[0],
                };
                let mut seen = left.seen.clone();
                seen.insert(&dot);
                let restored = Register {
                    seen,
                    values: vec![Candidate {
                        dot,
                        cell: Cell::Value(false.into()),
                    }],
                };
                for replica in &replicas {
                    let mut stale = replica[key].clone();
                    stale.merge(&restored).unwrap();
                    assert!(!hidden(&stale));
                    assert_eq!(stale, restored);
                }
            }
        }
    }
    #[tokio::test]
    async fn a_late_remote_projection_cannot_write_after_the_same_account_session_changes() {
        use super::super::test_dav::Gate;
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let owner = uuid::Uuid::new_v4().to_string();
        let g = Genesis::for_config(&cfg).unwrap();
        let net = Client::new(&cfg, &secret).unwrap();
        net.parents().await.unwrap();
        net.mkdir(&format!("sync-v2/{}/", g.vault)).await.unwrap();
        net.mkdir(&format!("sync-v2/{}/control/", g.vault))
            .await
            .unwrap();
        edit(&a, true);
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        store.lock().unwrap().gate = Some(Gate {
            method: "GET".into(),
            contains: ".head".into(),
            entered: entered.clone(),
            release: release.clone(),
        });
        let owner_b = uuid::Uuid::new_v4().to_string();
        let (result, _) = tokio::join!(exchange(&b, &cfg, &secret, &owner_b), async {
            entered.notified().await;
            let c = b.0.lock().unwrap();
            c.execute("DELETE FROM account_session", []).unwrap();
            account_session(&c).unwrap();
            drop(c);
            release.notify_one();
        });
        assert!(result.unwrap_err().contains("切换"));
        assert!(rules(&b.0.lock().unwrap()).unwrap().is_empty());
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap();
        }
    }
}
