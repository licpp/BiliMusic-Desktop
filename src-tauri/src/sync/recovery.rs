//! Rotate a restored/copied/uncertain writer without reusing its operation identities.
//! Pending intentions retain their original field observations; they are not replayed as
//! unconditional overwrites of newly received remote values.
use super::{
    actor::Lease,
    causal::{self, Context, Domain, Dot, Register},
    engine, outbox,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{collections::BTreeMap, path::Path};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn remap(
    context: &Context,
    old: &str,
    floor: u64,
    new: &str,
    mapping: &BTreeMap<u64, u64>,
) -> Context {
    let mut result = context.clone();
    if let Some(ranges) = result.0.get_mut(old) {
        *ranges = ranges
            .iter()
            .filter_map(|(a, b)| (*a <= floor).then_some((*a, (*b).min(floor))))
            .collect();
        if ranges.is_empty() {
            result.0.remove(old);
        }
    }
    for (from, to) in mapping {
        if context.contains(&Dot {
            actor: old.into(),
            seq: *from,
        }) {
            result.insert(&Dot {
                actor: new.into(),
                seq: *to,
            });
        }
    }
    result
}
pub fn ensure(
    c: &Connection,
    directory: &Path,
    family: &str,
    target: &str,
    instance: &mut String,
    domains: &[Domain],
    contexts: &mut BTreeMap<Domain, BTreeMap<String, Register>>,
) -> Result<(Lease, bool), String> {
    let install = engine::installation(directory)?;
    let open = |instance: &str| {
        Lease::open(
            &directory
                .join(family)
                .join(target)
                .join(format!("{install}-{instance}")),
            instance,
        )
    };
    let first = domains.first().ok_or("同步恢复域为空")?;
    let old: String = c
        .query_row(
            "SELECT actor FROM sync_v2_documents WHERE target=?1 AND domain=?2",
            params![target, first.name()],
            |r| r.get(0),
        )
        .map_err(err)?;
    let mut expected = BTreeMap::new();
    for d in domains {
        let (actor, allocated): (String, u64) = c
            .query_row(
                "SELECT actor,allocated FROM sync_v2_documents WHERE target=?1 AND domain=?2",
                params![target, d.name()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(err)?;
        if actor != old {
            return Err("同步写入域身份不一致，已保留恢复材料".into());
        }
        expected.insert(d.name().to_owned(), allocated);
    }
    let generation: u64 = c
        .query_row(
            "SELECT generation FROM sync_v2_publications WHERE target=?1 AND actor=?2",
            params![target, old],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .unwrap_or(0);
    expected.insert("head".into(), generation);
    if let Ok(lease) = open(instance) {
        if lease.actor() == old && lease.consistent(&expected) {
            return Ok((lease, false));
        }
    }
    let next = uuid::Uuid::new_v4().to_string();
    let mut lease = open(&next)?;
    for d in domains {
        let confirmed = outbox::confirmed(c, target, *d)?;
        let queue = outbox::pending(c, target, *d)?;
        let floor = confirmed.frontier.get(&old).map_or(0, |cursor| cursor.seq);
        let pending = super::publication::pending(c, target, &old)?;
        let backup = serde_json::json!({"confirmed":confirmed,"queue":queue,"publication":pending});
        engine::put(
            c,
            target,
            &format!(
                "writer-backup:{}:{}:{}",
                old,
                d.name(),
                causal::hash(&serde_json::to_vec(&backup).map_err(err)?)
            ),
            &backup,
        )?;
        c.execute(
            "DELETE FROM sync_v2_outbox WHERE target=?1 AND domain=?2",
            params![target, d.name()],
        )
        .map_err(err)?;
        c.execute(
            "UPDATE sync_v2_documents SET actor=?3,allocated=0 WHERE target=?1 AND domain=?2",
            params![target, d.name(), lease.actor()],
        )
        .map_err(err)?;
        let mut mapping = BTreeMap::new();
        for batch in queue {
            let mut changes = BTreeMap::new();
            let mut observed = BTreeMap::new();
            for (key, register) in batch.registers {
                let value = register
                    .values
                    .first()
                    .ok_or("待恢复操作无效")?
                    .cell
                    .clone();
                changes.insert(key.clone(), value);
                observed.insert(
                    key,
                    Register {
                        seen: remap(&register.seen, &old, floor, lease.actor(), &mapping),
                        values: vec![],
                    },
                );
            }
            let before = outbox::pending(c, target, *d)?.len();
            outbox::mutate_in_transaction(c, target, *d, &mut lease, Some(&observed), |_| {
                Ok(((), changes))
            })?;
            let pending = outbox::pending(c, target, *d)?;
            if pending.len() > before {
                mapping.insert(batch.seq, pending.last().unwrap().seq);
            }
        }
        if let Some(context) = contexts.get_mut(d) {
            for register in context.values_mut() {
                register.seen = remap(&register.seen, &old, floor, lease.actor(), &mapping);
                register.values.retain_mut(|value| {
                    if value.dot.actor == old && value.dot.seq > floor {
                        if let Some(seq) = mapping.get(&value.dot.seq) {
                            value.dot.actor = lease.actor().into();
                            value.dot.seq = *seq;
                            true
                        } else {
                            false
                        }
                    } else {
                        true
                    }
                });
                register.values.sort_by(|a, b| a.dot.cmp(&b.dot));
            }
        }
    }
    *instance = next;
    Ok((lease, true))
}
