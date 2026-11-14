//! Per-source cumulative cells over the shared immutable v2 transport. Max, never sum,
//! reconciles multiple cached copies of the SAME contribution; different sources sum in SQL.
use super::{
    Config, Database,
    actor::Lease,
    causal::{self, Candidate, Cell, Context, Document, Domain, Dot, Register},
    engine,
    migration::Genesis,
    outbox,
    projection::Facts,
    protocol_v2::{self, Head},
    publication,
    statistics::{self, Bucket},
    transport::Secret,
    v2_net::Client,
};
use base64::Engine;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Serialize, Deserialize)]
struct State {
    instance: String,
    genesis: Genesis,
    seed: bool,
    observed: Facts,
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
fn writer(db: &Database, target: &str, state: &State) -> Result<Lease, String> {
    let installation = engine::installation(&db.1)?;
    Lease::open(
        &db.1
            .join("statistics-v2")
            .join(target)
            .join(format!("{installation}-{}", state.instance)),
        &state.instance,
    )
}
fn field(group: &str, key: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    format!(
        "{group}:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.as_ref())
    )
}
fn bucket_facts(bucket: &Bucket, cutoff: &str) -> Result<Facts, String> {
    if !statistics::valid(bucket, &bucket.uid) {
        return Err("本机统计来源无效".into());
    }
    let entity = format!("statistics:{}:{}", bucket.source, bucket.month);
    let mut cells = Facts::from([
        (causal::key(&entity, "__present"), Cell::Value(true.into())),
        (
            causal::key(&entity, "revision"),
            Cell::Value(json!(bucket.revision)),
        ),
    ]);
    for (group, map, milliseconds) in [
        ("t", &bucket.tracks, true),
        ("d", &bucket.days, true),
        ("p", &bucket.plays, false),
        ("q", &bucket.day_plays, false),
    ] {
        for (key, value) in map {
            let value = if milliseconds {
                (value * 1000.0).round()
            } else {
                *value
            };
            if !value.is_finite() || value < 0.0 || value > 9_007_199_254_740_990.0 {
                return Err("统计累计值超限".into());
            }
            cells.insert(
                causal::key(&entity, &field(group, key)),
                Cell::Value(json!([key, value as u64])),
            );
        }
    }
    for (group, map, milliseconds) in [
        ("x", &bucket.daily, true),
        ("y", &bucket.daily_plays, false),
    ] {
        for (day, tracks) in map {
            if day.as_str() < cutoff {
                continue;
            }
            for (track, value) in tracks {
                let key = serde_json::to_string(&(day, track)).map_err(err)?;
                let value = if milliseconds {
                    (value * 1000.0).round()
                } else {
                    *value
                };
                if !value.is_finite() || value < 0.0 || value > 9_007_199_254_740_990.0 {
                    return Err("统计采样累计超限".into());
                }
                cells.insert(
                    causal::key(&entity, &field(group, &key)),
                    Cell::Value(json!([key, value as u64])),
                );
            }
        }
    }
    for (key, name) in &bucket.names {
        cells.insert(
            causal::key(&entity, &field("n", key)),
            Cell::Value(json!([key, name])),
        );
    }
    Ok(cells)
}
fn legacy_document(g: &Genesis, buckets: &[Bucket], cutoff: &str) -> Result<Document, String> {
    let mut doc = Document::empty(g.scope(Domain::Statistics));
    for b in buckets {
        if b.uid != g.uid {
            return Err("统计迁移账号不一致".into());
        }
        for (key, cell) in bucket_facts(b, cutoff)? {
            let (_, f): (String, String) = serde_json::from_str(&key).map_err(err)?;
            // Counter identity is its cumulative value, not a package revision. Pruning a
            // cached copy cannot make the same revision mean a different counter value.
            let seq = if f.starts_with("n:") || f == "revision" {
                b.revision.max(1)
            } else if f == "__present" {
                1
            } else {
                if let Cell::Value(value) = &cell {
                    value[1]
                        .as_u64()
                        .ok_or("统计单元无效")?
                        .checked_add(1)
                        .ok_or("统计单元超限")?
                } else {
                    1
                }
            };
            let dot = Dot {
                actor: format!("legacy:{}", b.source),
                seq,
            };
            let seen = Context(BTreeMap::from([(dot.actor.clone(), vec![(1, seq)])]));
            doc.registers.entry(key).or_default().merge(&Register {
                seen,
                values: vec![Candidate { dot, cell }],
            })?;
        }
    }
    if !doc.valid() {
        return Err("统计迁移因果状态无效".into());
    }
    Ok(doc)
}
async fn legacy(net: &Client<'_>, uid: &str) -> Result<Vec<Bucket>, String> {
    #[derive(Deserialize)]
    struct Index {
        months: BTreeMap<String, u64>,
    }
    let (names, _) = net.list("statistics-v1/").await?;
    let mut result = vec![];
    let sources = names
        .into_iter()
        .filter_map(|n| {
            n.strip_prefix("index-")
                .and_then(|s| s.strip_suffix(".json"))
                .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                .map(str::to_owned)
        })
        .collect::<BTreeSet<_>>();
    if sources.len() > 100 {
        return Err("旧统计来源超过上限".into());
    }
    for source in sources {
        let index = net
            .get(&format!("statistics-v1/index-{source}.json"))
            .await?
            .ok_or("旧统计索引暂不可见")?;
        let index: Index = serde_json::from_slice(&index.body).map_err(|_| "旧统计索引无效")?;
        if index.months.len() > 1200 {
            return Err("旧统计月份超限".into());
        }
        for (month, revision) in index.months {
            if month != "baseline"
                && !(month.len() == 7
                    && month.as_bytes()[4] == b'-'
                    && month
                        .bytes()
                        .enumerate()
                        .all(|(i, c)| i == 4 || c.is_ascii_digit()))
            {
                return Err("旧统计月份无效".into());
            }
            let object = net
                .get(&format!("statistics-v1/{source}/{month}.json.gz"))
                .await?
                .ok_or("旧统计月份暂不可见")?;
            let bucket = statistics::decode(&object.body, uid)?;
            if bucket.source != source || bucket.month != month || bucket.revision < revision {
                return Err("旧统计来源版本不符".into());
            }
            result.push(bucket);
        }
    }
    Ok(result)
}
fn materialize(doc: &Document, cutoff: &str) -> Result<Vec<Bucket>, String> {
    let mut result: BTreeMap<String, Bucket> = BTreeMap::new();
    for (key, register) in &doc.registers {
        let (entity, f): (String, String) = serde_json::from_str(key).map_err(err)?;
        let tail = entity
            .strip_prefix("statistics:")
            .ok_or("统计实体类型无效")?;
        let (source, month) = tail.split_once(':').ok_or("统计实体身份无效")?;
        if uuid::Uuid::parse_str(source).is_err() {
            return Err("统计来源身份无效".into());
        }
        let bucket = result.entry(entity.clone()).or_insert_with(|| Bucket {
            schema: 1,
            uid: doc.scope.uid.clone(),
            source: source.into(),
            month: month.into(),
            ..Default::default()
        });
        if f == "__present" {
            continue;
        }
        if f == "revision" {
            bucket.revision = register
                .values
                .iter()
                .filter_map(|v| {
                    if let Cell::Value(v) = &v.cell {
                        v.as_u64()
                    } else {
                        None
                    }
                })
                .max()
                .unwrap_or(0);
            continue;
        }
        let (group, _) = f.split_once(':').ok_or("统计字段无效")?;
        let values = register
            .values
            .iter()
            .filter_map(|v| {
                if let Cell::Value(v) = &v.cell {
                    Some(v)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let numeric = group != "n";
        let chosen = if numeric {
            values
                .into_iter()
                .max_by_key(|v| v.get(1).and_then(Value::as_u64).unwrap_or(0))
        } else {
            values.into_iter().last()
        };
        let Some(value) = chosen else { continue };
        let key = value
            .get(0)
            .and_then(Value::as_str)
            .ok_or("统计字段键无效")?;
        if field(group, key) != f {
            return Err("统计字段摘要不符".into());
        }
        if group == "n" {
            bucket.names.insert(
                key.into(),
                serde_json::from_value(value[1].clone()).map_err(|_| "统计歌曲名称无效")?,
            );
            continue;
        }
        let integer = value
            .get(1)
            .and_then(Value::as_u64)
            .filter(|n| *n <= 9_007_199_254_740_990)
            .ok_or("统计累计值无效")?;
        let seconds = integer as f64
            / if matches!(group, "t" | "d" | "x") {
                1000.0
            } else {
                1.0
            };
        match group {
            "t" => {
                bucket.tracks.insert(key.into(), seconds);
            }
            "d" => {
                bucket.days.insert(key.into(), seconds);
            }
            "p" => {
                bucket.plays.insert(key.into(), seconds);
            }
            "q" => {
                bucket.day_plays.insert(key.into(), seconds);
            }
            "x" | "y" => {
                let (day, track): (String, String) =
                    serde_json::from_str(key).map_err(|_| "统计逐日字段无效")?;
                if day.as_str() >= cutoff {
                    let map = if group == "x" {
                        &mut bucket.daily
                    } else {
                        &mut bucket.daily_plays
                    };
                    map.entry(day).or_default().insert(track, seconds);
                }
            }
            _ => return Err("统计字段类别无效".into()),
        }
    }
    for bucket in result.values() {
        if !statistics::valid(bucket, &doc.scope.uid) {
            return Err("合并统计状态无效".into());
        }
    }
    Ok(result.into_values().collect())
}
fn maximum(into: &mut Bucket, other: &Bucket) {
    for (a, b) in [
        (&mut into.tracks, &other.tracks),
        (&mut into.days, &other.days),
        (&mut into.plays, &other.plays),
        (&mut into.day_plays, &other.day_plays),
    ] {
        for (k, v) in b {
            a.entry(k.clone())
                .and_modify(|old| *old = old.max(*v))
                .or_insert(*v);
        }
    }
    for (a, b) in [
        (&mut into.daily, &other.daily),
        (&mut into.daily_plays, &other.daily_plays),
    ] {
        for (day, tracks) in b {
            for (id, v) in tracks {
                a.entry(day.clone())
                    .or_default()
                    .entry(id.clone())
                    .and_modify(|old| *old = old.max(*v))
                    .or_insert(*v);
            }
        }
    }
    into.names.extend(other.names.clone());
    into.revision = into.revision.max(other.revision);
}
fn cutoff(c: &Connection) -> Result<String, String> {
    c.query_row("SELECT date('now','+8 hours','-90 days')", [], |r| r.get(0))
        .map_err(err)
}
fn owned(c: &Connection, uid: &str, cutoff: &str) -> Result<Facts, String> {
    let own = statistics::meta(c, "source")?.ok_or("本机统计来源丢失")?;
    let mut facts = Facts::new();
    for b in statistics::buckets(c)?
        .into_iter()
        .filter(|b| b.source == own)
    {
        if b.uid != uid {
            return Err("统计来源账号无效".into());
        }
        facts.extend(bucket_facts(&b, cutoff)?);
    }
    Ok(facts)
}
fn capture(
    c: &Connection,
    cfg: &Config,
    target: &str,
    state: &mut State,
    lease: &mut Lease,
) -> Result<(), String> {
    let current = owned(c, &cfg.uid, &cutoff(c)?)?;
    let mut delta = Facts::new();
    for key in state
        .observed
        .keys()
        .chain(current.keys())
        .collect::<BTreeSet<_>>()
    {
        if state.observed.get(key) != current.get(key) {
            delta.insert(
                key.clone(),
                current.get(key).cloned().unwrap_or(Cell::Missing),
            );
        }
    }
    if !delta.is_empty() {
        outbox::mutate_in_transaction(c, target, Domain::Statistics, lease, None, |_| {
            Ok(((), delta))
        })?;
    }
    state.observed = current;
    engine::put(c, target, "statistics-runtime", state)
}
fn ensure(
    c: &Connection,
    directory: &std::path::Path,
    target: &str,
    state: &mut State,
) -> Result<Lease, String> {
    let (lease, recovered) = super::recovery::ensure(
        c,
        directory,
        "statistics-v2",
        target,
        &mut state.instance,
        &[Domain::Statistics],
        &mut BTreeMap::new(),
    )?;
    if recovered {
        c.execute("UPDATE listening_buckets SET owned=0,dirty=0", [])
            .map_err(err)?;
        statistics::put_meta(c, "source", &uuid::Uuid::new_v4().to_string())?;
        state.observed = Facts::new();
    }
    engine::put(c, target, "statistics-runtime", state)?;
    Ok(lease)
}
/// Check the external writer fence before adding a new sample to a restored source counter.
pub(super) fn ensure_recording_identity(
    c: &Connection,
    directory: &std::path::Path,
    uid: &str,
) -> Result<(), String> {
    let config = super::config_from_connection(c)?;
    let Some(cfg) = config.filter(|cfg| cfg.uid == uid && cfg.provider == "webdav") else {
        return Ok(());
    };
    let target: Option<String> = c
        .query_row(
            "SELECT value FROM sync_info WHERE key='active_target'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let Some(target) = target else { return Ok(()) };
    let Some(mut state) = engine::get::<State>(c, &target, "statistics-runtime")? else {
        return Ok(());
    };
    if state.genesis != Genesis::for_config(&cfg)? {
        return Err("统计写入身份与目标不一致".into());
    }
    c.execute_batch("SAVEPOINT statistics_writer")
        .map_err(err)?;
    match ensure(c, directory, &target, &mut state) {
        Ok(_) => c.execute_batch("RELEASE statistics_writer").map_err(err),
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK TO statistics_writer; RELEASE statistics_writer");
            Err(e)
        }
    }
}
pub async fn exchange(db: &Database, cfg: &Config, secret: &Secret) -> Result<(), String> {
    let target = super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
    with(db, cfg, |c| engine::bind_target(c, cfg, &target))?;
    let net = Client::cached(cfg, secret, db.1.join("sync-v2-cache").join(&target))?;
    let g = Genesis::for_config(cfg)?;
    with(db, cfg, |c| {
        let tx = c.unchecked_transaction().map_err(err)?;
        statistics::init(c, &db.1, &cfg.uid)?;
        tx.commit().map_err(err)
    })?;
    let known: BTreeMap<String, Head> = with(db, cfg, |c| {
        Ok(engine::get(c, &target, "statistics-heads")?.unwrap_or_default())
    })?;
    let remote_heads = engine::heads(&net, &g, &known).await?;
    let existing = remote_heads
        .values()
        .any(|h| h.domains.contains_key(&Domain::Statistics));
    let mut state: Option<State> =
        with(db, cfg, |c| engine::get(c, &target, "statistics-runtime"))?;
    if state.is_none() {
        let day = with(db, cfg, cutoff)?;
        let mut seed = Document::empty(g.scope(Domain::Statistics));
        if !existing {
            seed.join(&legacy_document(&g, &legacy(&net, &cfg.uid).await?, &day)?)?;
        }
        seed = engine::receive_domain(&net, seed, &remote_heads, &BTreeMap::new()).await?;
        // Cached copies are imported only once, preserving their original source identity.
        let local = with(db, cfg, statistics::buckets)?;
        let imported = legacy_document(&g, &local, &day)?;
        let before = seed.clone();
        seed.join(&imported)?;
        let runtime = State {
            instance: uuid::Uuid::new_v4().to_string(),
            genesis: g.clone(),
            seed: !existing || seed != before,
            observed: Facts::new(),
        };
        let lease = writer(db, &target, &runtime)?;
        with(db, cfg, |c| {
            let tx = c.unchecked_transaction().map_err(err)?;
            outbox::initialize(c, &target, &lease, &seed)?;
            engine::put(c, &target, "statistics-runtime", &runtime)?;
            tx.commit().map_err(err)
        })?;
        state = Some(runtime);
    }
    let mut state = state.unwrap();
    if state.genesis != g {
        return Err("统计同步目标身份无效".into());
    }
    let mut lease = with(db, cfg, |c| {
        let tx = c.unchecked_transaction().map_err(err)?;
        let lease = ensure(c, &db.1, &target, &mut state)?;
        tx.commit().map_err(err)?;
        Ok(lease)
    })?;
    with(db, cfg, |c| {
        let tx = c.unchecked_transaction().map_err(err)?;
        capture(c, cfg, &target, &mut state, &mut lease)?;
        tx.commit().map_err(err)
    })?;
    net.parents().await?;
    // Always replay a lost reply before constructing another generation.
    if let Some(p) = with(db, cfg, |c| publication::pending(c, &target, lease.actor()))? {
        p.publish(&net).await?;
        with(db, cfg, |c| publication::acknowledge(c, &target, &p))?;
    }
    let plan = with(db, cfg, |c| {
        let head = publication::committed(c, &target, lease.actor())?;
        let generation = head.as_ref().map_or(0, |h| h.generation) + 1;
        let other = head.as_ref().map(|h| h.domains.clone()).unwrap_or_default();
        let confirmed = outbox::confirmed(c, &target, Domain::Statistics)?;
        let overlay = outbox::overlay(c, &target, Domain::Statistics)?;
        let queue = outbox::pending(c, &target, Domain::Statistics)?;
        let previous = publication::manifest(c, &target, lease.actor(), Domain::Statistics)?;
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
        } else if state.seed && head.is_none() {
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
            publication::save(c, &target, &mut lease, p)?;
        }
        Ok(p)
    })?;
    if let Some(p) = plan {
        p.publish(&net).await?;
        with(db, cfg, |c| publication::acknowledge(c, &target, &p))?;
    }
    state.seed = false;
    with(db, cfg, |c| {
        engine::put(c, &target, "statistics-runtime", &state)
    })?;
    let remote_heads = engine::heads(&net, &g, &known).await?;
    let confirmed = with(db, cfg, |c| {
        outbox::confirmed(c, &target, Domain::Statistics)
    })?;
    let remote = engine::receive_domain(&net, confirmed, &remote_heads, &known).await?;
    with(db, cfg, |c| {
        let tx = c.unchecked_transaction().map_err(err)?;
        capture(c, cfg, &target, &mut state, &mut lease)?;
        let mut confirmed = outbox::confirmed(c, &target, Domain::Statistics)?;
        confirmed.join(&remote)?;
        c.execute(
            "UPDATE sync_v2_documents SET confirmed=?2 WHERE target=?1 AND domain='statistics'",
            params![target, serde_json::to_string(&confirmed).map_err(err)?],
        )
        .map_err(err)?;
        let all = outbox::overlay(c, &target, Domain::Statistics)?;
        let day = cutoff(c)?;
        let own = statistics::meta(c, "source")?.ok_or("统计来源丢失")?;
        for mut b in materialize(&all, &day)? {
            if let Some(local) = statistics::load(c, &b.source, &b.month)? {
                maximum(&mut b, &local);
            }
            b.daily.retain(|d, _| d >= &day);
            b.daily_plays.retain(|d, _| d >= &day);
            let owned = b.source == own;
            let committed_revision = confirmed
                .registers
                .get(&causal::key(
                    &format!("statistics:{}:{}", b.source, b.month),
                    "revision",
                ))
                .and_then(|r| {
                    r.values
                        .iter()
                        .filter_map(|v| {
                            if let Cell::Value(v) = &v.cell {
                                v.as_u64()
                            } else {
                                None
                            }
                        })
                        .max()
                })
                .unwrap_or(0);
            let dirty = owned && b.revision > committed_revision;
            statistics::save(c, &b, owned, dirty)?;
        }
        state.observed = owned(c, &cfg.uid, &day)?;
        engine::put(c, &target, "statistics-runtime", &state)?;
        engine::put(c, &target, "statistics-heads", &remote_heads)?;
        statistics::put_meta(c, "last_target", &super::statistics::v2_endpoint(cfg)?)?;
        let now: String = c
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| {
                r.get(0)
            })
            .map_err(err)?;
        statistics::put_meta(c, "last_success", &now)?;
        statistics::put_meta(c, "error", "")?;
        tx.commit().map_err(err)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device(cfg: &Config) -> Database {
        let path = std::env::temp_dir().join(format!("stats-v2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("active-profile"), &cfg.uid).unwrap();
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute(
            "INSERT INTO sync_settings VALUES(1,?1)",
            [serde_json::to_string(cfg).unwrap()],
        )
        .unwrap();
        statistics::init(&c, &path, &cfg.uid).unwrap();
        Database(std::sync::Mutex::new(c), path)
    }
    fn add(db: &Database, cfg: &Config, seconds: f64) {
        let c = db.0.lock().unwrap();
        let source = statistics::init(&c, &db.1, &cfg.uid).unwrap();
        let day: String = c
            .query_row("SELECT date('now','+8 hours')", [], |r| r.get(0))
            .unwrap();
        let month = &day[..7];
        let mut bucket = statistics::load(&c, &source, month)
            .unwrap()
            .unwrap_or(Bucket {
                schema: 1,
                uid: cfg.uid.clone(),
                source: source.clone(),
                month: month.into(),
                ..Default::default()
            });
        *bucket.days.entry(day.clone()).or_default() += seconds;
        *bucket.tracks.entry("bilibili:BV1:1".into()).or_default() += seconds;
        *bucket
            .daily
            .entry(day)
            .or_default()
            .entry("bilibili:BV1:1".into())
            .or_default() += seconds;
        bucket.revision += 1;
        statistics::save(&c, &bucket, true, true).unwrap();
    }
    fn total(db: &Database, cfg: &Config) -> f64 {
        statistics::query(&db.0.lock().unwrap(), &db.1, &cfg.uid).unwrap()["total"]["seconds"]
            .as_f64()
            .unwrap()
    }
    #[tokio::test]
    async fn three_devices_deduplicate_cached_sources_merge_own_counters_and_recover_lost_reply() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        let c = device(&cfg);
        add(&a, &cfg, 60.125);
        add(&b, &cfg, 40.875);
        exchange(&a, &cfg, &secret).await.unwrap();
        exchange(&b, &cfg, &secret).await.unwrap();
        exchange(&c, &cfg, &secret).await.unwrap();
        exchange(&a, &cfg, &secret).await.unwrap();
        assert_eq!(total(&a, &cfg), 101.0);
        assert_eq!(total(&b, &cfg), 101.0);
        assert_eq!(total(&c, &cfg), 101.0);
        store.lock().unwrap().requests.clear();
        add(&a, &cfg, 30.0);
        add(&b, &cfg, 20.0);
        store.lock().unwrap().fail_head_once = true;
        assert!(exchange(&a, &cfg, &secret).await.is_err());
        add(&a, &cfg, 5.0);
        exchange(&a, &cfg, &secret).await.unwrap();
        exchange(&b, &cfg, &secret).await.unwrap();
        exchange(&c, &cfg, &secret).await.unwrap();
        exchange(&a, &cfg, &secret).await.unwrap();
        assert_eq!(total(&a, &cfg), 156.0);
        assert_eq!(total(&b, &cfg), 156.0);
        assert_eq!(total(&c, &cfg), 156.0);
        let before = store.lock().unwrap().files.len();
        exchange(&c, &cfg, &secret).await.unwrap();
        assert_eq!(store.lock().unwrap().files.len(), before);
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(_, path)| !path.contains("statistics-v1"))
        );
        // Statistics may initialize first; the library must still bootstrap its own domain.
        assert!(
            super::super::engine::sync(&a, &cfg, &secret, None, false)
                .await
                .unwrap()
                .conflicts
                .is_empty()
        );
        for d in [a, b, c] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
    #[tokio::test]
    async fn copied_old_statistics_import_once_and_restored_source_rotates_before_new_samples() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let a = device(&cfg);
        let b = device(&cfg);
        add(&a, &cfg, 60.0);
        // The second old installation has only a cached copy of the first contribution.
        for bucket in statistics::buckets(&a.0.lock().unwrap()).unwrap() {
            statistics::save(&b.0.lock().unwrap(), &bucket, false, false).unwrap();
        }
        exchange(&a, &cfg, &secret).await.unwrap();
        exchange(&b, &cfg, &secret).await.unwrap();
        assert_eq!(total(&b, &cfg), 60.0);
        let target =
            super::super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)
                .unwrap();
        a.0.lock()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO sync_info VALUES('active_target',?1)",
                [&target],
            )
            .unwrap();
        let path = a.1.join("restore.sqlite");
        a.0.lock()
            .unwrap()
            .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        add(&a, &cfg, 15.0);
        exchange(&a, &cfg, &secret).await.unwrap();
        *a.0.lock().unwrap() = Connection::open(path).unwrap();
        let before = statistics::meta(&a.0.lock().unwrap(), "source")
            .unwrap()
            .unwrap();
        // Use the actual recording entry point: a post-restore sample cannot advance
        // an older cumulative counter under the original source identity.
        statistics::record(
            &a.0.lock().unwrap(),
            &a.1,
            &cfg.uid,
            "bilibili:BV1:1",
            10.0,
            None,
            None,
        )
        .unwrap();
        assert_ne!(
            before,
            statistics::meta(&a.0.lock().unwrap(), "source")
                .unwrap()
                .unwrap()
        );
        exchange(&a, &cfg, &secret).await.unwrap();
        exchange(&b, &cfg, &secret).await.unwrap();
        assert_eq!(total(&a, &cfg), 85.0);
        assert_eq!(total(&b, &cfg), 85.0);
        let put_before = store
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(m, _)| m == "PUT")
            .count();
        exchange(&a, &cfg, &secret).await.unwrap();
        exchange(&b, &cfg, &secret).await.unwrap();
        assert_eq!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|(m, _)| m == "PUT")
                .count(),
            put_before
        );
        for d in [a, b] {
            std::fs::remove_dir_all(d.1).unwrap();
        }
        server.abort();
    }
}
