//! Immediate bootstrap into a shared deterministic genesis. No all-device voting or timeout gate.
//! Concurrent first-upgrade devices publish independent heads into the SAME vault and merge.
use super::causal::{self, Candidate, Cell, Context, Document, Domain, Dot, Register, Scope};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Genesis {
    pub schema: u32,
    pub uid: String,
    pub vault: String,
    pub seed: String,
}
impl Genesis {
    pub fn new(uid: &str, target: &str) -> Result<Self, String> {
        if uid.is_empty() || !uid.bytes().all(|c| c.is_ascii_digit()) || target.is_empty() {
            return Err("同步目标身份无效".into());
        }
        let identity = serde_json::to_vec(&("bilimusic/nutstore/v2/genesis", uid, target)).unwrap();
        let digest = ring::digest::digest(&ring::digest::SHA256, &identity);
        let mut bytes = [0; 16];
        bytes.copy_from_slice(&digest.as_ref()[..16]);
        bytes[6] = (bytes[6] & 15) | 128;
        bytes[8] = (bytes[8] & 63) | 128;
        Ok(Self {
            schema: 2,
            uid: uid.into(),
            vault: uuid::Uuid::from_bytes(bytes).to_string(),
            seed: causal::hash(&identity),
        })
    }
    /// The physical remote directory identifies the vault. Local caches additionally include
    /// the authenticated principal; spelling/alias changes of that principal must not fork v2.
    pub fn for_config(cfg: &super::Config) -> Result<Self, String> {
        if cfg.provider != "webdav" {
            return Err("新版同步仅支持 WebDAV".into());
        }
        let mut url = url::Url::parse(&cfg.url).map_err(|_| "同步地址无效")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("同步地址无效".into());
        }
        let path = format!("{}/", url.path().trim_end_matches('/'));
        url.set_path(&path);
        Self::new(&cfg.uid, url.as_str())
    }
    pub fn scope(&self, domain: Domain) -> Scope {
        Scope {
            uid: self.uid.clone(),
            vault: self.vault.clone(),
            seed: self.seed.clone(),
            domain,
        }
    }
    pub fn path(&self) -> String {
        format!("sync-v2/{}/bootstrap/genesis.json", self.vault)
    }
    /// The marker is fixed bytes for this target. Two first writers cannot create competing vaults.
    pub async fn publish(&self, net: &super::v2_net::Client<'_>) -> Result<(), String> {
        for path in [
            "sync-v2/".to_owned(),
            format!("sync-v2/{}/", self.vault),
            format!("sync-v2/{}/bootstrap/", self.vault),
        ] {
            net.mkdir(&path).await?;
        }
        let bytes = serde_json::to_vec(self).map_err(|_| "同步协议标记编码失败")?;
        net.put(&self.path(), bytes.clone()).await?;
        if net
            .get(&self.path())
            .await?
            .is_none_or(|obj| obj.body != bytes)
        {
            return Err("新协议标记尚未确认".into());
        }
        Ok(())
    }
    pub async fn exists(&self, net: &super::v2_net::Client<'_>) -> Result<bool, String> {
        let Some(obj) = net.get(&self.path()).await? else {
            return Ok(false);
        };
        let remote: Genesis = serde_json::from_slice(&obj.body).map_err(|_| "云端协议标记无效")?;
        if &remote != self {
            return Err("云端协议身份与当前目标不匹配".into());
        }
        Ok(true)
    }
}

/// Captured source bytes/checkpoints, not device login state, are the bootstrap prerequisite.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inventory {
    pub sources: BTreeMap<String, String>,
    pub complete: bool,
}
impl Inventory {
    pub fn can_bootstrap(&self, verified: &BTreeMap<String, String>) -> bool {
        self.complete
            && &self.sources == verified
            && self.sources.values().all(|h| causal::valid_hash(h))
    }
}

/// Bootstrap or one-time LOCAL upgrade input only; never poll the v1 cloud after joining v2.
/// Preserve original v1 dots under a legacy namespace. Never turn a merged v1 clock into a
/// contiguous v2 cursor, and never give received old data fresh local operation identities.
pub(super) fn import_legacy(
    genesis: &Genesis,
    legacy: &super::dav::Doc,
    domain: Domain,
) -> Result<Document, String> {
    if legacy.uid != genesis.uid || legacy.schema != 1 {
        return Err("旧同步数据身份无效".into());
    }
    legacy.materialize()?;
    let mut document = Document::empty(genesis.scope(domain));
    for (encoded, values) in &legacy.fields {
        let (entity, kind, field): (String, String, String) =
            serde_json::from_str(encoded).map_err(|_| "旧同步字段键无效")?;
        let progress = matches!(kind.as_str(), "history" | "collectionProgress");
        if progress != (domain == Domain::Progress) {
            continue;
        }
        let mut register = Register::default();
        for value in values {
            if uuid::Uuid::parse_str(&value.dot.device).is_err() || value.dot.seq == 0 {
                return Err("旧同步操作身份无效".into());
            }
            let mut seen = Context::default();
            for (actor, seq) in &value.context {
                if uuid::Uuid::parse_str(actor).is_err() {
                    return Err("旧同步上下文身份无效".into());
                }
                if *seq > 0 {
                    seen.0.insert(format!("legacy:{actor}"), vec![(1, *seq)]);
                }
            }
            let dot = Dot {
                actor: format!("legacy:{}", value.dot.device),
                seq: value.dot.seq,
            };
            seen.insert(&dot);
            let missing = value.value.is_null()
                && ((kind == "collectionFolder" && field == "scope")
                    || (kind == "history" && field == "resume"));
            let default_scope =
                kind == "collectionFolder" && field == "scope" && value.value == "collections";
            let cell = if missing || default_scope {
                Cell::Missing
            } else {
                Cell::Value(value.value.clone())
            };
            register.merge(&Register {
                seen,
                values: vec![Candidate { dot, cell }],
            })?;
        }
        document
            .registers
            .insert(causal::key(&entity, &field), register);
    }
    if !document.valid() {
        return Err("旧同步状态无法转换为合法因果状态".into());
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::super::model::{Record, Snapshot};
    use super::*;
    use serde_json::json;
    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    fn sample() -> Snapshot {
        Snapshot {
            schema: 1,
            uid: "42".into(),
            records: BTreeMap::from([(
                format!("playlist:{A}"),
                Record {
                    kind: "playlist".into(),
                    fields: serde_json::from_value(
                        json!({"id":A,"name":"old","description":"","coverUrl":null}),
                    )
                    .unwrap(),
                },
            )]),
        }
    }
    #[test]
    fn verified_cloud_inventory_does_not_depend_on_device_login() {
        let source = BTreeMap::from([("legacy:a".into(), "a".repeat(64))]);
        let inventory = Inventory {
            sources: source.clone(),
            complete: true,
        };
        assert!(inventory.can_bootstrap(&source));
        assert!(!inventory.can_bootstrap(&BTreeMap::new()));
        assert!(
            !Inventory {
                sources: source.clone(),
                complete: false
            }
            .can_bootstrap(&source)
        );
    }
    #[test]
    fn concurrent_first_devices_share_genesis_and_legacy_imports_are_idempotent() {
        let g = Genesis::new("42", "same-target").unwrap();
        assert_eq!(g, Genesis::new("42", "same-target").unwrap());
        assert_ne!(g, Genesis::new("43", "same-target").unwrap());
        let mut old = super::super::dav::Doc::empty("42");
        old.update(A, &sample()).unwrap();
        let a = import_legacy(&g, &old, Domain::Library).unwrap();
        let mut b = a.clone();
        b.join(&a).unwrap();
        assert_eq!(a, b);
        assert!(a.frontier.is_empty());
        assert_eq!(
            a.materialize().unwrap().0[&format!("playlist:{A}")]["name"],
            json!("old")
        );
    }
    #[tokio::test]
    async fn first_device_bootstraps_without_edits_and_later_device_joins_same_vault() {
        use super::super::{protocol_v2, v2_net};
        let (cfg, secret, _, server) = super::super::test_dav::server().await;
        let net = v2_net::Client::new(&cfg, &secret).unwrap();
        let g = Genesis::for_config(&cfg).unwrap();
        let mut spelling = cfg.clone();
        spelling.url = cfg.url.trim_end_matches('/').into();
        assert_eq!(g, Genesis::for_config(&spelling).unwrap());
        assert!(!g.exists(&net).await.unwrap());
        let mut old = super::super::dav::Doc::empty("42");
        old.update(A, &sample()).unwrap();
        let document = import_legacy(&g, &old, Domain::Library).unwrap();
        let plan = protocol_v2::bootstrap_checkpoint(&document, B, 1, BTreeMap::new()).unwrap();
        assert!(plan.last_batch_hash.is_none());
        assert!(document.frontier.is_empty());
        plan.publish(&net).await.unwrap();
        // The marker follows the confirmed data head; it is not evidence of data by itself.
        g.publish(&net).await.unwrap();
        assert!(g.exists(&net).await.unwrap());
        let h = protocol_v2::discover(&net, &g.uid, &g.vault, &g.seed, B, 0)
            .await
            .unwrap()
            .unwrap();
        let joined = protocol_v2::receive(
            &net,
            &Document::empty(g.scope(Domain::Library)),
            B,
            &h.domains[&Domain::Library].manifest_hash,
        )
        .await
        .unwrap();
        assert_eq!(joined, document);
        assert!(
            protocol_v2::build(&joined, &joined, &[], None, A, 1, BTreeMap::new())
                .unwrap()
                .is_none()
        );
        server.abort();
    }
    #[test]
    fn upgrading_device_keeps_changes_already_uploaded_only_to_v1() {
        const C: &str = "00000000-0000-4000-8000-000000000003";
        let g = Genesis::new("42", "t").unwrap();
        let mut local_legacy = super::super::dav::Doc::empty("42");
        local_legacy.update(A, &sample()).unwrap();
        let mut v2 = import_legacy(&g, &local_legacy, Domain::Library).unwrap();
        let entity = format!("playlist:{A}");
        let batch = v2
            .make_batch(
                B,
                BTreeMap::from([(
                    causal::key(&entity, "description"),
                    Cell::Value(json!("v2 description")),
                )]),
            )
            .unwrap()
            .unwrap();
        v2.apply(&batch).unwrap();
        // The old device already synced this edit to v1: comparing only its current
        // snapshot with its last v1 baseline would wrongly consider it "unchanged".
        let mut current = sample();
        current
            .records
            .get_mut(&entity)
            .unwrap()
            .fields
            .insert("name".into(), json!("v1 name"));
        local_legacy.update(C, &current).unwrap();
        let local_input = import_legacy(&g, &local_legacy, Domain::Library).unwrap();
        v2.join(&local_input).unwrap();
        let once = v2.clone();
        v2.join(&local_input).unwrap();
        assert_eq!(once, v2);
        let (rows, conflicts) = v2.materialize().unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(rows[&entity]["name"], json!("v1 name"));
        assert_eq!(rows[&entity]["description"], json!("v2 description"));
    }
    #[test]
    fn upgraded_devices_preserve_same_field_candidates_until_resolution_then_converge() {
        const C: &str = "00000000-0000-4000-8000-000000000003";
        const D: &str = "00000000-0000-4000-8000-000000000004";
        let g = Genesis::new("42", "t").unwrap();
        let mut legacy = super::super::dav::Doc::empty("42");
        legacy.update(A, &sample()).unwrap();
        let mut v2 = import_legacy(&g, &legacy, Domain::Library).unwrap();
        let entity = format!("playlist:{A}");
        let field = causal::key(&entity, "name");
        let batch = v2
            .make_batch(
                B,
                BTreeMap::from([(field.clone(), Cell::Value(json!("newer client")))]),
            )
            .unwrap()
            .unwrap();
        v2.apply(&batch).unwrap();
        let mut current = sample();
        current
            .records
            .get_mut(&entity)
            .unwrap()
            .fields
            .insert("name".into(), json!("older client"));
        legacy.update(C, &current).unwrap();
        let upgrade = import_legacy(&g, &legacy, Domain::Library).unwrap();
        let mut reverse = upgrade.clone();
        reverse.join(&v2).unwrap();
        v2.join(&upgrade).unwrap();
        assert_eq!(v2, reverse);
        assert!(v2.materialize().unwrap().1.contains(&field));
        assert_eq!(v2.registers[&field].values.len(), 2);
        let resolve = v2
            .make_batch(
                D,
                BTreeMap::from([(field.clone(), Cell::Value(json!("chosen name")))]),
            )
            .unwrap()
            .unwrap();
        v2.apply(&resolve).unwrap();
        reverse.apply(&resolve).unwrap();
        // A retry of old upgrade input cannot reopen a conflict already resolved by the user.
        reverse.join(&upgrade).unwrap();
        assert_eq!(v2, reverse);
        assert!(v2.materialize().unwrap().1.is_empty());
        assert_eq!(
            v2.materialize().unwrap().0[&entity]["name"],
            json!("chosen name")
        );
    }
    #[test]
    fn later_legacy_edit_cannot_resurrect_a_v2_deletion() {
        let g = Genesis::new("42", "t").unwrap();
        let mut old = super::super::dav::Doc::empty("42");
        old.update(A, &sample()).unwrap();
        let mut v2 = import_legacy(&g, &old, Domain::Library).unwrap();
        let delete = v2
            .make_batch(
                B,
                BTreeMap::from([(
                    causal::key(&format!("playlist:{A}"), "__present"),
                    Cell::Value(json!(false)),
                )]),
            )
            .unwrap()
            .unwrap();
        v2.apply(&delete).unwrap();
        let mut later = sample();
        later
            .records
            .values_mut()
            .next()
            .unwrap()
            .fields
            .insert("name".into(), json!("late"));
        old.update(A, &later).unwrap();
        v2.join(&import_legacy(&g, &old, Domain::Library).unwrap())
            .unwrap();
        let (rows, conflicts) = v2.materialize().unwrap();
        assert!(rows.is_empty());
        assert!(conflicts.contains(&causal::key(&format!("playlist:{A}"), "__present")));
        assert!(
            v2.registers[&causal::key(&format!("playlist:{A}"), "__record")]
                .values
                .iter()
                .any(
                    |v| matches!(&v.cell, Cell::Value(record) if record["fields"]["name"] == "late")
                )
        );
    }
}
