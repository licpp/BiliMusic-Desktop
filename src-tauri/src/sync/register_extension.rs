//! Causal register exchange for optional library data that older clients can ignore.
use super::{
    Config,
    actor::Lease,
    causal::{self, Candidate, Cell, Dot, Register},
    engine::{get as read_state, put as write_state},
    migration::Genesis,
    protocol_v2::{self, ObjectRef},
    transport::Secret,
    v2_net::Client,
};
use crate::infrastructure::database::{Database, account_session};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub(super) struct RegisterExtension {
    pub(super) namespace: &'static str,
    pub(super) writer_key: &'static str,
    pub(super) cache_dir: &'static str,
    pub(super) validate_key: fn(&str) -> Result<(), String>,
    pub(super) validate_value: fn(&Value) -> Result<(), String>,
    pub(super) project:
        fn(&Connection, &BTreeSet<String>) -> Result<BTreeMap<String, Register>, String>,
    pub(super) write: fn(&Connection, &str, &Register) -> Result<(), String>,
    pub(super) selected: fn(&Register) -> Option<&Cell>,
}
#[derive(Default, Serialize, Deserialize)]
struct Writer {
    instance: String,
    sequence: u64,
    revision: u64,
}

fn writer(c: &Connection, key: &str) -> Result<Writer, String> {
    let raw: Option<String> = c
        .query_row("SELECT value FROM sync_info WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(err)?;
    raw.map(|json| serde_json::from_str(&json).map_err(err))
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(super) fn edit_register(
    c: &Connection,
    root: &Path,
    extension: &RegisterExtension,
    register: &mut Register,
    cell: Cell,
) -> Result<(), String> {
    let mut state = writer(c, extension.writer_key)?;
    if state.instance.is_empty() {
        state.instance = uuid::Uuid::new_v4().to_string();
    }
    let installation = super::engine::installation(root)?;
    let open = |instance: &str| {
        Lease::open(
            &root
                .join(extension.writer_key)
                .join(format!("{installation}-{instance}")),
            instance,
        )
    };
    let mut lease = open(&state.instance)?;
    if !lease.consistent(&BTreeMap::from([(
        extension.namespace.into(),
        state.sequence,
    )])) {
        state.instance = uuid::Uuid::new_v4().to_string();
        state.sequence = 0;
        lease = open(&state.instance)?;
    }
    let next = state.sequence.checked_add(1).ok_or("同步操作序号耗尽")?;
    lease.reserve(extension.namespace, state.sequence, next)?;
    let dot = Dot {
        actor: lease.actor().into(),
        seq: next,
    };
    register.seen.insert(&dot);
    register.values = vec![Candidate { dot, cell }];

    state.sequence = next;
    state.revision = state.revision.checked_add(1).ok_or("同步版本耗尽")?;
    c.execute(
        "INSERT INTO sync_info(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![
            extension.writer_key,
            serde_json::to_string(&state).map_err(err)?
        ],
    )
    .map_err(err)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Packet {
    schema: u32,
    namespace: String,
    uid: String,
    vault: String,
    seed: String,
    actor: String,
    generation: u64,
    pub(super) registers: BTreeMap<String, Register>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Head {
    pub(super) generation: u64,
    pub(super) hash: String,
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

fn projection_digest(registers: &BTreeMap<String, Register>) -> Result<String, String> {
    Ok(causal::hash(&serde_json::to_vec(registers).map_err(err)?))
}

impl RegisterExtension {
    fn validate_packet(
        &self,
        packet: &Packet,
        genesis: &Genesis,
        actor: &str,
        head: &Head,
    ) -> Result<(), String> {
        if packet.schema != 1
            || packet.namespace != self.namespace
            || packet.uid != genesis.uid
            || packet.vault != genesis.vault
            || packet.seed != genesis.seed
            || uuid::Uuid::parse_str(actor).is_err()
            || packet.actor != actor
            || packet.generation == 0
            || packet.generation != head.generation
            || packet.registers.len() > 20_000
        {
            return Err("同步扩展身份或版本无效".into());
        }
        for (key, register) in &packet.registers {
            (self.validate_key)(key)?;
            if register.values.is_empty() {
                return Err("同步扩展操作无效".into());
            }
            for candidate in &register.values {
                if let Cell::Value(value) = &candidate.cell {
                    (self.validate_value)(value)?;
                }
            }
            Register::default().merge(register)?;
        }
        Ok(())
    }

    pub(super) fn decode_packet(
        &self,
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
        self.validate_packet(&packet, genesis, actor, head)?;
        Ok(packet)
    }

    pub(super) fn object(&self, genesis: &Genesis, hash: &str) -> String {
        format!(
            "sync-v2/{}/extensions/{}/{hash}.json.gz",
            genesis.vault, self.namespace
        )
    }

    fn head_name(&self, head: &Head) -> String {
        format!(
            "ext-{}-{:020}-{}.head",
            self.namespace, head.generation, head.hash
        )
    }

    pub(super) fn parse_head(&self, name: &str) -> Option<Head> {
        let (seq, hash) = name
            .strip_prefix(&format!("ext-{}-", self.namespace))?
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

    fn freeze(
        &self,
        registers: BTreeMap<String, Register>,
        genesis: &Genesis,
        owner: &str,
        generation: u64,
        revision: u64,
    ) -> Result<Pending, String> {
        let packet = Packet {
            schema: 1,
            namespace: self.namespace.into(),
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
        self.validate_packet(&packet, genesis, owner, &head)?;
        Ok(Pending {
            actor: owner.into(),
            head,
            revision,
            bytes,
        })
    }

    pub(super) async fn exchange(
        &self,
        db: &Database,
        cfg: &Config,
        secret: &Secret,
        owner: &str,
        session: &str,
        scope: BTreeSet<String>,
    ) -> Result<bool, String> {
        let target =
            super::storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)?;
        let genesis = Genesis::for_config(cfg)?;
        let net = Client::cached(cfg, secret, db.1.join(self.cache_dir).join(&target))?;
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
            state = read_state(c, &target, self.namespace)?.unwrap_or_default();
            Ok(())
        })?;

        let control = format!("sync-v2/{}/control/", genesis.vault);
        let (owners, _) = net.list(&control).await?;
        if state.heads.keys().any(|actor| !owners.contains(actor)) {
            return Err("已确认的同步扩展设备暂不可见".into());
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
                .filter_map(|name| self.parse_head(name))
                .collect::<Vec<_>>();
            heads.sort_unstable_by_key(|head| head.generation);
            let known = state.heads.get(&actor);
            let Some(head) = heads.pop() else {
                if known.is_some() {
                    return Err("同步扩展提交暂不可见".into());
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
                return Err("同步扩展提交发生回退或分叉".into());
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
                    .get(&format!("{path}{}", self.head_name(&head)))
                    .await?
                    .ok_or("同步扩展提交暂不可见")?;
                if marker.body != head.hash.as_bytes() {
                    return Err("同步扩展提交摘要不符".into());
                }
            }
            let body = net
                .get(&self.object(&genesis, &head.hash))
                .await?
                .ok_or("同步扩展对象暂不可见")?;
            let packet = self.decode_packet(&body.body, &genesis, &actor, &head)?;
            incoming.push((actor, head, packet));
        }

        let mut changed = false;
        with(&mut |c| {
            let mut registers = (self.project)(c, &scope)?;
            let before = projection_digest(&registers)?;
            let local_revision = writer(c, self.writer_key)?.revision;
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
                    let local = registers.entry(key.clone()).or_default();
                    let old = (self.selected)(local).cloned();
                    local.merge(remote)?;
                    changed |= old.as_ref() != (self.selected)(local);
                    (self.write)(c, key, local)?;
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
                    || self
                        .decode_packet(&pending.bytes, &genesis, &pending.actor, &pending.head)?
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
                if !registers.is_empty()
                    || state.heads.contains_key(owner)
                    || superseded_generation > 0
                {
                    // A PUT that failed may still become visible. Advance the head
                    // instead of reusing that generation with another payload.
                    let generation = state
                        .heads
                        .get(owner)
                        .map_or(0, |head| head.generation)
                        .max(superseded_generation)
                        .checked_add(1)
                        .ok_or("同步扩展提交序号耗尽")?;
                    state.pending = Some(self.freeze(
                        registers,
                        &genesis,
                        owner,
                        generation,
                        local_revision,
                    )?);
                }
                state.dirty = false;
            }
            write_state(c, &target, self.namespace, &state)
        })?;

        if let Some(pending) = state.pending.take() {
            let directory = format!("sync-v2/{}/extensions/{}/", genesis.vault, self.namespace);
            net.mkdir(&directory).await?;
            net.mkdir(&format!("{control}{}/", pending.actor)).await?;
            with(&mut |_| Ok(()))?;
            net.put(&self.object(&genesis, &pending.head.hash), pending.bytes)
                .await?;
            with(&mut |_| Ok(()))?;
            let marker = format!(
                "{control}{}/{}",
                pending.actor,
                self.head_name(&pending.head)
            );
            net.put(&marker, pending.head.hash.as_bytes().to_vec())
                .await?;
            if net
                .get(&marker)
                .await?
                .is_none_or(|object| object.body != pending.head.hash.as_bytes())
            {
                return Err("同步扩展提交尚未确认".into());
            }
            with(&mut |c| {
                state.published_revision = pending.revision;
                state
                    .heads
                    .insert(pending.actor.clone(), pending.head.clone());
                write_state(c, &target, self.namespace, &state)
            })?;
        }
        Ok(changed)
    }
}
