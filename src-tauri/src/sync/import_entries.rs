//! Optional import slots protocol. Content addressed chunks cap a binding update
//! at 100 slots + a small manifest; search candidates never leave the device.
use super::{
    Config,
    causal::{self, Register},
    migration::Genesis,
    transport::Secret,
    v2_net::Client,
};
use crate::infrastructure::{
    database::{Database, account_session},
    repositories::imported_entries as repo,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
const NS: &str = "import-entries-v1";
const PREFIX: &str = "ext-import-entries-v1-";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Ref {
    hash: String,
    bytes: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    schema: u32,
    uid: String,
    vault: String,
    seed: String,
    namespace: String,
    registers: BTreeMap<String, Register>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    uid: String,
    vault: String,
    seed: String,
    namespace: String,
    actor: String,
    generation: u64,
    chunks: Vec<Ref>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Frozen {
    manifest: Manifest,
    reference: Ref,
    body: Vec<u8>,
    chunks: BTreeMap<String, Vec<u8>>,
    revision: u64,
}
fn object(g: &Genesis, hash: &str) -> String {
    format!("sync-v2/{}/extensions/{NS}/{hash}.json.gz", g.vault)
}
fn marker(m: &Manifest, hash: &str) -> String {
    format!("{PREFIX}{:020}-{hash}.head", m.generation)
}
fn decode<T: serde::de::DeserializeOwned>(body: &[u8], r: &Ref) -> Result<T, String> {
    super::protocol_v2::decode(
        body,
        &super::protocol_v2::ObjectRef {
            hash: r.hash.clone(),
            bytes: r.bytes,
            first_seq: 0,
            last_seq: 0,
        },
    )
}
fn reference(body: &[u8]) -> Ref {
    Ref {
        hash: causal::hash(body),
        bytes: body.len() as u64,
    }
}
fn valid_ref(r: &Ref) -> bool {
    causal::valid_hash(&r.hash) && r.bytes > 0 && r.bytes <= 8 * 1024 * 1024
}
fn validate_manifest(m: &Manifest, g: &Genesis) -> Result<(), String> {
    if m.schema != 1
        || m.namespace != NS
        || m.uid != g.uid
        || m.vault != g.vault
        || m.seed != g.seed
        || uuid::Uuid::parse_str(&m.actor).is_err()
        || m.generation == 0
        || m.chunks.len() > 2000
        || m.chunks.iter().any(|r| !valid_ref(r))
        || m.chunks
            .iter()
            .map(|r| &r.hash)
            .collect::<BTreeSet<_>>()
            .len()
            != m.chunks.len()
    {
        return Err("导入歌单同步身份或清单无效".into());
    }
    Ok(())
}
fn validate_chunk(p: &Chunk, g: &Genesis) -> Result<(), String> {
    if p.schema != 1
        || p.namespace != NS
        || p.uid != g.uid
        || p.vault != g.vault
        || p.seed != g.seed
        || p.registers.is_empty()
        || p.registers.len() > 100
    {
        return Err("导入歌单同步分块无效".into());
    }
    for (k, r) in &p.registers {
        repo::validate(k, r)?
    }
    Ok(())
}
fn freeze(
    c: &Connection,
    g: &Genesis,
    owner: &str,
    generation: u64,
    revision: u64,
) -> Result<Frozen, String> {
    let mut buckets: BTreeMap<char, Vec<(String, Register)>> = BTreeMap::new();
    for (k, r) in repo::registers(c, true)? {
        buckets
            .entry(k.chars().nth(6).ok_or("导入条目身份无效")?)
            .or_default()
            .push((k, r));
    }
    let mut chunks = BTreeMap::new();
    let mut refs = Vec::new();
    for values in buckets.values() {
        for page in values.chunks(100) {
            let packet = Chunk {
                schema: 1,
                uid: g.uid.clone(),
                vault: g.vault.clone(),
                seed: g.seed.clone(),
                namespace: NS.into(),
                registers: page.iter().cloned().collect(),
            };
            validate_chunk(&packet, g)?;
            let body = super::protocol_v2::encode(&packet)?;
            let r = reference(&body);
            chunks.insert(r.hash.clone(), body);
            refs.push(r);
        }
    }
    let manifest = Manifest {
        schema: 1,
        uid: g.uid.clone(),
        vault: g.vault.clone(),
        seed: g.seed.clone(),
        namespace: NS.into(),
        actor: owner.into(),
        generation,
        chunks: refs,
    };
    validate_manifest(&manifest, g)?;
    let body = super::protocol_v2::encode(&manifest)?;
    Ok(Frozen {
        manifest,
        reference: reference(&body),
        body,
        chunks,
        revision,
    })
}
fn runtime_revision(c: &Connection) -> Result<u64, String> {
    Ok(c.query_row(
        "SELECT value FROM imported_entry_runtime WHERE key='revision'",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(err)?
    .and_then(|s| s.parse().ok())
    .unwrap_or(0))
}
fn publication(c: &Connection, target: &str, column: &str) -> Result<Option<Frozen>, String> {
    let raw: Option<String> = c
        .query_row(
            &format!("SELECT {column} FROM imported_entry_publications WHERE target=?1"),
            [target],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .flatten();
    raw.map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
}
/// Transport calls all pass through the existing shared WebDAV request policy.
/// Local receiving and canonical projection do not advance publication revision.
pub(super) async fn exchange(
    db: &Database,
    cfg: &Config,
    secret: &Secret,
    owner: &str,
) -> Result<bool, String> {
    let target = super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    let g = Genesis::for_config(cfg)?;
    let net = Client::cached(cfg, secret, db.1.join("import-entry-cache").join(&target))?;
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
        repo::init(&c).map_err(err)?;
        serde_json::to_string(&repo::registers(&c, false)?).map_err(err)?
    };
    // Discover canonical remote slots before importing a local legacy archive.
    let (owners, _) = net.list(&format!("sync-v2/{}/control/", g.vault)).await?;
    {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        let mut q = c
            .prepare("SELECT actor FROM imported_entry_heads WHERE target=?1")
            .map_err(err)?;
        for a in q
            .query_map([&target], |r| r.get::<_, String>(0))
            .map_err(err)?
        {
            if !owners.contains(&a.map_err(err)?) {
                return Err("已确认的导入歌单设备暂不可见，已保留本机资料".into());
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
                let rest = n.strip_prefix(PREFIX)?.strip_suffix(".head")?;
                let (seq, hash) = rest.split_once('-')?;
                if seq.len() != 20 || !causal::valid_hash(hash) {
                    return None;
                }
                Some((seq.parse::<u64>().ok()?, hash.to_string(), n))
            })
            .collect::<Vec<_>>();
        heads.sort();
        let known = {
            let c = db.0.lock().map_err(|_| "数据库正忙")?;
            c.query_row(
                "SELECT generation,hash FROM imported_entry_heads WHERE target=?1 AND actor=?2",
                params![target, actor],
                |r| Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(err)?
        };
        let Some((generation, hash, name)) = heads.last() else {
            if known.is_some() {
                return Err("导入歌单提交暂不可见".into());
            }
            continue;
        };
        if heads.iter().filter(|h| h.0 == *generation).count() != 1 {
            return Err("导入歌单提交发生分叉".into());
        }
        if let Some((old, old_hash)) = &known {
            if generation < old || generation == old && hash != old_hash {
                return Err("导入歌单同步水位回退或分叉".into());
            }
            if generation == old {
                continue;
            }
        }
        let head = net
            .get(&format!("{path}{name}"))
            .await?
            .ok_or("导入歌单提交暂不可见")?;
        if head.body != hash.as_bytes() {
            return Err("导入歌单提交摘要不符".into());
        }
        let body = net
            .get(&object(&g, hash))
            .await?
            .ok_or("导入歌单同步清单缺失")?;
        let manifest: Manifest = decode(
            &body.body,
            &Ref {
                hash: hash.clone(),
                bytes: body.body.len() as u64,
            },
        )?;
        validate_manifest(&manifest, &g)?;
        if manifest.actor != actor || manifest.generation != *generation {
            return Err("导入歌单提交身份无效".into());
        }
        let known_chunks = {
            let c = db.0.lock().map_err(|_| "数据库正忙")?;
            let mut q = c
                .prepare("SELECT hash FROM imported_entry_received WHERE target=?1")
                .map_err(err)?;
            q.query_map([&target], |r| r.get::<_, String>(0))
                .map_err(err)?
                .collect::<rusqlite::Result<BTreeSet<_>>>()
                .map_err(err)?
        };
        let mut packets = Vec::new();
        let mut seen_keys = BTreeSet::new();
        for r in &manifest.chunks {
            if known_chunks.contains(&r.hash) {
                let c = db.0.lock().map_err(|_| "数据库正忙")?;
                let mut q=c.prepare("SELECT entry_id FROM imported_entry_chunk_keys WHERE target=?1 AND hash=?2").map_err(err)?;
                for k in q
                    .query_map(params![target, r.hash], |r| r.get::<_, String>(0))
                    .map_err(err)?
                {
                    if !seen_keys.insert(k.map_err(err)?) {
                        return Err("导入歌单分块中条目重复".into());
                    }
                }
                continue;
            }
            let body = net
                .get(&object(&g, &r.hash))
                .await?
                .ok_or("导入歌单同步分块缺失")?;
            let chunk: Chunk = decode(&body.body, r)?;
            validate_chunk(&chunk, &g)?;
            for k in chunk.registers.keys() {
                if !seen_keys.insert(k.clone()) {
                    return Err("导入歌单分块中条目重复".into());
                }
            }
            packets.push((r.hash.clone(), chunk));
        }
        with(&|c| {
            for (hash, p) in &packets {
                repo::merge(c, &p.registers)?;
                c.execute(
                    "INSERT OR IGNORE INTO imported_entry_received VALUES(?1,?2)",
                    params![target, hash],
                )
                .map_err(err)?;
                for k in p.registers.keys() {
                    c.execute(
                        "INSERT OR IGNORE INTO imported_entry_chunk_keys VALUES(?1,?2,?3)",
                        params![target, hash, k],
                    )
                    .map_err(err)?;
                }
            }
            c.execute("INSERT INTO imported_entry_heads VALUES(?1,?2,?3,?4) ON CONFLICT(target,actor) DO UPDATE SET generation=excluded.generation,hash=excluded.hash",params![target,actor,generation,hash]).map_err(err)?;
            Ok(())
        })?;
    }
    // Migration may create local intent, but never overwrites a canonical remote slot.
    with(&|c| repo::migrate_all(c))?;
    with(&|c| {
        if publication(c, &target, "pending")?.is_some() {
            return Ok(());
        }
        let revision = runtime_revision(c)?;
        let old = publication(c, &target, "committed")?;
        if revision <= old.as_ref().map_or(0, |p| p.revision) {
            return Ok(());
        }
        let generation = old
            .as_ref()
            .filter(|p| p.manifest.actor == owner)
            .map_or(Ok(1), |p| {
                p.manifest
                    .generation
                    .checked_add(1)
                    .ok_or("导入歌单提交序号耗尽")
            })?;
        let frozen = freeze(c, &g, owner, generation, revision)?;
        c.execute("INSERT INTO imported_entry_publications(target,pending) VALUES(?1,?2) ON CONFLICT(target) DO UPDATE SET pending=excluded.pending",params![target,serde_json::to_string(&frozen).map_err(err)?]).map_err(err)?;
        Ok(())
    })?;
    let (pending, old) = {
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        (
            publication(&c, &target, "pending")?,
            publication(&c, &target, "committed")?,
        )
    };
    if let Some(p) = pending {
        validate_manifest(&p.manifest, &g)?;
        if reference(&p.body) != p.reference
            || serde_json::to_vec(&decode::<Manifest>(&p.body, &p.reference)?).map_err(err)?
                != serde_json::to_vec(&p.manifest).map_err(err)?
        {
            return Err("导入歌单待提交清单无效".into());
        }
        let old_refs = old
            .as_ref()
            .map(|p| {
                p.manifest
                    .chunks
                    .iter()
                    .map(|r| r.hash.clone())
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        for dir in [
            format!("sync-v2/{}/extensions/", g.vault),
            format!("sync-v2/{}/extensions/{NS}/", g.vault),
            format!("sync-v2/{}/control/{}/", g.vault, p.manifest.actor),
        ] {
            net.mkdir(&dir).await?;
        }
        for r in &p.manifest.chunks {
            if old_refs.contains(&r.hash) {
                continue;
            }
            let body = p.chunks.get(&r.hash).ok_or("导入歌单待提交分块缺失")?;
            validate_chunk(&decode::<Chunk>(body, r)?, &g)?;
            with(&|_| Ok(()))?;
            net.put(&object(&g, &r.hash), body.clone()).await?;
        }
        with(&|_| Ok(()))?;
        net.put(&object(&g, &p.reference.hash), p.body.clone())
            .await?;
        let path = format!(
            "sync-v2/{}/control/{}/{}",
            g.vault,
            p.manifest.actor,
            marker(&p.manifest, &p.reference.hash)
        );
        with(&|_| Ok(()))?;
        net.put(&path, p.reference.hash.as_bytes().to_vec()).await?;
        if net
            .get(&path)
            .await?
            .is_none_or(|b| b.body != p.reference.hash.as_bytes())
        {
            return Err("导入歌单提交尚未确认".into());
        }
        with(&|c| {
            let raw = serde_json::to_string(&p).map_err(err)?;
            c.execute("UPDATE imported_entry_publications SET pending=NULL,committed=?2 WHERE target=?1 AND pending=?2",params![target,raw]).map_err(err)?;
            c.execute("INSERT INTO imported_entry_heads VALUES(?1,?2,?3,?4) ON CONFLICT(target,actor) DO UPDATE SET generation=excluded.generation,hash=excluded.hash",params![target,p.manifest.actor,p.manifest.generation,p.reference.hash]).map_err(err)?;
            for r in &p.manifest.chunks {
                c.execute(
                    "INSERT OR IGNORE INTO imported_entry_received VALUES(?1,?2)",
                    params![target, r.hash],
                )
                .map_err(err)?;
                let chunk: Chunk = decode(p.chunks.get(&r.hash).ok_or("导入分块缺失")?, r)?;
                for k in chunk.registers.keys() {
                    c.execute(
                        "INSERT OR IGNORE INTO imported_entry_chunk_keys VALUES(?1,?2,?3)",
                        params![target, r.hash, k],
                    )
                    .map_err(err)?;
                }
            }
            Ok(())
        })?;
    }
    let c = db.0.lock().map_err(|_| "数据库正忙")?;
    Ok(before != serde_json::to_string(&repo::registers(&c, false)?).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repositories::library::TrackInput;
    use repo::{Change, SeedRow, Song};
    const LIST: &str = "import:11111111-1111-4111-8111-111111111111";
    fn device(cfg: &Config) -> Database {
        let root = std::env::temp_dir().join(format!("import-sync-test-{}", uuid::Uuid::new_v4()));
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
    fn seed(db: &Database, n: usize) {
        let c = db.0.lock().unwrap();
        repo::seed(
            &c,
            LIST,
            "源歌单",
            "qq",
            &(0..n)
                .map(|i| SeedRow {
                    order: i,
                    song: Song {
                        source_id: format!("qq:{i}"),
                        title: format!("第{i}首歌曲"),
                        artists: vec!["歌手".into()],
                        aliases: vec![],
                        duration_seconds: Some(240.0),
                        album: None,
                        cover_url: None,
                    },
                })
                .collect::<Vec<_>>(),
        )
        .unwrap()
    }
    fn edit(db: &Database, order: usize, cid: i64, mode: &str) {
        let c = db.0.lock().unwrap();
        let entry = repo::list(&c, LIST)
            .unwrap()
            .into_iter()
            .find(|r| r.order == order)
            .unwrap();
        repo::bind(
            &c,
            LIST,
            &[Change {
                entry_id: entry.entry_id,
                expected_revision: entry.revision,
                track: TrackInput {
                    id: format!("bilibili:BV1GJ411x7h7:{cid}"),
                    bvid: "BV1GJ411x7h7".into(),
                    aid: None,
                    cid,
                    page: 1,
                    source_title: format!("视频{cid}"),
                    source_title_context: None,
                    title: format!("视频{cid}"),
                    artist: None,
                    album: None,
                    cover_url: None,
                    duration_seconds: 240,
                    uploader_id: None,
                    uploader_name: None,
                },
                mode: mode.into(),
            }],
        )
        .unwrap()
    }
    async fn setup() -> (
        Config,
        Secret,
        std::sync::Arc<std::sync::Mutex<super::super::test_dav::Store>>,
        tokio::task::JoinHandle<()>,
    ) {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let g = Genesis::for_config(&cfg).unwrap();
        let net = Client::new(&cfg, &secret).unwrap();
        net.parents().await.unwrap();
        net.mkdir(&format!("sync-v2/{}/", g.vault)).await.unwrap();
        net.mkdir(&format!("sync-v2/{}/control/", g.vault))
            .await
            .unwrap();
        (cfg, secret, store, server)
    }
    #[tokio::test]
    async fn dav_restores_unmatched_slots_sparse_update_and_receiving_has_no_upload_echo() {
        let (cfg, secret, store, server) = setup().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let owner = uuid::Uuid::new_v4().to_string();
        let owner_b = uuid::Uuid::new_v4().to_string();
        seed(&a, 822);
        edit(&a, 0, 1, "automatic");
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        let g = Genesis::for_config(&cfg).unwrap();
        let net = Client::new(&cfg, &secret).unwrap();
        assert!(
            super::super::protocol_v2::discover(&net, &g.uid, &g.vault, &g.seed, &owner, 0)
                .await
                .unwrap()
                .is_none()
        );
        // Core playlist metadata arrives independently; receiving the extension never invents a deleted playlist.
        b.0.lock()
            .unwrap()
            .execute("INSERT INTO playlists(id,name) VALUES(?1,'源歌单')", [LIST])
            .unwrap();
        store.lock().unwrap().requests.clear();
        exchange(&b, &cfg, &secret, &owner_b).await.unwrap();
        assert_eq!(repo::list(&b.0.lock().unwrap(), LIST).unwrap().len(), 822);
        assert_eq!(
            repo::list(&b.0.lock().unwrap(), LIST).unwrap()[0].track_id,
            Some("bilibili:BV1GJ411x7h7:1".into())
        );
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(m, _)| m != "PUT")
        );
        edit(&a, 0, 2, "manual");
        store.lock().unwrap().requests.clear();
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        let writes = store
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(m, p)| m == "PUT" && p.contains("extensions/import-entries-v1/"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            writes.len(),
            2,
            "one <=100-slot chunk plus a small manifest, never the whole 822-song archive"
        );
        exchange(&b, &cfg, &secret, &owner_b).await.unwrap();
        assert_eq!(
            repo::list(&b.0.lock().unwrap(), LIST).unwrap()[0].track_id,
            Some("bilibili:BV1GJ411x7h7:2".into())
        );
        store.lock().unwrap().requests.clear();
        super::super::v2_net::discovery_round(async {
            let _ = net
                .list(&format!("sync-v2/{}/control/", g.vault))
                .await
                .unwrap();
            let _ = net
                .list(&format!("sync-v2/{}/control/{owner}/", g.vault))
                .await
                .unwrap();
            let count = store.lock().unwrap().requests.len();
            exchange(&a, &cfg, &secret, &owner).await.unwrap();
            assert_eq!(count, store.lock().unwrap().requests.len());
        })
        .await;
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap()
        }
    }
    #[tokio::test]
    async fn ambiguous_head_retries_exact_frozen_publication_before_newer_binding() {
        use super::super::test_dav::{Failure, Fault};
        let (cfg, secret, store, server) = setup().await;
        let a = device(&cfg);
        let owner = uuid::Uuid::new_v4().to_string();
        seed(&a, 3);
        edit(&a, 0, 1, "automatic");
        store.lock().unwrap().fault = Some(Fault {
            ordinal: None,
            method: Some("PUT".into()),
            contains: PREFIX.into(),
            failure: Failure::After(503),
        });
        assert!(exchange(&a, &cfg, &secret, &owner).await.is_err());
        let target =
            super::super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)
                .unwrap();
        let frozen = publication(&a.0.lock().unwrap(), &target, "pending")
            .unwrap()
            .unwrap();
        edit(&a, 0, 2, "manual");
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        let old = publication(&a.0.lock().unwrap(), &target, "committed")
            .unwrap()
            .unwrap();
        assert_eq!(frozen.reference, old.reference);
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        let latest = publication(&a.0.lock().unwrap(), &target, "committed")
            .unwrap()
            .unwrap();
        assert_ne!(latest.reference, old.reference);
        server.abort();
        std::fs::remove_dir_all(a.1).unwrap();
    }
    #[tokio::test]
    async fn concurrent_replacements_converge_and_deletion_survives_old_publications() {
        let (cfg, secret, _store, server) = setup().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let aa = uuid::Uuid::new_v4().to_string();
        let bb = uuid::Uuid::new_v4().to_string();
        seed(&a, 3);
        seed(&b, 3);
        edit(&a, 0, 1, "manual");
        exchange(&a, &cfg, &secret, &aa).await.unwrap();
        exchange(&b, &cfg, &secret, &bb).await.unwrap();
        edit(&a, 0, 2, "manual");
        edit(&b, 0, 3, "manual");
        exchange(&a, &cfg, &secret, &aa).await.unwrap();
        exchange(&b, &cfg, &secret, &bb).await.unwrap();
        exchange(&a, &cfg, &secret, &aa).await.unwrap();
        let ar = repo::list(&a.0.lock().unwrap(), LIST).unwrap();
        let br = repo::list(&b.0.lock().unwrap(), LIST).unwrap();
        assert_eq!(ar[0].track_id, br[0].track_id);
        assert_eq!(ar[0].revision, br[0].revision);
        let id = ar[0].track_id.as_deref().unwrap();
        repo::remove(&a.0.lock().unwrap(), LIST, Some(id)).unwrap();
        edit(&b, 0, 4, "manual");
        exchange(&b, &cfg, &secret, &bb).await.unwrap();
        exchange(&a, &cfg, &secret, &aa).await.unwrap();
        exchange(&b, &cfg, &secret, &bb).await.unwrap();
        assert_eq!(repo::list(&a.0.lock().unwrap(), LIST).unwrap().len(), 2);
        assert_eq!(repo::list(&b.0.lock().unwrap(), LIST).unwrap().len(), 2);
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap()
        }
    }
    #[tokio::test]
    async fn account_aba_during_network_read_cannot_merge_or_publish_into_new_session() {
        use super::super::test_dav::Gate;
        let (cfg, secret, store, server) = setup().await;
        let a = std::sync::Arc::new(device(&cfg));
        let owner = uuid::Uuid::new_v4().to_string();
        seed(&a, 3);
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        store.lock().unwrap().gate = Some(Gate {
            method: "PROPFIND".into(),
            contains: "/control/".into(),
            entered: entered.clone(),
            release: release.clone(),
        });
        let x = a.clone();
        let cc = cfg.clone();
        let ss = secret;
        let run = tokio::spawn(async move { exchange(&x, &cc, &ss, &owner).await });
        entered.notified().await;
        {
            let c = a.0.lock().unwrap();
            c.execute(
                "UPDATE account_session SET token=lower(hex(randomblob(16)))",
                [],
            )
            .unwrap();
        }
        release.notify_one();
        assert!(run.await.unwrap().is_err());
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(m, _)| m != "PUT")
        );
        server.abort();
        std::fs::remove_dir_all(&a.1).unwrap();
    }
    #[tokio::test]
    async fn complete_core_sync_receiving_bindings_has_no_intent_echo_and_keeps_user_metadata() {
        let (cfg, secret, store, server) = setup().await;
        let a = device(&cfg);
        let b = device(&cfg);
        seed(&a, 3);
        edit(&a, 0, 1, "automatic");
        assert!(
            super::super::engine::sync(&a, &cfg, &secret, None, false)
                .await
                .unwrap()
                .conflicts
                .is_empty()
        );
        assert!(
            super::super::engine::sync(&b, &cfg, &secret, None, false)
                .await
                .unwrap()
                .conflicts
                .is_empty()
        );
        let target =
            super::super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)
                .unwrap();
        let owner: String =
            a.0.lock()
                .unwrap()
                .query_row(
                    "SELECT actor FROM sync_v2_documents WHERE target=?1 AND domain='library'",
                    [&target],
                    |r| r.get(0),
                )
                .unwrap();
        edit(&a, 0, 2, "manual");
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        // B receives a new optional binding while the compatibility core mirror still says Track 1.
        super::super::engine::sync(&b, &cfg, &secret, None, false)
            .await
            .unwrap();
        let allocated = || {
            b.0.lock()
                .unwrap()
                .query_row(
                    "SELECT allocated FROM sync_v2_documents WHERE target=?1 AND domain='library'",
                    [&target],
                    |r| r.get::<_, u64>(0),
                )
                .unwrap()
        };
        let before = allocated();
        store.lock().unwrap().requests.clear();
        super::super::engine::sync(&b, &cfg, &secret, None, false)
            .await
            .unwrap();
        assert_eq!(
            allocated(),
            before,
            "received compatibility projection is not a new core edit"
        );
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(m, _)| m != "PUT"),
            "complete idle sync after receive must not upload an echo"
        );
        assert_eq!(
            repo::list(&b.0.lock().unwrap(), LIST).unwrap()[0].track_id,
            Some("bilibili:BV1GJ411x7h7:2".into())
        );
        super::super::engine::sync(&a, &cfg, &secret, None, false)
            .await
            .unwrap();
        super::super::engine::sync(&b, &cfg, &secret, None, false)
            .await
            .unwrap();
        b.0.lock().unwrap().execute("INSERT INTO metadata_overrides(track_id,title) VALUES('bilibili:BV1GJ411x7h7:2','用户明确修改')",[]).unwrap();
        super::super::engine::sync(&b, &cfg, &secret, None, false)
            .await
            .unwrap();
        assert!(
            allocated() > before,
            "explicit Track metadata edits still author core deltas"
        );
        super::super::engine::sync(&a, &cfg, &secret, None, false)
            .await
            .unwrap();
        assert_eq!(
            a.0.lock()
                .unwrap()
                .query_row(
                    "SELECT title FROM metadata_overrides WHERE track_id='bilibili:BV1GJ411x7h7:2'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "用户明确修改"
        );
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap()
        }
    }
    #[tokio::test]
    async fn imported_playlist_reorder_follows_slots_across_sync_and_rematching() {
        use crate::infrastructure::repositories::playlists::PlaylistRepository;

        let (cfg, secret, store, server) = setup().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let ids = |cids: &[i64]| {
            cids.iter()
                .map(|cid| format!("bilibili:BV1GJ411x7h7:{cid}"))
                .collect::<Vec<_>>()
        };
        let order = |db: &Database| {
            PlaylistRepository::tracks(&db.0.lock().unwrap(), LIST)
                .unwrap()
                .into_iter()
                .map(|track| track.id)
                .collect::<Vec<_>>()
        };
        seed(&a, 3);
        edit(&a, 0, 1, "automatic");
        edit(&a, 2, 3, "automatic");
        for db in [&a, &b] {
            super::super::engine::sync(db, &cfg, &secret, None, false)
                .await
                .unwrap();
            assert_eq!(order(db), ids(&[1, 3]));
        }
        {
            let mut c = a.0.lock().unwrap();
            assert!(
                PlaylistRepository::reorder(&mut c, &a.1, LIST, &ids(&[1, 3]), &ids(&[3, 1]))
                    .unwrap()
            );
            assert!(
                !PlaylistRepository::reorder(&mut c, &a.1, LIST, &ids(&[1, 3]), &ids(&[3, 1]))
                    .unwrap()
            );
            let snapshot = super::super::storage::export(&c, &cfg.uid, cfg.history).unwrap();
            assert_eq!(
                snapshot.records[&format!("item:{LIST}|{}", ids(&[1])[0])].fields["position"],
                0
            );
            assert_eq!(
                snapshot.records[&format!("item:{LIST}|{}", ids(&[3])[0])].fields["position"],
                2
            );
        }
        assert_eq!(order(&a), ids(&[3, 1]));
        // The other device still sees the import order when it fills the gap
        // and changes the video for a song that was moved on the first device.
        edit(&b, 1, 2, "automatic");
        edit(&b, 2, 4, "manual");
        assert_eq!(order(&b), ids(&[1, 2, 4]));
        for db in [&a, &b, &a] {
            let report = super::super::engine::sync(db, &cfg, &secret, None, false)
                .await
                .unwrap();
            assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
            assert_eq!(report.import_error, None);
            assert_eq!(report.favorite_order_error, None);
        }
        for db in [&a, &b] {
            assert_eq!(order(db), ids(&[4, 2, 1]));
            let entries = repo::list(&db.0.lock().unwrap(), LIST).unwrap();
            assert_eq!(
                entries.iter().map(|entry| entry.order).collect::<Vec<_>>(),
                [0, 1, 2]
            );
        }
        store.lock().unwrap().requests.clear();
        super::super::engine::sync(&b, &cfg, &secret, None, false)
            .await
            .unwrap();
        assert!(
            store.lock().unwrap().requests.iter().all(|(method, path)| {
                method != "PUT" || !path.contains("import-playlist-order")
            }),
            "receiving an order did not author a new order"
        );
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap()
        }
    }

    #[tokio::test]
    async fn manifest_duplicate_across_cached_and_new_chunk_is_rejected_atomically() {
        let (cfg, secret, store, server) = setup().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let owner = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        seed(&a, 80);
        exchange(&a, &cfg, &secret, &owner).await.unwrap();
        b.0.lock()
            .unwrap()
            .execute("INSERT INTO playlists(id,name) VALUES(?1,'歌单')", [LIST])
            .unwrap();
        exchange(&b, &cfg, &secret, &other).await.unwrap();
        let before = repo::registers(&b.0.lock().unwrap(), false).unwrap();
        let g = Genesis::for_config(&cfg).unwrap();
        let target =
            super::super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)
                .unwrap();
        let frozen = publication(&a.0.lock().unwrap(), &target, "committed")
            .unwrap()
            .unwrap();
        let mut chunk = frozen
            .manifest
            .chunks
            .iter()
            .map(|r| decode::<Chunk>(&frozen.chunks[&r.hash], r).unwrap())
            .find(|p| p.registers.len() > 1)
            .unwrap();
        let first = chunk.registers.first_key_value().unwrap().0.clone();
        chunk.registers.retain(|k, _| k == &first);
        let bytes = super::super::protocol_v2::encode(&chunk).unwrap();
        let reference = reference(&bytes);
        let mut manifest = frozen.manifest;
        manifest.generation += 1;
        manifest.chunks.push(reference.clone());
        let mbytes = super::super::protocol_v2::encode(&manifest).unwrap();
        let mref = super::reference(&mbytes);
        let net = Client::new(&cfg, &secret).unwrap();
        net.put(&object(&g, &reference.hash), bytes).await.unwrap();
        net.put(&object(&g, &mref.hash), mbytes).await.unwrap();
        net.put(
            &format!(
                "sync-v2/{}/control/{owner}/{}",
                g.vault,
                marker(&manifest, &mref.hash)
            ),
            mref.hash.as_bytes().to_vec(),
        )
        .await
        .unwrap();
        assert!(
            exchange(&b, &cfg, &secret, &other)
                .await
                .unwrap_err()
                .contains("条目重复")
        );
        assert_eq!(
            repo::registers(&b.0.lock().unwrap(), false).unwrap(),
            before
        );
        assert_eq!(
            b.0.lock()
                .unwrap()
                .query_row(
                    "SELECT generation FROM imported_entry_heads WHERE target=?1 AND actor=?2",
                    params![target, owner],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            1
        );
        assert!(!store.lock().unwrap().files.is_empty());
        server.abort();
        for db in [a, b] {
            std::fs::remove_dir_all(db.1).unwrap()
        }
    }
}
