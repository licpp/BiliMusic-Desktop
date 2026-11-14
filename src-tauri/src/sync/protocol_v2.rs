//! Content-addressed objects and immutable commit markers. Old PUTs cannot overwrite newer heads.
use super::causal::{self, Batch, Document, Domain, Scope};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
};
pub const MAX_INFLATED: usize = 32 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRef {
    pub hash: String,
    pub bytes: u64,
    pub first_seq: u64,
    pub last_seq: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub scope: Scope,
    pub actor: String,
    pub checkpoint: ObjectRef,
    pub tail: Vec<ObjectRef>,
}
impl Manifest {
    pub fn last_seq(&self) -> u64 {
        self.tail
            .last()
            .map_or(self.checkpoint.last_seq, |b| b.last_seq)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != 2
            || !self.scope.valid()
            || uuid::Uuid::parse_str(&self.actor).is_err()
            || self.tail.len() > 4096
            || self.checkpoint.first_seq != 0
        {
            return Err("增量清单格式无效".into());
        }
        let mut previous = self.checkpoint.last_seq;
        for r in std::iter::once(&self.checkpoint).chain(&self.tail) {
            if !causal::valid_hash(&r.hash) || r.bytes > 12 * 1024 * 1024 {
                return Err("同步对象摘要或大小无效".into());
            }
        }
        for b in &self.tail {
            if previous.checked_add(1) != Some(b.first_seq) || b.last_seq < b.first_seq {
                return Err("增量清单存在序列缺口".into());
            }
            previous = b.last_seq;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainHead {
    pub self_seq: u64,
    pub manifest_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Head {
    pub schema: u32,
    pub uid: String,
    pub vault: String,
    pub seed: String,
    pub actor: String,
    pub generation: u64,
    pub domains: BTreeMap<Domain, DomainHead>,
}
impl Head {
    pub fn filename(&self) -> Result<String, String> {
        if self.uid.is_empty()
            || !self.uid.bytes().all(|c| c.is_ascii_digit())
            || self.domains.len() > 3
            || self.generation == 0
            || self.schema != 2
            || uuid::Uuid::parse_str(&self.actor).is_err()
            || uuid::Uuid::parse_str(&self.vault).is_err()
            || !causal::valid_hash(&self.seed)
            || self.domains.is_empty()
            || self
                .domains
                .values()
                .any(|h| !causal::valid_hash(&h.manifest_hash))
        {
            return Err("同步提交记录无效".into());
        }
        Ok(format!(
            "{:020}-{}.json",
            self.generation,
            causal::hash(&serde_json::to_vec(self).map_err(|_| "提交编码失败")?)
        ))
    }
}
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let raw = serde_json::to_vec(value).map_err(|_| "同步对象编码失败")?;
    if raw.len() > MAX_INFLATED {
        return Err("同步对象解压大小超限".into());
    }
    let mut zip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    zip.write_all(&raw).map_err(|_| "同步对象压缩失败")?;
    let result = zip.finish().map_err(|_| "同步对象压缩失败")?;
    if result.len() > 12 * 1024 * 1024 {
        return Err("同步对象压缩大小超限".into());
    }
    Ok(result)
}
pub fn decode<T: DeserializeOwned>(body: &[u8], expected: &ObjectRef) -> Result<T, String> {
    if body.len() as u64 != expected.bytes || causal::hash(body) != expected.hash {
        return Err("同步对象摘要不符".into());
    }
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(body)
        .take(MAX_INFLATED as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "同步对象解压失败")?;
    if raw.len() > MAX_INFLATED {
        return Err("同步对象解压大小超限".into());
    }
    serde_json::from_slice(&raw).map_err(|_| "同步对象内容无效".into())
}
fn reference(body: &[u8], first: u64, last: u64) -> ObjectRef {
    ObjectRef {
        hash: causal::hash(body),
        bytes: body.len() as u64,
        first_seq: first,
        last_seq: last,
    }
}
fn domain(d: Domain) -> &'static str {
    match d {
        Domain::Library => "library",
        Domain::Progress => "progress",
        Domain::Statistics => "statistics",
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publication {
    pub head: Head,
    pub manifest: Manifest,
    pub objects: BTreeMap<String, Vec<u8>>,
    pub through: u64,
    pub last_batch_hash: Option<String>,
}
/// No local batches means no publication, even after receiving a remote checkpoint.
pub fn build(
    confirmed: &Document,
    overlay: &Document,
    batches: &[Batch],
    previous: Option<&Manifest>,
    actor: &str,
    generation: u64,
    other_domains: BTreeMap<Domain, DomainHead>,
) -> Result<Option<Publication>, String> {
    if batches.is_empty() {
        return Ok(None);
    }
    if !confirmed.valid()
        || !overlay.valid()
        || confirmed.scope != overlay.scope
        || uuid::Uuid::parse_str(actor).is_err()
    {
        return Err("发布状态身份无效".into());
    }
    let mut check = confirmed.clone();
    for b in batches {
        if b.actor != actor {
            return Err("不能代替其他设备发布增量".into());
        }
        check.apply(b)?;
    }
    if check != *overlay {
        return Err("待发布状态缺少批次或包含额外变化".into());
    }
    let first = batches.first().unwrap().seq;
    let through = batches.last().unwrap().seq;
    if batches
        .windows(2)
        .any(|w| w[0].seq.checked_add(1) != Some(w[1].seq))
    {
        return Err("待发布批次存在缺口".into());
    }
    let scope = confirmed.scope.clone();
    let base = format!("sync-v2/{}/", scope.vault);
    let objects_path = format!("objects/{}/{}/", actor, domain(scope.domain));
    let manifests_path = format!("manifests/{}/{}/", actor, domain(scope.domain));
    let mut objects = BTreeMap::new();
    let compact = previous.is_some_and(|m| m.tail.len() >= 64);

    let mut manifest = if let Some(previous) = previous.filter(|_| !compact) {
        previous.validate()?;
        if previous.scope != scope
            || previous.actor != actor
            || previous.last_seq().checked_add(1) != Some(first)
        {
            return Err("上次发布清单与本机序列不符".into());
        }
        previous.clone()
    } else {
        let checkpoint = if compact { overlay } else { confirmed };
        let seq = checkpoint.frontier.get(actor).map_or(0, |c| c.seq);
        let body = encode(checkpoint)?;
        let r = reference(&body, 0, seq);
        objects.insert(format!("{base}{objects_path}{}.json.gz", r.hash), body);
        Manifest {
            schema: 2,
            scope: scope.clone(),
            actor: actor.into(),
            checkpoint: r,
            tail: vec![],
        }
    };
    if !compact {
        let body = encode(&batches)?;
        let r = reference(&body, first, through);
        objects.insert(format!("{base}{objects_path}{}.json.gz", r.hash), body);
        manifest.tail.push(r);
    }
    manifest.validate()?;
    let body = serde_json::to_vec(&manifest).map_err(|_| "清单编码失败")?;
    let manifest_hash = causal::hash(&body);
    objects.insert(format!("{base}{manifests_path}{manifest_hash}.json"), body);
    let mut domains = other_domains;
    domains.insert(
        scope.domain,
        DomainHead {
            self_seq: through,
            manifest_hash,
        },
    );
    let head = Head {
        schema: 2,
        uid: scope.uid,
        vault: scope.vault,
        seed: scope.seed,
        actor: actor.into(),
        generation,
        domains,
    };
    head.filename()?;
    Ok(Some(Publication {
        head,
        manifest,
        objects,
        through,
        last_batch_hash: Some(batches.last().unwrap().hash()?),
    }))
}

/// Publish captured legacy facts without inventing a new user edit or allocating an actor dot.
/// Only the bootstrap coordinator may call this; ordinary receive-only rounds use `build`.
pub fn bootstrap_checkpoint(
    document: &Document,
    actor: &str,
    generation: u64,
    other_domains: BTreeMap<Domain, DomainHead>,
) -> Result<Publication, String> {
    if !document.valid() || document.frontier.contains_key(actor) {
        return Err("初始化检查点必须使用尚未发布的本机身份".into());
    }
    let scope = &document.scope;
    let base = format!("sync-v2/{}/", scope.vault);
    let body = encode(document)?;
    let checkpoint = reference(&body, 0, 0);
    let mut objects = BTreeMap::from([(
        format!(
            "{base}objects/{actor}/{}/{}.json.gz",
            domain(scope.domain),
            checkpoint.hash
        ),
        body,
    )]);
    let manifest = Manifest {
        schema: 2,
        scope: scope.clone(),
        actor: actor.into(),
        checkpoint,
        tail: vec![],
    };
    manifest.validate()?;
    let body = serde_json::to_vec(&manifest).map_err(|_| "清单编码失败")?;
    let manifest_hash = causal::hash(&body);
    objects.insert(
        format!(
            "{base}manifests/{actor}/{}/{manifest_hash}.json",
            domain(scope.domain)
        ),
        body,
    );
    let mut domains = other_domains;
    domains.insert(
        scope.domain,
        DomainHead {
            self_seq: 0,
            manifest_hash,
        },
    );
    let head = Head {
        schema: 2,
        uid: scope.uid.clone(),
        vault: scope.vault.clone(),
        seed: scope.seed.clone(),
        actor: actor.into(),
        generation,
        domains,
    };
    head.filename()?;
    Ok(Publication {
        head,
        manifest,
        objects,
        through: 0,
        last_batch_hash: None,
    })
}
impl Publication {
    pub async fn publish(&self, net: &super::v2_net::Client<'_>) -> Result<(), String> {
        let base = format!("sync-v2/{}/", self.head.vault);
        let mut directories = std::collections::BTreeSet::new();
        directories.insert("sync-v2/".to_owned());
        directories.insert(base.clone());
        for path in self.objects.keys().chain(std::iter::once(&format!(
            "{base}control/{}/{}",
            self.head.actor,
            self.head.filename()?
        ))) {
            let parts = path.split('/').collect::<Vec<_>>();
            for n in 1..parts.len() {
                directories.insert(format!("{}/", parts[..n].join("/")));
            }
        }
        let mut dirs = directories.into_iter().collect::<Vec<_>>();
        dirs.sort_by_key(|d| d.matches('/').count());
        for path in dirs {
            net.mkdir(&path).await?;
        }
        for (path, bytes) in &self.objects {
            net.put(path, bytes.clone()).await?;
        }
        let head_path = format!(
            "{base}control/{}/{}",
            self.head.actor,
            self.head.filename()?
        );
        let body = serde_json::to_vec(&self.head).map_err(|_| "提交编码失败")?;
        net.put(&head_path, body.clone()).await?;
        if net
            .get(&head_path)
            .await?
            .is_none_or(|obj| obj.body != body)
        {
            return Err("远端提交尚未确认，保留待上传批次".into());
        }
        // Only this writer's obsolete commit markers are removed. Immutable data and
        // checkpoints remain available to arbitrarily old/offline readers.
        if self.head.generation % 16 == 0 {
            let root = format!("{base}control/{}/", self.head.actor);
            if let Ok((names, _)) = net.list(&root).await {
                for name in names {
                    if let Some(generation) =
                        name.split('-').next().and_then(|n| n.parse::<u64>().ok())
                    {
                        if generation.saturating_add(8) < self.head.generation
                            && name.ends_with(".json")
                        {
                            let _ = net.delete(&format!("{root}{name}")).await;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
pub fn select_head(mut candidates: Vec<Head>, minimum: u64) -> Result<Option<Head>, String> {
    candidates.sort_by_key(|h| h.generation);
    for h in &candidates {
        h.filename()?;
    }
    for pair in candidates.windows(2) {
        if pair[0].actor != pair[1].actor
            || pair[0].uid != pair[1].uid
            || pair[0].vault != pair[1].vault
            || pair[0].seed != pair[1].seed
        {
            return Err("提交记录来自不同同步身份".into());
        }
        if pair[0].generation == pair[1].generation && pair[0] != pair[1] {
            return Err("同一提交代出现分叉".into());
        }
    }
    let result = candidates.pop();
    if result.as_ref().is_some_and(|h| h.generation < minimum) {
        return Err("远端提交发生回退，保留本机状态".into());
    }
    Ok(result)
}

pub async fn discover(
    net: &super::v2_net::Client<'_>,
    uid: &str,
    vault: &str,
    seed: &str,
    actor: &str,
    minimum: u64,
) -> Result<Option<Head>, String> {
    if uuid::Uuid::parse_str(vault).is_err()
        || uuid::Uuid::parse_str(actor).is_err()
        || !causal::valid_hash(seed)
    {
        return Err("同步库身份无效".into());
    }
    let path = format!("sync-v2/{vault}/control/{actor}/");
    let (files, _) = net.list(&path).await?;
    let mut names = files
        .into_iter()
        .filter_map(|name| {
            let stem = name.strip_suffix(".json")?;
            let (generation, digest) = stem.split_once('-')?;
            if generation.len() != 20 || !causal::valid_hash(digest) {
                return None;
            }
            Some((generation.parse::<u64>().ok()?, name))
        })
        .collect::<Vec<_>>();
    names.sort();
    let maximum = names.last().map(|n| n.0);
    let mut heads = Vec::new();
    for (_, name) in names.into_iter().filter(|(g, _)| Some(*g) == maximum) {
        let obj = net
            .get(&format!("{path}{name}"))
            .await?
            .ok_or("提交目录正在变化，请重新发现")?;
        let head: Head = serde_json::from_slice(&obj.body).map_err(|_| "提交记录格式无效")?;
        if head.uid != uid
            || head.vault != vault
            || head.seed != seed
            || head.actor != actor
            || head.filename()? != name
        {
            return Err("提交记录身份不匹配".into());
        }
        heads.push(head);
    }
    if heads.is_empty() && minimum > 0 {
        return Err("已确认提交暂不可见，保留本机水位".into());
    }
    select_head(heads, minimum)
}

/// Dependencies missing from one actor are supplied by verified checkpoints from other actors.
/// Any error leaves the caller's document unchanged; never skip a hole and advance the cursor.
pub async fn receive(
    net: &super::v2_net::Client<'_>,
    known: &Document,
    actor: &str,
    manifest_hash: &str,
) -> Result<Document, String> {
    let plan = load_receive(net, known, actor, manifest_hash).await?;
    let mut next = known.clone();
    next.join(&plan.checkpoint)?;
    for batch in plan.batches {
        next.apply(&batch)?;
    }
    Ok(next)
}
pub(super) struct ReceivePlan {
    pub checkpoint: Document,
    pub batches: Vec<Batch>,
    pub through: u64,
}
/// Validate each immutable packet once. The executor can then interleave verified
/// prefixes from different writers instead of requiring an entire writer tail to
/// be dependency-free in isolation (A1 -> B1 -> A2 is a valid causal history).
pub(super) async fn load_receive(
    net: &super::v2_net::Client<'_>,
    known: &Document,
    actor: &str,
    manifest_hash: &str,
) -> Result<ReceivePlan, String> {
    if uuid::Uuid::parse_str(actor).is_err() || !causal::valid_hash(manifest_hash) {
        return Err("增量清单身份无效".into());
    }
    let base = format!("sync-v2/{}/", known.scope.vault);
    let objects = format!("{base}objects/{actor}/{}/", domain(known.scope.domain));
    let obj = net
        .get(&format!(
            "{base}manifests/{actor}/{}/{manifest_hash}.json",
            domain(known.scope.domain)
        ))
        .await?
        .ok_or("增量清单暂不可见")?;
    if causal::hash(&obj.body) != manifest_hash {
        return Err("增量清单摘要不符".into());
    }
    let manifest: Manifest = serde_json::from_slice(&obj.body).map_err(|_| "增量清单格式无效")?;
    manifest.validate()?;
    if manifest.scope != known.scope || manifest.actor != actor {
        return Err("增量清单范围不匹配".into());
    }
    let cp = net
        .get(&format!("{objects}{}.json.gz", manifest.checkpoint.hash))
        .await?
        .ok_or("增量检查点暂不可见")?;
    let checkpoint: Document = decode(&cp.body, &manifest.checkpoint)?;
    if !checkpoint.valid()
        || checkpoint.scope != known.scope
        || checkpoint.frontier.get(actor).map_or(0, |c| c.seq) != manifest.checkpoint.last_seq
    {
        return Err("检查点覆盖水位不符".into());
    }
    let mut pending = Vec::new();
    for reference in &manifest.tail {
        if known
            .frontier
            .get(actor)
            .is_some_and(|c| c.seq >= reference.last_seq)
        {
            continue;
        }
        let obj = net
            .get(&format!("{objects}{}.json.gz", reference.hash))
            .await?
            .ok_or("增量批次暂不可见")?;
        let batches: Vec<Batch> = decode(&obj.body, reference)?;
        if batches.first().map(|b| b.seq) != Some(reference.first_seq)
            || batches.last().map(|b| b.seq) != Some(reference.last_seq)
            || batches.len() as u64 != reference.last_seq - reference.first_seq + 1
        {
            return Err("批次内容与清单范围不符".into());
        }
        for batch in batches {
            if batch.actor != actor || batch.scope != known.scope {
                return Err("批次来源范围不符".into());
            }
            pending.push(batch);
        }
    }
    Ok(ReceivePlan {
        checkpoint,
        batches: pending,
        through: manifest.last_seq(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::causal::{Cell, key};
    use super::*;
    use serde_json::json;
    const A: &str = "00000000-0000-4000-8000-000000000001";
    fn root() -> Document {
        Document::empty(Scope {
            uid: "42".into(),
            vault: A.into(),
            seed: "a".repeat(64),
            domain: Domain::Library,
        })
    }
    #[test]
    fn small_changes_keep_previous_checkpoint_and_immutable_old_heads_cannot_win() {
        let confirmed = root();
        let mut view = confirmed.clone();
        let b = view
            .make_batch(
                A,
                BTreeMap::from([
                    (key("playlist:x", "__present"), Cell::Value(json!(true))),
                    (key("playlist:x", "name"), Cell::Value(json!("one"))),
                ]),
            )
            .unwrap()
            .unwrap();
        view.apply(&b).unwrap();
        let p = build(&confirmed, &view, &[b], None, A, 1, BTreeMap::new())
            .unwrap()
            .unwrap();
        let next = view
            .make_batch(
                A,
                BTreeMap::from([(key("playlist:x", "name"), Cell::Value(json!("two")))]),
            )
            .unwrap()
            .unwrap();
        let mut overlay = view.clone();
        overlay.apply(&next).unwrap();
        let q = build(
            &view,
            &overlay,
            &[next],
            Some(&p.manifest),
            A,
            2,
            BTreeMap::new(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(p.manifest.checkpoint, q.manifest.checkpoint);
        assert_eq!(q.objects.len(), 2);
        assert_eq!(
            select_head(vec![q.head.clone(), p.head.clone()], 2).unwrap(),
            Some(q.head)
        );
        assert!(select_head(vec![p.head], 2).is_err());
    }
    #[test]
    fn corrupt_objects_and_sequence_gaps_are_rejected() {
        let body = encode(&root()).unwrap();
        let r = reference(&body, 0, 0);
        assert_eq!(decode::<Document>(&body, &r).unwrap(), root());
        let mut corrupt = body;
        corrupt[0] ^= 1;
        assert!(decode::<Document>(&corrupt, &r).is_err());
        let mut m = Manifest {
            schema: 2,
            scope: root().scope,
            actor: A.into(),
            checkpoint: r.clone(),
            tail: vec![ObjectRef {
                first_seq: 2,
                last_seq: 2,
                ..r
            }],
        };
        assert!(m.validate().is_err());
        m.tail[0].first_seq = 1;
        assert!(m.validate().is_ok());
        assert!(
            build(&root(), &root(), &[], None, A, 1, BTreeMap::new())
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn passive_store_replays_lost_commit_reply_and_discovers_newest_head_after_late_put() {
        let (cfg, secret, store, server) = super::super::test_dav::server().await;
        let net = super::super::v2_net::Client::new(&cfg, &secret).unwrap();
        let confirmed = root();
        let mut view = confirmed.clone();
        let b = view
            .make_batch(
                A,
                BTreeMap::from([
                    (key("playlist:x", "__present"), Cell::Value(json!(true))),
                    (key("playlist:x", "name"), Cell::Value(json!("one"))),
                ]),
            )
            .unwrap()
            .unwrap();
        view.apply(&b).unwrap();
        let p = build(&confirmed, &view, &[b], None, A, 1, BTreeMap::new())
            .unwrap()
            .unwrap();
        store.lock().unwrap().fail_head_once = true;
        assert!(p.publish(&net).await.is_err());
        p.publish(&net).await.unwrap();
        assert_eq!(
            receive(
                &net,
                &confirmed,
                A,
                &p.head.domains[&Domain::Library].manifest_hash
            )
            .await
            .unwrap(),
            view
        );
        let b = view
            .make_batch(
                A,
                BTreeMap::from([(key("playlist:x", "name"), Cell::Value(json!("two")))]),
            )
            .unwrap()
            .unwrap();
        let mut next = view.clone();
        next.apply(&b).unwrap();
        let q = build(&view, &next, &[b], Some(&p.manifest), A, 2, BTreeMap::new())
            .unwrap()
            .unwrap();
        q.publish(&net).await.unwrap();
        net.put(
            &format!(
                "sync-v2/{}/control/{A}/{}",
                q.head.vault,
                p.head.filename().unwrap()
            ),
            serde_json::to_vec(&p.head).unwrap(),
        )
        .await
        .unwrap();
        let newest = discover(&net, "42", &q.head.vault, &q.head.seed, A, 2)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(newest, q.head);
        assert_eq!(
            receive(
                &net,
                &confirmed,
                A,
                &newest.domains[&Domain::Library].manifest_hash
            )
            .await
            .unwrap(),
            next
        );
        let object = q.objects.keys().find(|p| p.ends_with(".gz")).unwrap();
        store
            .lock()
            .unwrap()
            .files
            .remove(&format!("/dav/BiliMusic-sync-v1/42/{object}"));
        assert!(
            receive(
                &net,
                &view,
                A,
                &newest.domains[&Domain::Library].manifest_hash
            )
            .await
            .is_err()
        );
        assert_eq!(
            view.materialize().unwrap().0["playlist:x"]["name"],
            json!("one")
        );
        server.abort();
    }
}
