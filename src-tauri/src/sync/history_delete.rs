use super::{Config, Snapshot, text};
use crate::infrastructure::{
    database::account_session,
    repositories::{library::LibraryRepository, track_cleanup::collect_unreferenced},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeMap;

pub(super) type Deletions = BTreeMap<String, String>;

pub(super) fn can_sync(config: &Config) -> bool {
    config.enabled
        && config.initialized
        && config.history
        && !config.uid.is_empty()
        && matches!(config.provider.as_str(), "cloud" | "webdav")
}

pub(super) fn check_session(c: &Connection, expected: &str) -> Result<(), String> {
    if account_session(c).map_err(err)? != expected {
        return Err("账号已切换，请重试".into());
    }
    Ok(())
}

pub(super) fn syncable_rows(c: &Connection, ids: &[String]) -> Result<Deletions, String> {
    let mut q = c
        .prepare(
            "SELECT MAX(played_at) FROM play_history WHERE track_id=?1
         AND NOT EXISTS(SELECT 1 FROM local_audio WHERE track_id=?1)",
        )
        .map_err(err)?;
    let mut rows = BTreeMap::new();
    for id in ids {
        if let Some(time) = q
            .query_row([id], |r| r.get::<_, Option<String>>(0))
            .map_err(err)?
        {
            rows.insert(format!("history:{id}"), time);
        }
    }
    Ok(rows)
}

pub(super) fn remove_rows(c: &Connection, ids: &[String]) -> Result<usize, String> {
    let mut existing = c
        .prepare("SELECT 1 FROM play_history WHERE track_id=?1 LIMIT 1")
        .map_err(err)?;
    let mut candidates = Vec::new();
    for id in ids {
        if existing.exists([id]).map_err(err)? {
            candidates.push(id.clone());
        }
    }
    let removed = LibraryRepository::remove_history(c, &candidates).map_err(err)?;
    collect_unreferenced(c, &candidates).map_err(err)?;
    Ok(removed)
}

fn key(target: &str) -> String {
    format!("history-delete:{target}")
}

pub(super) fn pending(c: &Connection, target: &str) -> Result<Deletions, String> {
    let saved: Option<String> = c
        .query_row(
            "SELECT value FROM sync_info WHERE key=?1",
            [key(target)],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    saved
        .map(|json| serde_json::from_str(&json).map_err(err))
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(super) fn clear(c: &Connection, target: &str) -> Result<(), String> {
    c.execute("DELETE FROM sync_info WHERE key=?1", [key(target)])
        .map_err(err)?;
    Ok(())
}

/// Cloud's snapshot protocol has no tombstones. Persist the explicit intent until the
/// server acknowledges the merged snapshot. A replay on another device after the cutoff
/// enters the same normal merge as any new history.
pub(super) fn queue_cloud_delete(
    c: &Connection,
    target: &str,
    ids: &[String],
) -> Result<(), String> {
    let rows = syncable_rows(c, ids)?;
    if rows.is_empty() {
        return Ok(());
    }
    let now: String = c
        .query_row("SELECT strftime('%Y-%m-%d %H:%M:%f','now')", [], |r| {
            r.get(0)
        })
        .map_err(err)?;
    let mut deletions = pending(c, target)?;
    for (entity, latest) in rows {
        let cutoff = deletions.entry(entity).or_default();
        *cutoff = std::cmp::max(std::mem::take(cutoff), std::cmp::max(latest, now.clone()));
    }
    c.execute(
        "INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key(target), serde_json::to_string(&deletions).map_err(err)?],
    ).map_err(err)?;
    Ok(())
}

pub(super) fn remove_local(
    c: &Connection,
    ids: &[String],
    session: &str,
    cloud_target: Option<&str>,
) -> Result<usize, String> {
    let tx = c.unchecked_transaction().map_err(err)?;
    check_session(&tx, session)?;
    if let Some(target) = cloud_target {
        queue_cloud_delete(&tx, target, ids)?;
    }
    let removed = remove_rows(&tx, ids)?;
    tx.commit().map_err(err)?;
    Ok(removed)
}

/// The bounded recent list can lose rows for ordinary reasons. Only an explicit cloud
/// deletion may turn a locally absent history into a deletion of a remote record.
pub(super) fn merge_cloud_history(
    base: &mut Snapshot,
    local: &mut Snapshot,
    remote: &mut Snapshot,
    deletions: &Deletions,
    uses_second_precision: bool,
) {
    for (entity, cutoff) in deletions {
        base.records.remove(entity);
        let cutoff = if uses_second_precision {
            cutoff.get(..19).unwrap_or(cutoff)
        } else {
            cutoff
        };
        if remote
            .records
            .get(entity)
            .is_some_and(|record| text(record, "playedAt") <= cutoff)
        {
            remote.records.remove(entity);
        }
    }

    // History may be the only reference to the track on this device. A local list eviction
    // should not turn the missing track fields into a global metadata or lyric deletion.
    for (entity, record) in &remote.records {
        if record.kind == "history" && !local.records.contains_key(entity) {
            let id = text(record, "trackId");
            let track = format!("track:{id}");
            if !local.records.contains_key(&track) {
                base.records.remove(&track);
                base.records.remove(&format!("lyric:{id}"));
            }
        }
    }

    base.records.retain(|entity, before| {
        if before.kind != "history" {
            return true;
        }
        let Some(current) = local.records.get(entity) else {
            return false;
        };
        if remote.records.contains_key(entity) {
            return true;
        }
        // A stale resume update does not recreate the deleted history.
        if text(current, "playedAt") <= text(before, "playedAt") {
            local.records.remove(entity);
        }
        false
    });
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::model::{Record, merge};
    use serde_json::json;

    const ID: &str = "bilibili:BV123:1";
    const ENTITY: &str = "history:bilibili:BV123:1";
    const EARLY: &str = "2026-01-01 00:00:00.100";
    const DELETE: &str = "2026-01-01 00:00:00.200";
    const LATE: &str = "2026-01-01 00:00:00.300";

    fn snapshot(time: &str, resume: &str) -> Snapshot {
        let mut view = Snapshot::empty("42");
        view.records.insert(
            ENTITY.into(),
            Record {
                kind: "history".into(),
                fields: serde_json::from_value(
                    json!({"trackId": ID, "playedAt": time, "resume": resume}),
                )
                .unwrap(),
            },
        );
        view
    }

    fn resolve(
        mut base: Snapshot,
        mut local: Snapshot,
        mut remote: Snapshot,
        deletions: Deletions,
    ) -> Snapshot {
        merge_cloud_history(&mut base, &mut local, &mut remote, &deletions, false);
        let (merged, conflicts) = merge(&base, &local, &remote, None);
        assert!(conflicts.is_empty());
        merged
    }

    #[test]
    fn history_delete_scope_is_shared_by_both_providers_and_respects_settings() {
        for provider in ["cloud", "webdav"] {
            let mut cfg = Config {
                provider: provider.into(),
                uid: "42".into(),
                enabled: true,
                initialized: true,
                history: true,
                ..Config::default()
            };
            assert!(can_sync(&cfg));
            cfg.history = false;
            assert!(!can_sync(&cfg));
            cfg.history = true;
            cfg.enabled = false;
            assert!(!can_sync(&cfg));
            cfg.enabled = true;
            cfg.initialized = false;
            assert!(!can_sync(&cfg));
        }
    }

    #[test]
    fn cloud_history_delete_persists_intent_and_is_account_scoped() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute_batch(
            "INSERT INTO source_items(id,provider,bvid,cid) VALUES('bilibili:BV123:1','bilibili','BV123',1);
             INSERT INTO tracks(id,source_item_id,title) VALUES('bilibili:BV123:1','bilibili:BV123:1','Test');
             INSERT INTO play_history(track_id,played_at) VALUES('bilibili:BV123:1','2026-01-01 00:00:00.100');",
        ).unwrap();
        assert!(
            remove_local(
                &c,
                &[ID.into()],
                "previous-session",
                Some("verified-target")
            )
            .is_err()
        );
        assert!(pending(&c, "verified-target").unwrap().is_empty());
        let session = account_session(&c).unwrap();
        assert_eq!(
            remove_local(&c, &[ID.into()], &session, Some("verified-target")).unwrap(),
            1
        );
        assert!(syncable_rows(&c, &[ID.into()]).unwrap().is_empty());
        assert!(pending(&c, "verified-target").unwrap().contains_key(ENTITY));
        assert!(pending(&c, "other-target").unwrap().is_empty());
        clear(&c, "verified-target").unwrap();
        assert!(pending(&c, "verified-target").unwrap().is_empty());
    }

    #[test]
    fn cloud_history_delete_ignores_local_eviction_and_removes_only_explicit_older_remote_rows() {
        let old = snapshot(EARLY, "100:200");
        let empty = Snapshot::empty("42");
        let deletions = Deletions::from([(ENTITY.into(), DELETE.into())]);
        assert_eq!(
            resolve(old.clone(), empty.clone(), old.clone(), Deletions::new()),
            old
        );
        assert_eq!(
            resolve(old.clone(), empty.clone(), old.clone(), deletions.clone()),
            empty
        );
        let replay = snapshot(LATE, "300:500");
        assert_eq!(
            resolve(old.clone(), replay.clone(), old.clone(), deletions.clone()),
            replay
        );
        assert_eq!(resolve(old, empty, replay.clone(), deletions), replay);
    }

    #[test]
    fn cloud_history_delete_propagates_to_old_device_state_and_keeps_real_replay() {
        let old = snapshot(EARLY, "100:200");
        let stale_resume = snapshot(EARLY, "300:500");
        let empty = Snapshot::empty("42");
        assert_eq!(
            resolve(old.clone(), stale_resume, empty.clone(), Deletions::new()),
            empty
        );
        let replay = snapshot(LATE, "300:500");
        assert_eq!(
            resolve(old, replay.clone(), empty, Deletions::new()),
            replay
        );
    }
}
