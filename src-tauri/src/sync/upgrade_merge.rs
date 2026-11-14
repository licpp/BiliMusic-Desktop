//! Conservative one-time LOCAL snapshot merge when an old installation has no causal archive.
//! No WebDAV reads or writes: callers must freeze inputs and persist the join/outbox atomically.
//! The remote input must be a verified, conflict-free v2 projection for the supplied scope.
use super::{
    causal::{self, Cell},
    model::{text, Record, Snapshot},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    Local,
    Remote,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decisions {
    pub input_hash: String,
    pub choices: BTreeMap<String, Choice>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    UnknownAncestry,
    ConcurrentEdit,
    DeleteVsEdit,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub entity: String,
    pub field: String,
    pub local: Cell,
    pub remote: Cell,
    pub reason: Reason,
    pub choice: Option<Choice>,
}

/// A preview, not permission to publish. Recompute if frozen local/remote fingerprints change.
pub struct Plan {
    merged: Snapshot,
    conflicts: Vec<Conflict>,
    input_hash: String,
    remote: Snapshot,
}
impl Plan {
    pub fn merged(&self) -> &Snapshot {
        &self.merged
    }
    pub fn conflicts(&self) -> &[Conflict] {
        &self.conflicts
    }
    pub fn fingerprint(&self) -> &str {
        &self.input_hash
    }
    pub fn decisions(&self, choices: BTreeMap<String, Choice>) -> Decisions {
        Decisions {
            input_hash: self.input_hash.clone(),
            choices,
        }
    }
    pub fn ready(&self) -> bool {
        self.conflicts.iter().all(|c| c.choice.is_some())
    }
    pub fn changes(&self) -> Result<BTreeMap<String, Cell>, String> {
        if !self.ready() {
            return Err("请先处理设备升级合并冲突".into());
        }
        self.merged.validate(&self.remote.uid)?;
        // Reject, rather than silently compact away, records whose parent was removed.
        for record in self.merged.records.values() {
            let parent = match record.kind.as_str() {
                "item" => Some(format!("playlist:{}", text(record, "playlistId"))),
                "collection" if !text(record, "folderId").is_empty() => {
                    Some(format!("collectionFolder:{}", text(record, "folderId")))
                }
                "collectionProgress" => Some(format!("collection:{}", text(record, "reference"))),
                _ => None,
            };
            if parent.is_some_and(|key| !self.merged.records.contains_key(&key)) {
                return Err("合并内容引用了已删除的歌单或文件夹，请一并处理恢复内容".into());
            }
        }
        let mut delta = BTreeMap::new();
        let entities: BTreeSet<_> = self
            .remote
            .records
            .keys()
            .chain(self.merged.records.keys())
            .collect();
        for entity in entities {
            let before = self.remote.records.get(entity);
            let after = self.merged.records.get(entity);
            if before == after {
                continue;
            }
            if before.is_none() || after.is_none() {
                delta.insert(
                    causal::key(entity, "__present"),
                    Cell::Value(after.is_some().into()),
                );
            }
            if let Some(after) = after {
                let fields: BTreeSet<_> = after
                    .fields
                    .keys()
                    .chain(before.into_iter().flat_map(|r| r.fields.keys()))
                    .collect();
                for field in fields {
                    let old = before.and_then(|r| r.fields.get(field));
                    let new = after.fields.get(field);
                    if old != new {
                        delta.insert(causal::key(entity, field), cell(new));
                    }
                }
            }
        }
        super::projection::complete_lyric_selection(
            &mut delta,
            &super::projection::facts(&self.merged, causal::Domain::Library),
        )?;
        Ok(delta)
    }
}

fn cell<T: Serialize>(value: Option<&T>) -> Cell {
    value.map_or(Cell::Missing, |v| {
        Cell::Value(serde_json::to_value(v).expect("serializable model"))
    })
}
/// High-risk list: deletion/recovery and immutable identity/relationships.
/// Ordinary editable metadata automatically converges; schema validation still
/// rejects unknown wire fields, so this cannot silently authorize new formats.
pub const HIGH_RISK_FIELDS: &[&str] = &[
    "__present",
    "__record",
    "__parent",
    "id",
    "bvid",
    "cid",
    "trackId",
    "playlistId",
    "folderId",
    "reference",
    "scope",
];
pub fn automatic_field(field: &str) -> bool {
    !HIGH_RISK_FIELDS.contains(&field)
}

/// For legacy inputs with no provable ancestry, retain the established cloud
/// value for small editable fields. Independent local additions still merge.
pub fn prepare_automatic(
    scope: &causal::Scope,
    anchor: &Snapshot,
    previous: Option<&Snapshot>,
    local: &Snapshot,
    remote: &Snapshot,
    deleted: &BTreeSet<String>,
    resolutions: Option<&Decisions>,
) -> Result<Plan, String> {
    // A legacy snapshot has no causal deletion proof. On first joining V2,
    // a missing row means "not present here", not permission to erase the
    // other side. Only verified V2 tombstones retain delete/re-add conflicts.
    // Likes are reversible bookmarks. During legacy joining, an existing local
    // like wins even a cloud tombstone; subsequent V2 unlikes remain causal edits.
    let protected_deleted: BTreeSet<_> = deleted
        .iter()
        .filter(|key| !key.starts_with("favorite:"))
        .cloned()
        .collect();
    let deleted = &protected_deleted;
    let one_sided: BTreeSet<_> = local
        .records
        .keys()
        .chain(remote.records.keys())
        .filter(|key| local.records.contains_key(*key) != remote.records.contains_key(*key))
        .filter(|key| !deleted.contains(*key))
        .cloned()
        .collect();
    let mut anchor = anchor.clone();
    let mut previous = previous.cloned();
    anchor.records.retain(|key, _| !one_sided.contains(key));
    if let Some(base) = &mut previous {
        base.records.retain(|key, _| !one_sided.contains(key));
    }
    let anchor = &anchor;
    let previous = previous.as_ref();
    let mut first = prepare(scope, anchor, previous, local, remote, deleted, resolutions)?;
    let mut choices = resolutions.map(|r| r.choices.clone()).unwrap_or_default();
    for conflict in first
        .conflicts()
        .iter()
        .filter(|c| automatic_field(&c.field))
    {
        // Prefer an actual value to an unset low-risk field. Empty folder IDs
        // and existence=false are meaningful and are deliberately excluded.
        let unset = |cell: &Cell| {
            matches!(cell, Cell::Missing | Cell::Value(Value::Null))
                || matches!(cell, Cell::Value(Value::String(s)) if s.trim().is_empty())
        };
        let choice =
            if conflict.field != "folderId" && unset(&conflict.remote) && !unset(&conflict.local) {
                Choice::Local
            } else {
                Choice::Remote
            };
        choices.entry(conflict.id.clone()).or_insert(choice);
    }
    if choices.is_empty() {
        coherent_legacy_lyrics(&mut first, local, remote);
        return Ok(first);
    }
    let decisions = first.decisions(choices);
    let mut plan = prepare(
        scope,
        anchor,
        previous,
        local,
        remote,
        deleted,
        Some(&decisions),
    )?;
    plan.conflicts.retain(|c| !automatic_field(&c.field));
    coherent_legacy_lyrics(&mut plan, local, remote);
    Ok(plan)
}
fn coherent_legacy_lyrics(plan: &mut Plan, local: &Snapshot, remote: &Snapshot) {
    for (key, row) in plan
        .merged
        .records
        .iter_mut()
        .filter(|(_, row)| row.kind == "lyric")
    {
        let (Some(l), Some(r)) = (local.records.get(key), remote.records.get(key)) else {
            continue;
        };
        let pair = |row: &Record| {
            (
                row.fields.get("provider").cloned(),
                row.fields.get("providerLyricId").cloned(),
            )
        };
        if pair(row) == pair(l) || pair(row) == pair(r) {
            continue;
        }
        let source =
            if text(r, "providerLyricId").is_empty() && !text(l, "providerLyricId").is_empty() {
                l
            } else {
                r
            };
        for field in ["provider", "providerLyricId"] {
            if let Some(value) = source.fields.get(field) {
                row.fields.insert(field.into(), value.clone());
            } else {
                row.fields.remove(field);
            }
        }
    }
}
struct Merge<'a> {
    known_base: bool,
    decisions: &'a BTreeMap<String, Choice>,
    conflicts: Vec<Conflict>,
}
impl Merge<'_> {
    fn pick<T: PartialEq + Clone + Serialize>(
        &mut self,
        entity: &str,
        field: &str,
        anchor: Option<&T>,
        base: Option<&T>,
        local: Option<&T>,
        remote: Option<&T>,
        tombstone: bool,
    ) -> Option<T> {
        if local == remote {
            return local.cloned();
        }
        let uncertain = !self.known_base || (local == base && base != anchor);
        // A snapshot cannot prove that a local addition happened AFTER a v2 tombstone.
        // Only an explicit conflict choice may turn it into a re-add.
        let would_restore = tombstone && local.is_some() && remote.is_none();
        if (self.known_base && local == base && base == anchor)
            || (!self.known_base && local == anchor)
        {
            return remote.cloned();
        }
        if !would_restore {
            if self.known_base && local != base && remote == base {
                return local.cloned();
            }
            if !self.known_base {
                if local.is_none() || local == anchor {
                    return remote.cloned();
                }
                if remote.is_none() && anchor.is_none() {
                    return local.cloned();
                }
            }
        }
        let id = causal::key(entity, field);
        let choice = self.decisions.get(&id).copied();
        self.conflicts.push(Conflict {
            id,
            entity: entity.into(),
            field: field.into(),
            local: cell(local),
            remote: cell(remote),
            reason: if uncertain {
                Reason::UnknownAncestry
            } else if field == "__record" {
                Reason::DeleteVsEdit
            } else {
                Reason::ConcurrentEdit
            },
            choice,
        });
        // Unresolved previews keep the current remote projection; changes() refuses to commit.
        if choice == Some(Choice::Local) {
            local.cloned()
        } else {
            remote.cloned()
        }
    }
}

/// `anchor` is the preserved bootstrap projection, NOT the last v1 sync baseline.
/// `deleted` comes from verified v2 existence registers; an absent row alone is insufficient.
pub fn prepare(
    scope: &causal::Scope,
    anchor: &Snapshot,
    previous: Option<&Snapshot>,
    local: &Snapshot,
    remote: &Snapshot,
    deleted: &BTreeSet<String>,
    resolutions: Option<&Decisions>,
) -> Result<Plan, String> {
    if !scope.valid() || scope.uid != local.uid {
        return Err("升级合并同步库身份无效".into());
    }
    let (mut anchor, mut local, mut remote) = (anchor.clone(), local.clone(), remote.clone());
    let mut previous = previous.cloned();
    for snapshot in [&mut anchor, &mut local, &mut remote]
        .into_iter()
        .chain(previous.iter_mut())
    {
        snapshot.normalize();
        snapshot.validate(&snapshot.uid)?;
    }
    if anchor.uid != local.uid
        || remote.uid != local.uid
        || previous.as_ref().is_some_and(|s| s.uid != local.uid)
    {
        return Err("升级合并账号不一致".into());
    }
    if deleted.iter().any(|key| remote.records.contains_key(key)) {
        return Err("远端存在状态矛盾".into());
    }
    let input_hash = causal::hash(
        &serde_json::to_vec(&(scope, &anchor, &previous, &local, &remote, deleted))
            .map_err(|_| "升级材料编码失败")?,
    );
    if resolutions.is_some_and(|r| r.input_hash != input_hash) {
        return Err("升级材料已变化，请重新预览并处理冲突".into());
    }
    let empty_choices = BTreeMap::new();
    let decisions = resolutions.map_or(&empty_choices, |r| &r.choices);
    let mut state = Merge {
        known_base: previous.is_some(),
        decisions,
        conflicts: vec![],
    };
    let keys: BTreeSet<_> = anchor
        .records
        .keys()
        .chain(previous.iter().flat_map(|s| s.records.keys()))
        .chain(local.records.keys())
        .chain(remote.records.keys())
        .collect();
    let mut merged = Snapshot::empty(&local.uid);
    for key in keys {
        let a = anchor.records.get(key);
        let b = previous.as_ref().and_then(|s| s.records.get(key));
        let l = local.records.get(key);
        let r = remote.records.get(key);
        let result = if let (Some(l), Some(r)) = (l, r) {
            if l.kind != r.kind
                || a.is_some_and(|a| a.kind != l.kind)
                || b.is_some_and(|b| b.kind != l.kind)
            {
                return Err("升级合并记录类型不一致".into());
            }
            // Bootstrap/join must use the same automatic progress reducer as
            // ordinary sync. Missing ancestry does not turn timestamps into
            // user-edited metadata. Presence/deletion handling remains below.
            if let Some(row) = super::model::merge_progress_records(l, r) {
                merged.records.insert(key.clone(), row);
                continue;
            }
            let fields: BTreeSet<_> = a
                .into_iter()
                .chain(b)
                .chain([l, r])
                .flat_map(|v| v.fields.keys())
                .collect();
            let mut row = Record {
                kind: l.kind.clone(),
                fields: BTreeMap::new(),
            };
            for field in fields {
                if let Some(value) = state.pick(
                    key,
                    field,
                    a.and_then(|v| v.fields.get(field)),
                    b.and_then(|v| v.fields.get(field)),
                    l.fields.get(field),
                    r.fields.get(field),
                    false,
                ) {
                    row.fields.insert(field.clone(), value);
                }
            }
            Some(row)
        } else {
            state.pick(key, "__record", a, b, l, r, deleted.contains(key))
        };
        if let Some(row) = result {
            merged.records.insert(key.clone(), row);
        }
    }
    // Surface dependent recovery together with the local child candidate, even when
    // an unresolved __record choice currently hides that child in the preview.
    // Otherwise choosing to restore a child could reveal an unselectable orphan later.
    for (entity, record) in &local.records {
        let parent = match record.kind.as_str() {
            "item" => Some(format!("playlist:{}", text(record, "playlistId"))),
            "collection" if !text(record, "folderId").is_empty() => {
                Some(format!("collectionFolder:{}", text(record, "folderId")))
            }
            _ => None,
        };
        let Some(parent) = parent.filter(|p| {
            !merged.records.contains_key(p)
                && !remote.records.contains_key(p)
                && (deleted.contains(p) || anchor.records.contains_key(p))
        }) else {
            continue;
        };
        if anchor.records.get(entity) == Some(record)
            && previous
                .as_ref()
                .and_then(|b| b.records.get(entity))
                .is_none_or(|r| Some(r) == anchor.records.get(entity))
        {
            continue;
        }
        let id = causal::key(entity, "__parent");
        let choice = decisions.get(&id).copied();
        state.conflicts.push(Conflict {
            id,
            entity: entity.clone(),
            field: "__parent".into(),
            local: Cell::Value(Value::String(parent.clone())),
            remote: Cell::Missing,
            reason: Reason::DeleteVsEdit,
            choice,
        });
        if choice == Some(Choice::Local) {
            if decisions.get(&causal::key(&parent, "__record")) == Some(&Choice::Remote)
                && state
                    .conflicts
                    .iter()
                    .any(|c| c.entity == parent && c.field == "__record")
            {
                return Err("恢复成员时，请同时保留它所属的歌单或文件夹".into());
            }
            if merged.records.contains_key(entity) {
                let recovered = local
                    .records
                    .get(&parent)
                    .or_else(|| anchor.records.get(&parent))
                    .ok_or("所属文件夹缺少恢复资料")?;
                merged.records.insert(parent, recovered.clone());
            }
        } else if choice == Some(Choice::Remote) {
            merged.records.remove(entity);
        }
    }
    if decisions
        .keys()
        .any(|id| !state.conflicts.iter().any(|c| &c.id == id))
    {
        return Err("升级合并冲突已变化，请重新预览".into());
    }
    Ok(Plan {
        merged,
        conflicts: state.conflicts,
        input_hash,
        remote,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    fn scope() -> causal::Scope {
        causal::Scope {
            uid: "42".into(),
            vault: ID.into(),
            seed: "a".repeat(64),
            domain: causal::Domain::Library,
        }
    }
    fn entity() -> String {
        format!("playlist:{ID}")
    }
    fn sample() -> Snapshot {
        Snapshot {
            schema: 1,
            uid: "42".into(),
            records: BTreeMap::from([(
                entity(),
                Record {
                    kind: "playlist".into(),
                    fields: serde_json::from_value(
                        json!({"id":ID,"name":"original","description":"","coverUrl":null}),
                    )
                    .unwrap(),
                },
            )]),
        }
    }
    fn edit(s: &mut Snapshot, field: &str, value: serde_json::Value) {
        s.records
            .get_mut(&entity())
            .unwrap()
            .fields
            .insert(field.into(), value);
    }
    fn plan(a: &Snapshot, b: Option<&Snapshot>, l: &Snapshot, r: &Snapshot) -> Plan {
        prepare(&scope(), a, b, l, r, &BTreeSet::new(), None).unwrap()
    }
    fn listening(time: &str, resume: Option<&str>) -> Snapshot {
        let mut s = sample();
        let id = "bilibili:BV1tZuKzgENQ:30969365811";
        s.records.insert(
            format!("track:{id}"),
            Record {
                kind: "track".into(),
                fields: serde_json::from_value(
                    json!({"id":id,"bvid":"BV1tZuKzgENQ","cid":30969365811i64}),
                )
                .unwrap(),
            },
        );
        let mut fields: BTreeMap<String, Value> =
            serde_json::from_value(json!({"trackId":id,"playedAt":time})).unwrap();
        if let Some(resume) = resume {
            fields.insert("resume".into(), json!(resume));
        }
        s.records.insert(
            format!("history:{id}"),
            Record {
                kind: "history".into(),
                fields,
            },
        );
        s
    }
    #[test]
    fn high_risk_list_excludes_ordinary_metadata_and_progress() {
        for field in [
            "name",
            "description",
            "overrideTitle",
            "overrideArtist",
            "overrideAlbum",
            "overrideCover",
            "creatorNote",
            "sortRule",
            "displayRank",
            "position",
            "provider",
            "providerLyricId",
            "biasMs",
            "manual",
            "playedAt",
            "resume",
            "checkpoint",
            "__order",
        ] {
            assert!(automatic_field(field), "{field}");
        }
        for field in HIGH_RISK_FIELDS {
            assert!(!automatic_field(field), "{field}");
        }
    }

    #[test]
    fn first_join_unions_every_one_sided_record_even_with_a_legacy_baseline() {
        let mut remote = listening("2026-11-14 10:32:28.751", Some("1794652504046:81350"));
        let track = "bilibili:BV1tZuKzgENQ:30969365811";
        let records = [
            (
                format!("favorite:{track}"),
                "favorite",
                json!({"trackId":track}),
            ),
            (
                "collection:BV1tZuKzgENQ".into(),
                "collection",
                json!({"bvid":"BV1tZuKzgENQ","folderId":""}),
            ),
            (
                "collectionProgress:BV1tZuKzgENQ".into(),
                "collectionProgress",
                json!({"reference":"BV1tZuKzgENQ","checkpoint":"1794652504046:BV1tZuKzgENQ:30969365811:81350"}),
            ),
            (
                format!("lyric:{track}"),
                "lyric",
                json!({"id":track,"provider":"netease","providerLyricId":"123","biasMs":0,"manual":true}),
            ),
        ];
        for (id, kind, fields) in records {
            remote.records.insert(
                id,
                Record {
                    kind: kind.into(),
                    fields: serde_json::from_value(fields).unwrap(),
                },
            );
        }
        let empty = Snapshot::empty("42");
        for (local, cloud) in [(&empty, &remote), (&remote, &empty)] {
            for base in [None, Some(&empty), Some(&remote)] {
                let p = prepare_automatic(
                    &scope(),
                    &remote,
                    base,
                    local,
                    cloud,
                    &BTreeSet::new(),
                    None,
                )
                .unwrap();
                assert!(p.ready());
                assert!(p.conflicts().is_empty());
                assert_eq!(p.merged(), &remote);
                p.changes().unwrap();
            }
        }
        let mut edited = remote.clone();
        edited
            .records
            .get_mut(&format!("lyric:{track}"))
            .unwrap()
            .fields
            .insert("providerLyricId".into(), json!("456"));
        let p = prepare_automatic(
            &scope(),
            &remote,
            Some(&remote),
            &edited,
            &empty,
            &BTreeSet::from([format!("lyric:{track}")]),
            None,
        )
        .unwrap();
        assert!(!p.ready()); // A verified deletion remains different from never set.
    }

    #[test]
    fn one_sided_favorite_survives_a_cloud_tombstone_without_confirmation() {
        let mut local = listening("2026-11-14 10:32:28", None);
        let id = "bilibili:BV1tZuKzgENQ:30969365811";
        let key = format!("favorite:{id}");
        local.records.insert(
            key.clone(),
            Record {
                kind: "favorite".into(),
                fields: serde_json::from_value(json!({"trackId":id})).unwrap(),
            },
        );
        let mut remote = local.clone();
        remote.records.remove(&key);
        for base in [None, Some(&remote), Some(&local)] {
            let p = prepare_automatic(
                &scope(),
                &remote,
                base,
                &local,
                &remote,
                &BTreeSet::from([key.clone()]),
                None,
            )
            .unwrap();
            assert!(p.ready());
            assert!(p.conflicts().is_empty());
            assert!(p.merged().records.contains_key(&key));
            p.changes().unwrap();
        }
    }

    #[test]
    fn unset_metadata_keeps_the_value_and_lyric_pairs_do_not_mix() {
        let base = sample();
        let mut local = base.clone();
        let mut remote = base.clone();
        edit(&mut local, "description", json!("my note"));
        edit(&mut remote, "description", Value::Null);
        let p = prepare_automatic(
            &scope(),
            &base,
            None,
            &local,
            &remote,
            &BTreeSet::new(),
            None,
        )
        .unwrap();
        assert!(p.ready());
        assert_eq!(
            text(&p.merged().records[&entity()], "description"),
            "my note"
        );
        let mut local = listening("2026-11-14 10:32:28", None);
        let mut remote = local.clone();
        let id = "bilibili:BV1tZuKzgENQ:30969365811";
        let key = format!("lyric:{id}");
        for (s, provider, lyric) in [
            (&mut local, "netease", json!("100")),
            (&mut remote, "qq", Value::Null),
        ] {
            s.records.insert(key.clone(),Record{kind:"lyric".into(),fields:serde_json::from_value(json!({"id":id,"provider":provider,"providerLyricId":lyric,"biasMs":0,"manual":true})).unwrap()});
        }
        let p = prepare_automatic(
            &scope(),
            &Snapshot::empty("42"),
            None,
            &local,
            &remote,
            &BTreeSet::new(),
            None,
        )
        .unwrap();
        assert!(p.ready());
        assert_eq!(text(&p.merged().records[&key], "provider"), "netease");
        assert_eq!(text(&p.merged().records[&key], "providerLyricId"), "100");
    }

    #[test]
    fn first_upgrade_automatically_merges_the_reported_history_without_other_devices_upgrading() {
        let local = listening("2026-11-13 14:24:33.807", Some("1794579880288:80523"));
        let remote = listening("2026-11-14 10:32:28.751", Some("1794652504046:81350"));
        let key = "history:bilibili:BV1tZuKzgENQ:30969365811";
        for anchor in [&sample(), &local, &remote] {
            for base in [None, Some(&local), Some(&remote)] {
                let p = plan(anchor, base, &local, &remote);
                assert!(p.ready());
                assert!(p.conflicts().is_empty());
                assert_eq!(p.merged().records[key], remote.records[key]);
                p.changes().unwrap();
                let reverse = plan(anchor, base, &remote, &local);
                assert_eq!(p.merged(), reverse.merged());
            }
        }
    }
    #[test]
    fn upgrade_progress_keeps_newer_backward_seek_and_does_not_reset_when_position_is_absent() {
        let local = listening("2026-11-14 11:00:00.000", Some("1794652504047:0"));
        let remote = listening("2026-11-14 10:32:28.751", Some("1794652504046:81350"));
        let key = "history:bilibili:BV1tZuKzgENQ:30969365811";
        let p = plan(&sample(), None, &local, &remote);
        assert!(p.ready());
        assert_eq!(p.merged().records[key], local.records[key]);
        let no_position = listening("2026-11-14 12:00:00.000", None);
        let p = plan(&sample(), None, &no_position, &remote);
        assert!(p.ready());
        assert_eq!(
            p.merged().records[key].fields["resume"],
            remote.records[key].fields["resume"]
        );
        assert_eq!(
            p.merged().records[key].fields["playedAt"],
            no_position.records[key].fields["playedAt"]
        );
        let replay = plan(&sample(), None, p.merged(), &remote);
        assert_eq!(replay.merged(), p.merged());
        assert!(replay.ready());
    }
    #[test]
    fn automatic_history_merge_preserves_real_metadata_and_deletion_conflicts() {
        let local = listening("2026-11-13 14:24:33.807", None);
        let mut remote = listening("2026-11-14 10:32:28.751", None);
        edit(&mut remote, "name", json!("remote edit"));
        let p = plan(&Snapshot::empty("42"), None, &local, &remote);
        assert_eq!(p.conflicts().len(), 1);
        assert_eq!(p.conflicts()[0].field, "name");
        let key = "history:bilibili:BV1tZuKzgENQ:30969365811";
        remote.records.remove(key);
        let p = prepare(
            &scope(),
            &sample(),
            None,
            &local,
            &remote,
            &BTreeSet::from([key.into()]),
            None,
        )
        .unwrap();
        assert!(p
            .conflicts()
            .iter()
            .any(|c| c.entity == key && c.field == "__record"));
    }
    #[test]
    fn automatic_metadata_join_keeps_cloud_ties_and_imports_one_sided_legacy_rows() {
        let anchor = sample();
        let mut local = anchor.clone();
        let mut remote = anchor.clone();
        edit(&mut local, "name", json!("local note"));
        edit(&mut remote, "name", json!("cloud note"));
        let p = prepare_automatic(
            &scope(),
            &anchor,
            None,
            &local,
            &remote,
            &BTreeSet::new(),
            None,
        )
        .unwrap();
        assert!(p.ready());
        assert_eq!(
            p.merged().records[&entity()].fields["name"],
            json!("cloud note")
        );
        assert!(p.changes().unwrap().is_empty());
        let absent = Snapshot::empty("42");
        let p = prepare_automatic(
            &scope(),
            &anchor,
            Some(&anchor),
            &absent,
            &remote,
            &BTreeSet::new(),
            None,
        )
        .unwrap();
        assert!(p.ready());
        assert_eq!(p.merged().records[&entity()], remote.records[&entity()]);
    }
    #[test]
    fn independent_fields_merge_and_unchanged_old_values_do_not_overwrite_v2() {
        let anchor = sample();
        let mut local = anchor.clone();
        edit(&mut local, "name", json!("old device edit"));
        let mut remote = anchor.clone();
        edit(&mut remote, "description", json!("v2 edit"));
        let p = plan(&anchor, Some(&anchor), &local, &remote);
        assert!(p.ready());
        assert_eq!(
            p.merged().records[&entity()].fields["description"],
            json!("v2 edit")
        );
        assert_eq!(
            p.changes().unwrap(),
            BTreeMap::from([(
                causal::key(&entity(), "name"),
                Cell::Value(json!("old device edit"))
            )])
        );
        assert!(plan(&anchor, Some(&anchor), &anchor, &remote)
            .changes()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn successful_v1_sync_after_bootstrap_is_not_mistaken_for_already_imported_data() {
        let anchor = sample();
        let mut local = anchor.clone();
        edit(&mut local, "name", json!("already uploaded to v1"));
        let p = plan(&anchor, Some(&local), &local, &anchor);
        assert!(!p.ready());
        assert!(p.changes().is_err());
        assert_eq!(p.conflicts()[0].reason, Reason::UnknownAncestry);
        let choices = p.decisions(BTreeMap::from([(
            p.conflicts()[0].id.clone(),
            Choice::Local,
        )]));
        let p = prepare(
            &scope(),
            &anchor,
            Some(&local),
            &local,
            &anchor,
            &BTreeSet::new(),
            Some(&choices),
        )
        .unwrap();
        assert!(p.ready());
        assert_eq!(
            p.merged().records[&entity()].fields["name"],
            json!("already uploaded to v1")
        );
    }
    #[test]
    fn concurrent_edits_preserve_candidates_and_choices_are_bound_to_current_input() {
        let anchor = sample();
        let mut local = anchor.clone();
        edit(&mut local, "name", json!("local"));
        let mut remote = anchor.clone();
        edit(&mut remote, "name", json!("remote"));
        let p = plan(&anchor, Some(&anchor), &local, &remote);
        let c = &p.conflicts()[0];
        assert_eq!(c.reason, Reason::ConcurrentEdit);
        assert_eq!(c.local, Cell::Value(json!("local")));
        assert_eq!(c.remote, Cell::Value(json!("remote")));
        assert!(p.changes().is_err());
        let choices = p.decisions(BTreeMap::from([(c.id.clone(), Choice::Remote)]));
        let resolved = prepare(
            &scope(),
            &anchor,
            Some(&anchor),
            &local,
            &remote,
            &BTreeSet::new(),
            Some(&choices),
        )
        .unwrap();
        assert!(resolved.changes().unwrap().is_empty());
        // Even when the conflict ID survives, a new value must invalidate the preview token.
        edit(&mut remote, "name", json!("new remote"));
        let fresh = plan(&anchor, Some(&anchor), &local, &remote);
        assert_ne!(p.fingerprint(), fresh.fingerprint());
        assert!(!fresh.ready());
        let mut another = scope();
        another.vault = "00000000-0000-4000-8000-000000000002".into();
        assert!(prepare(
            &another,
            &anchor,
            Some(&anchor),
            &local,
            &remote,
            &BTreeSet::new(),
            Some(&choices)
        )
        .is_err());
        assert!(prepare(
            &scope(),
            &anchor,
            Some(&anchor),
            &local,
            &remote,
            &BTreeSet::new(),
            Some(&choices)
        )
        .is_err());
    }
    #[test]
    fn delete_vs_edit_requires_a_choice_and_missing_baseline_does_not_infer_deletion() {
        let anchor = sample();
        let absent = Snapshot::empty("42");
        let mut remote = anchor.clone();
        edit(&mut remote, "name", json!("remote edit"));
        let p = plan(&anchor, Some(&anchor), &absent, &remote);
        assert_eq!(p.conflicts()[0].reason, Reason::DeleteVsEdit);
        assert!(!p.ready());
        assert!(plan(&anchor, None, &absent, &remote)
            .changes()
            .unwrap()
            .is_empty());
        let tombstones = BTreeSet::from([entity()]);
        assert!(prepare(
            &scope(),
            &anchor,
            Some(&anchor),
            &anchor,
            &absent,
            &tombstones,
            None
        )
        .unwrap()
        .changes()
        .unwrap()
        .is_empty());
        let mut local = anchor.clone();
        edit(&mut local, "name", json!("local edit"));
        let p = prepare(
            &scope(),
            &anchor,
            Some(&anchor),
            &local,
            &absent,
            &tombstones,
            None,
        )
        .unwrap();
        assert!(!p.ready());
        let choices = p.decisions(BTreeMap::from([(
            p.conflicts()[0].id.clone(),
            Choice::Local,
        )]));
        let resolved = prepare(
            &scope(),
            &anchor,
            Some(&anchor),
            &local,
            &absent,
            &tombstones,
            Some(&choices),
        )
        .unwrap();
        assert_eq!(
            resolved.changes().unwrap()[&causal::key(&entity(), "__present")],
            Cell::Value(json!(true))
        );
        // A creation not present at bootstrap may also collide with a later v2 tombstone.
        assert!(!prepare(
            &scope(),
            &absent,
            Some(&absent),
            &local,
            &absent,
            &tombstones,
            None
        )
        .unwrap()
        .ready());
    }
    #[test]
    fn missing_and_null_are_different_conflict_candidates_and_wrong_account_is_rejected() {
        let anchor = sample();
        let mut local = anchor.clone();
        local
            .records
            .get_mut(&entity())
            .unwrap()
            .fields
            .remove("coverUrl");
        let mut remote = anchor.clone();
        edit(
            &mut remote,
            "coverUrl",
            json!("https://example.com/cover.jpg"),
        );
        let p = plan(&anchor, Some(&anchor), &local, &remote);
        assert_eq!(p.conflicts()[0].local, Cell::Missing);
        assert_eq!(
            p.conflicts()[0].remote,
            Cell::Value(json!("https://example.com/cover.jpg"))
        );
        let mut wrong = remote;
        wrong.uid = "43".into();
        assert!(prepare(
            &scope(),
            &anchor,
            Some(&anchor),
            &local,
            &wrong,
            &BTreeSet::new(),
            None
        )
        .is_err());
    }
    #[test]
    fn upgrade_child_restore_also_requires_an_explicit_parent_choice() {
        let mut local = Snapshot::empty("42");
        let child = "collection:up:123";
        // Use a creator collection and folder to exercise the same dependency as
        // a new playlist member, while keeping the fixture independent of tracks.
        local.records.clear();
        let folder = format!("collectionFolder:{ID}");
        local.records.insert(
            folder.clone(),
            Record {
                kind: "collectionFolder".into(),
                fields: serde_json::from_value(json!({"id":ID,"name":"folder","scope":"creators"}))
                    .unwrap(),
            },
        );
        let anchor = local.clone();
        local.records.insert(
            child.into(),
            Record {
                kind: "collection".into(),
                fields: serde_json::from_value(json!({"bvid":"up:123","folderId":ID})).unwrap(),
            },
        );
        let remote = Snapshot::empty("42");
        let deleted = BTreeSet::from([folder.clone()]);
        let p = prepare(
            &scope(),
            &anchor,
            Some(&local),
            &local,
            &remote,
            &deleted,
            None,
        )
        .unwrap();
        assert!(p.conflicts().iter().any(|c| c.field == "__parent"));
        let choices = p.decisions(
            p.conflicts()
                .iter()
                .map(|c| (c.id.clone(), Choice::Local))
                .collect(),
        );
        let restored = prepare(
            &scope(),
            &anchor,
            Some(&local),
            &local,
            &remote,
            &deleted,
            Some(&choices),
        )
        .unwrap();
        assert!(restored.ready());
        assert!(restored.merged().records.contains_key(child));
        assert!(restored.merged().records.contains_key(&folder));
        restored.changes().unwrap();
    }
}
