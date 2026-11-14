//! Exact per-register causal contexts. Sparse deltas never delete omitted registers.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub fn hash(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct Dot {
    pub actor: String,
    pub seq: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Context(pub BTreeMap<String, Vec<(u64, u64)>>);
impl Context {
    pub fn contains(&self, d: &Dot) -> bool {
        self.0
            .get(&d.actor)
            .is_some_and(|ranges| ranges.iter().any(|(a, b)| *a <= d.seq && d.seq <= *b))
    }
    pub fn insert(&mut self, d: &Dot) {
        self.0
            .entry(d.actor.clone())
            .or_default()
            .push((d.seq, d.seq));
        self.normalize();
    }
    fn normalize(&mut self) {
        for ranges in self.0.values_mut() {
            ranges.sort_unstable();
            let mut result: Vec<(u64, u64)> = vec![];
            for &(a, b) in ranges.iter() {
                if let Some(last) = result.last_mut() {
                    if a <= last.1.saturating_add(1) {
                        last.1 = last.1.max(b);
                        continue;
                    }
                }
                result.push((a, b));
            }
            *ranges = result;
        }
    }
    pub fn union(&mut self, other: &Self) {
        for (actor, ranges) in &other.0 {
            self.0.entry(actor.clone()).or_default().extend(ranges);
        }
        self.normalize();
    }
    fn valid(&self) -> bool {
        self.0.len() <= 4096
            && self.0.iter().all(|(a, r)| {
                valid_actor(a)
                    && r.len() <= 8192
                    && r.iter().all(|(a, b)| *a > 0 && a <= b)
                    && r.windows(2).all(|w| w[0].1.saturating_add(1) < w[1].0)
            })
    }
}
fn valid_actor(a: &str) -> bool {
    uuid::Uuid::parse_str(a).is_ok()
        || a.strip_prefix("legacy:")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Cell {
    Value(Value),
    Missing,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub dot: Dot,
    pub cell: Cell,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub seen: Context,
    pub values: Vec<Candidate>,
}
impl Register {
    pub fn merge(&mut self, other: &Self) -> Result<(), String> {
        if !self.valid() || !other.valid() {
            return Err("因果寄存器无效".into());
        }
        for a in &self.values {
            for b in &other.values {
                if a.dot == b.dot && a.cell != b.cell {
                    return Err("同一操作身份出现不同内容".into());
                }
            }
        }
        let mut values = self
            .values
            .iter()
            .filter(|a| other.values.contains(a) || !other.seen.contains(&a.dot))
            .cloned()
            .collect::<Vec<_>>();
        values.extend(
            other
                .values
                .iter()
                .filter(|b| self.values.contains(b) || !self.seen.contains(&b.dot))
                .cloned(),
        );
        values.sort_by(|a, b| a.dot.cmp(&b.dot));
        values.dedup();
        if values.len() > 64 {
            return Err("并发候选过多，请先处理冲突".into());
        }
        self.seen.union(&other.seen);
        self.values = values;
        Ok(())
    }
    fn valid(&self) -> bool {
        self.seen.valid()
            && self.values.len() <= 64
            && self
                .values
                .iter()
                .all(|v| v.dot.seq > 0 && self.seen.contains(&v.dot))
            && self.values.windows(2).all(|w| w[0].dot < w[1].dot)
    }
    fn assigned(&self, dot: Dot, cell: Cell) -> Self {
        let mut seen = self.seen.clone();
        seen.insert(&dot);
        Self {
            seen,
            values: vec![Candidate { dot, cell }],
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Domain {
    Library,
    Progress,
    Statistics,
}
impl Domain {
    pub fn name(self) -> &'static str {
        match self {
            Self::Library => "library",
            Self::Progress => "progress",
            Self::Statistics => "statistics",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub uid: String,
    pub vault: String,
    pub seed: String,
    pub domain: Domain,
}
impl Scope {
    pub fn valid(&self) -> bool {
        !self.uid.is_empty()
            && self.uid.bytes().all(|c| c.is_ascii_digit())
            && uuid::Uuid::parse_str(&self.vault).is_ok()
            && valid_hash(&self.seed)
    }
}
pub fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub seq: u64,
    pub hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub schema: u32,
    pub scope: Scope,
    pub registers: BTreeMap<String, Register>,
    pub frontier: BTreeMap<String, Cursor>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub schema: u32,
    pub scope: Scope,
    pub actor: String,
    pub seq: u64,
    pub previous: Option<String>,
    pub dependencies: BTreeMap<String, u64>,
    pub registers: BTreeMap<String, Register>,
}
pub fn key(entity: &str, field: &str) -> String {
    serde_json::to_string(&(entity, field)).unwrap()
}
fn split(key: &str) -> Result<(String, String), String> {
    let (entity, field): (String, String) =
        serde_json::from_str(key).map_err(|_| "增量字段键无效")?;
    if entity.is_empty() || entity.len() > 256 || field.is_empty() || field.len() > 64 {
        return Err("增量字段键超限".into());
    }
    Ok((entity, field))
}
fn entity_contexts(
    registers: &BTreeMap<String, Register>,
) -> Result<BTreeMap<String, Context>, String> {
    let mut contexts: BTreeMap<String, Context> = BTreeMap::new();
    for (key, reg) in registers {
        contexts.entry(split(key)?.0).or_default().union(&reg.seen);
    }
    Ok(contexts)
}
impl Batch {
    pub fn hash(&self) -> Result<String, String> {
        Ok(hash(&serde_json::to_vec(self).map_err(|_| "增量编码失败")?))
    }
}
impl Document {
    pub fn empty(scope: Scope) -> Self {
        Self {
            schema: 2,
            scope,
            registers: BTreeMap::new(),
            frontier: BTreeMap::new(),
        }
    }
    pub fn valid(&self) -> bool {
        self.schema == 2
            && self.scope.valid()
            && self.registers.len() <= 150_000
            && self.frontier.len() <= 4096
            && self
                .frontier
                .iter()
                .all(|(a, c)| uuid::Uuid::parse_str(a).is_ok() && c.seq > 0 && valid_hash(&c.hash))
            && self.registers.iter().all(|(k, r)| {
                split(k).is_ok()
                    && r.valid()
                    && r.seen.0.iter().all(|(a, ranges)| {
                        a.starts_with("legacy:")
                            || self
                                .frontier
                                .get(a)
                                .is_some_and(|c| ranges.last().is_some_and(|r| r.1 <= c.seq))
                    })
            })
    }
    pub fn make_batch(
        &self,
        actor: &str,
        changes: BTreeMap<String, Cell>,
    ) -> Result<Option<Batch>, String> {
        if !self.valid() || uuid::Uuid::parse_str(actor).is_err() {
            return Err("增量写入身份或状态无效".into());
        }
        let seq = self
            .frontier
            .get(actor)
            .map_or(Ok(1), |c| c.seq.checked_add(1).ok_or("增量序号耗尽"))?;
        let mut registers = BTreeMap::new();
        let entities = entity_contexts(&self.registers)?;
        for (k, cell) in changes {
            let (entity, field) = split(&k)?;
            let original = self.registers.get(&k).cloned().unwrap_or_default();
            let mut before = original.clone();
            if field == "__present" {
                if let Some(context) = entities.get(&entity) {
                    before.seen.union(context);
                }
            }
            if !before.values.is_empty()
                && before.values.iter().all(|v| v.cell == cell)
                && before.seen == original.seen
            {
                continue;
            }
            registers.insert(
                k,
                before.assigned(
                    Dot {
                        actor: actor.into(),
                        seq,
                    },
                    cell,
                ),
            );
        }
        if registers.is_empty() {
            return Ok(None);
        }
        Ok(Some(Batch {
            schema: 2,
            scope: self.scope.clone(),
            actor: actor.into(),
            seq,
            previous: self.frontier.get(actor).map(|c| c.hash.clone()),
            dependencies: self
                .frontier
                .iter()
                .map(|(a, c)| (a.clone(), c.seq))
                .collect(),
            registers,
        }))
    }
    /// Local edits cover only field versions actually projected to the user. Transport
    /// dependencies may be newer; receiving a hidden conflict does not mean it was observed.
    pub fn make_observed_batch(
        &self,
        actor: &str,
        changes: BTreeMap<String, Cell>,
        observed: &BTreeMap<String, Register>,
    ) -> Result<Option<Batch>, String> {
        if changes.is_empty() {
            return Ok(None);
        }
        if !self.valid() || uuid::Uuid::parse_str(actor).is_err() || changes.len() > 150_000 {
            return Err("增量写入身份或状态无效".into());
        }
        let seq = self.frontier.get(actor).map_or(Ok(1), |cursor| {
            cursor.seq.checked_add(1).ok_or("增量序号耗尽")
        })?;
        // These are semantic changes from the last DISPLAYED business view. Equality
        // with a hidden received candidate is not a no-op: that candidate may already
        // have a causal successor the user has never seen. Preserve the local intent.
        let mut batch = Batch {
            schema: 2,
            scope: self.scope.clone(),
            actor: actor.into(),
            seq,
            previous: self.frontier.get(actor).map(|cursor| cursor.hash.clone()),
            dependencies: self
                .frontier
                .iter()
                .map(|(actor, cursor)| (actor.clone(), cursor.seq))
                .collect(),
            registers: BTreeMap::new(),
        };
        let entities = entity_contexts(observed)?;
        for (key, cell) in changes {
            let mut before = observed.get(&key).cloned().unwrap_or_default();
            let (entity, field) = split(&key)?;
            if field == "__present" {
                if let Some(context) = entities.get(&entity) {
                    before.seen.union(context);
                }
            }
            if !before.valid() {
                return Err("本机观察上下文无效".into());
            }
            let register = before.assigned(
                Dot {
                    actor: actor.into(),
                    seq: batch.seq,
                },
                cell,
            );
            batch.registers.insert(key, register);
        }
        Ok(Some(batch))
    }
    /// Validate dependencies and the hash chain before changing any field or cursor.
    pub fn apply(&mut self, b: &Batch) -> Result<bool, String> {
        if !self.valid()
            || b.schema != 2
            || b.scope != self.scope
            || uuid::Uuid::parse_str(&b.actor).is_err()
            || b.seq == 0
            || b.registers.is_empty()
            || b.registers.len() > 150_000
        {
            return Err("增量批次身份或范围无效".into());
        }
        let digest = b.hash()?;
        let current = self.frontier.get(&b.actor);
        if current.is_some_and(|c| b.seq <= c.seq) {
            if current.is_some_and(|c| b.seq == c.seq && digest != c.hash) {
                return Err("增量序号出现分叉".into());
            }
            return Ok(false);
        }
        if b.seq != current.map_or(1, |c| c.seq.saturating_add(1))
            || b.previous != current.map(|c| c.hash.clone())
        {
            return Err("增量序列存在缺口".into());
        }
        if b.dependencies.len() > 4096
            || b.dependencies.iter().any(|(a, n)| {
                uuid::Uuid::parse_str(a).is_err()
                    || *n == 0
                    || self.frontier.get(a).is_none_or(|c| c.seq < *n)
            })
        {
            return Err("增量因果依赖尚未完整接收".into());
        }
        let mut next = self.clone();
        for (k, r) in &b.registers {
            split(k)?;
            if !r.valid()
                || r.values.len() != 1
                || r.values[0].dot
                    != (Dot {
                        actor: b.actor.clone(),
                        seq: b.seq,
                    })
                || r.seen.0.iter().any(|(a, ranges)| {
                    !a.starts_with("legacy:")
                        && ranges.iter().any(|(_, end)| {
                            *end > if a == &b.actor {
                                b.seq
                            } else {
                                b.dependencies.get(a).copied().unwrap_or(0)
                            }
                        })
                })
            {
                return Err("增量寄存器上下文无效".into());
            }
            next.registers.entry(k.clone()).or_default().merge(r)?;
        }
        next.frontier.insert(
            b.actor.clone(),
            Cursor {
                seq: b.seq,
                hash: digest,
            },
        );
        if !next.valid() {
            return Err("增量应用后状态无效".into());
        }
        *self = next;
        Ok(true)
    }
    /// Only self-contained, verified checkpoints may use full-state join.
    pub fn join(&mut self, other: &Self) -> Result<(), String> {
        if self.scope != other.scope || !self.valid() || !other.valid() {
            return Err("检查点范围或格式无效".into());
        }
        let mut next = self.clone();
        for (a, c) in &other.frontier {
            if let Some(old) = next.frontier.get(a) {
                if old.seq == c.seq && old.hash != c.hash {
                    return Err("检查点操作身份出现分叉".into());
                }
                if old.seq > c.seq {
                    continue;
                }
            }
            next.frontier.insert(a.clone(), c.clone());
        }
        for (k, r) in &other.registers {
            next.registers.entry(k.clone()).or_default().merge(r)?;
        }
        if !next.valid() {
            return Err("检查点合并后状态无效".into());
        }
        *self = next;
        Ok(())
    }
    pub fn materialize(
        &self,
    ) -> Result<(BTreeMap<String, BTreeMap<String, Value>>, Vec<String>), String> {
        if !self.valid() {
            return Err("增量状态无效".into());
        }
        let mut rows: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
        let mut removed = std::collections::BTreeSet::new();
        let mut present = std::collections::BTreeSet::new();
        let mut conflicts = Vec::new();
        let mut grouped: BTreeMap<String, Vec<(String, &Register)>> = BTreeMap::new();
        for (k, r) in &self.registers {
            let (entity, field) = split(k)?;
            grouped
                .entry(entity.clone())
                .or_default()
                .push((field.clone(), r));
            if field == "__present" {
                let has_delete = r
                    .values
                    .iter()
                    .any(|v| v.cell == Cell::Value(Value::Bool(false)));
                let has_add = r
                    .values
                    .iter()
                    .any(|v| v.cell == Cell::Value(Value::Bool(true)));
                // Hide a concurrent deletion by default, but expose the conflict so joining
                // an upgraded device cannot silently discard its recoverable record.
                if has_delete && has_add && !entity.starts_with("favorite:") {
                    conflicts.push(k.clone());
                }
                if !(has_add && entity.starts_with("favorite:"))
                    && r.values
                        .iter()
                        .any(|v| v.cell == Cell::Value(Value::Bool(false)))
                {
                    removed.insert(entity.clone());
                }
                if r.values
                    .iter()
                    .any(|v| v.cell == Cell::Value(Value::Bool(true)))
                {
                    present.insert(entity);
                }
                continue;
            }
            if field == "__record" {
                continue;
            }
            let distinct = r
                .values
                .iter()
                .map(|v| serde_json::to_string(&v.cell).unwrap())
                .collect::<std::collections::BTreeSet<_>>();
            if distinct.len() > 1 {
                conflicts.push(k.clone());
            }
            if let Some(Candidate {
                cell: Cell::Value(value),
                ..
            }) = r.values.first()
            {
                rows.entry(entity).or_default().insert(field, value.clone());
            }
        }
        rows.retain(|id, _| present.contains(id) && !removed.contains(id));
        // A concurrent field edit never implicitly recreates a deleted record, but must
        // remain visible to conflict handling instead of being silently discarded.
        for entity in &removed {
            let presence = key(entity, "__present");
            let tombstone = &self.registers[&presence];
            let deletes = tombstone
                .values
                .iter()
                .filter(|v| v.cell == Cell::Value(Value::Bool(false)))
                .collect::<Vec<_>>();
            let concurrent = grouped[entity]
                .iter()
                .filter(|(field, _)| {
                    !matches!(field.as_str(), "__present" | "__record" | "__order")
                })
                .any(|(_, reg)| {
                    reg.values.iter().any(|edit| {
                        !tombstone.seen.contains(&edit.dot)
                            && deletes.iter().any(|delete| !reg.seen.contains(&delete.dot))
                    })
                });
            if concurrent && !entity.starts_with("favorite:") && !conflicts.contains(&presence) {
                conflicts.push(presence);
            }
        }
        Ok((rows, conflicts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    const C: &str = "00000000-0000-4000-8000-000000000003";
    fn doc() -> Document {
        Document::empty(Scope {
            uid: "42".into(),
            vault: A.into(),
            seed: "a".repeat(64),
            domain: Domain::Library,
        })
    }
    fn add(d: &mut Document, a: &str, name: &str) -> Batch {
        let b = d
            .make_batch(
                a,
                BTreeMap::from([
                    (
                        key("playlist:x", "__present"),
                        Cell::Value(Value::Bool(true)),
                    ),
                    (
                        key("playlist:x", "name"),
                        Cell::Value(Value::String(name.into())),
                    ),
                ]),
            )
            .unwrap()
            .unwrap();
        d.apply(&b).unwrap();
        b
    }
    #[test]
    fn sparse_delta_join_is_commutative_associative_and_idempotent() {
        let mut root = doc();
        add(&mut root, A, "initial");
        let mut variants = vec![];
        for (actor, value) in [(A, "a"), (B, "b"), (C, "c")] {
            let mut d = root.clone();
            let batch = d
                .make_batch(
                    actor,
                    BTreeMap::from([(
                        key("playlist:x", "name"),
                        Cell::Value(Value::String(value.into())),
                    )]),
                )
                .unwrap()
                .unwrap();
            d.apply(&batch).unwrap();
            variants.push(d);
        }
        let mut expected = variants[0].clone();
        expected.join(&variants[1]).unwrap();
        expected.join(&variants[2]).unwrap();
        for order in [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ] {
            let mut d = root.clone();
            for i in order {
                d.join(&variants[i]).unwrap();
            }
            d.join(&d.clone()).unwrap();
            assert_eq!(d, expected);
        }
        let mut right = variants[1].clone();
        right.join(&variants[2]).unwrap();
        let mut left = variants[0].clone();
        left.join(&right).unwrap();
        assert_eq!(left, expected);
        assert_eq!(expected.materialize().unwrap().1.len(), 1);
    }
    #[test]
    fn delete_beats_offline_edit_and_explicit_readd_observes_delete() {
        let mut d = doc();
        add(&mut d, A, "initial");
        let mut offline = d.clone();
        let delete = d
            .make_batch(
                A,
                BTreeMap::from([(
                    key("playlist:x", "__present"),
                    Cell::Value(Value::Bool(false)),
                )]),
            )
            .unwrap()
            .unwrap();
        d.apply(&delete).unwrap();
        let edit = offline
            .make_batch(
                B,
                BTreeMap::from([(
                    key("playlist:x", "name"),
                    Cell::Value(Value::String("edit".into())),
                )]),
            )
            .unwrap()
            .unwrap();
        offline.apply(&edit).unwrap();
        d.join(&offline).unwrap();
        assert!(d.materialize().unwrap().0.is_empty());
        let readd = d
            .make_batch(
                B,
                BTreeMap::from([(
                    key("playlist:x", "__present"),
                    Cell::Value(Value::Bool(true)),
                )]),
            )
            .unwrap()
            .unwrap();
        d.apply(&readd).unwrap();
        assert!(!d.materialize().unwrap().0.is_empty());
    }
    #[test]
    fn gaps_forks_wrong_scope_and_missing_dependencies_never_partially_apply() {
        let mut d = doc();
        let first = add(&mut d, A, "one");
        let second = add(&mut d, A, "two");
        let mut empty = doc();
        assert!(empty.apply(&second).is_err());
        assert_eq!(empty, doc());
        empty.apply(&first).unwrap();
        let saved = empty.clone();
        let mut fork = first.clone();
        fork.registers.values_mut().next().unwrap().values[0].cell = Cell::Missing;
        assert!(empty.apply(&fork).is_err());
        assert_eq!(empty, saved);
        let mut wrong = second.clone();
        wrong.scope.uid = "43".into();
        assert!(empty.apply(&wrong).is_err());
        assert_eq!(empty, saved);
        let mut missing = second;
        missing.dependencies.insert(B.into(), 9);
        assert!(empty.apply(&missing).is_err());
        assert_eq!(empty, saved);
    }
    #[test]
    fn missing_is_distinct_from_null_and_sparse_contexts_keep_holes() {
        let mut c = Context::default();
        for seq in [1, 3] {
            c.insert(&Dot {
                actor: A.into(),
                seq,
            });
        }
        assert!(!c.contains(&Dot {
            actor: A.into(),
            seq: 2
        }));
        let mut d = doc();
        add(&mut d, A, "x");
        let b = d
            .make_batch(
                A,
                BTreeMap::from([(key("playlist:x", "coverUrl"), Cell::Value(Value::Null))]),
            )
            .unwrap()
            .unwrap();
        d.apply(&b).unwrap();
        assert!(d.materialize().unwrap().0["playlist:x"].contains_key("coverUrl"));
        let b = d
            .make_batch(
                A,
                BTreeMap::from([(key("playlist:x", "coverUrl"), Cell::Missing)]),
            )
            .unwrap()
            .unwrap();
        d.apply(&b).unwrap();
        assert!(!d.materialize().unwrap().0["playlist:x"].contains_key("coverUrl"));
    }
}
