//! One transactional entry point for fresh, account and guest databases.
use rusqlite::{Connection, Transaction, TransactionBehavior};

const VERSION: i64 = 13;

pub fn migrate(c: &Connection) -> rusqlite::Result<()> {
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // An older executable must never mutate a newer database.
    if version > VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
    // Another launch may have completed migration since the initial read.
    let tx = Transaction::new_unchecked(c, TransactionBehavior::Immediate)?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let has_log: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",[],|r|r.get(0))?;
    let newest: i64 = if has_log {
        c.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )?
    } else {
        0
    };
    if version > VERSION || newest > VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }

    if version < 2 {
        // Historical releases all reported version 1, including schema variants.
        // Idempotent creation plus column inspection recognizes those variants.
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))?;
        super::repositories::collections::separate_legacy_folders(c)?;
        crate::sync::storage::init(c).map_err(|_| rusqlite::Error::InvalidQuery)?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            INSERT OR IGNORE INTO schema_migrations(version) VALUES(2);
            PRAGMA user_version=2;")?;
    }
    if version < 3 {
        c.execute_batch(include_str!("../../migrations/0003_sync_v2.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(3); PRAGMA user_version=3;",
        )?;
    }
    if version < 4 {
        let has_created: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_folders') WHERE name='created_at')",[],|r|r.get(0))?;
        if !has_created {
            c.execute_batch("ALTER TABLE collection_folders ADD COLUMN created_at TEXT;")?;
        }
        c.execute_batch(include_str!("../../migrations/0004_sync_runtime.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(4); PRAGMA user_version=4;",
        )?;
    }
    if version < 5 {
        c.execute_batch(include_str!("../../migrations/0005_import_archive.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(5); PRAGMA user_version=5;",
        )?;
    }
    if version < 6 {
        let exists: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('lyrics') WHERE name='write_token')",
            [],
            |r| r.get(0),
        )?;
        if !exists {
            c.execute_batch("ALTER TABLE lyrics ADD COLUMN write_token TEXT NOT NULL DEFAULT '';")?;
        }
        c.execute_batch(include_str!("../../migrations/0006_lyrics_guard.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(6); PRAGMA user_version=6;",
        )?;
    }
    if version < 7 {
        c.execute_batch(include_str!("../../migrations/0007_source_titles.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(7); PRAGMA user_version=7;",
        )?;
    }
    if version < 8 {
        c.execute_batch(include_str!("../../migrations/0008_loudness_cache.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(8); PRAGMA user_version=8;",
        )?;
    }
    if version < 9 {
        c.execute_batch(include_str!("../../migrations/0009_visibility.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(9); PRAGMA user_version=9;",
        )?;
    }
    if version < 10 {
        c.execute_batch(include_str!("../../migrations/0010_import_entries.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(10); PRAGMA user_version=10;",
        )?;
    }
    if version < 11 {
        c.execute_batch(include_str!("../../migrations/0011_linked_batch_matching.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(11); PRAGMA user_version=11;",
        )?;
    }
    if version < 12 {
        c.execute_batch(include_str!("../../migrations/0012_chapters.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(12); PRAGMA user_version=12;",
        )?;
    }
    if newest < 13 {
        c.execute_batch(include_str!("../../migrations/0013_collection_progress.sql"))?;
        c.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES(13); PRAGMA user_version=13;",
        )?;
    } else if version < 13 {
        c.execute_batch("PRAGMA user_version=13;")?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_collection_checkpoint_survives_the_membership_migration() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql")).unwrap();
        c.execute_batch("INSERT INTO collections(bvid) VALUES('up:42'),('season:42:73');
            INSERT INTO collection_progress VALUES('season:42:73','BV1tZuKzgENQ',7,85000,1794355030000);
            PRAGMA user_version=1;").unwrap();
        migrate(&c).unwrap();
        c.execute("DELETE FROM collections WHERE bvid='season:42:73'", []).unwrap();
        migrate(&c).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT creator_ref,position_ms FROM collection_progress WHERE reference='season:42:73'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            ).unwrap(),
            ("up:42".to_owned(), 85_000)
        );
    }

    #[test]
    fn historical_variants_and_fresh_databases_converge() {
        for legacy in [false, true] {
            let c = Connection::open_in_memory().unwrap();
            if legacy {
                c.execute_batch("CREATE TABLE collection_folders(id TEXT PRIMARY KEY,name TEXT NOT NULL); PRAGMA user_version=1;").unwrap();
            }
            migrate(&c).unwrap();
            migrate(&c).unwrap();
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                VERSION
            );
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                VERSION - 1
            );
            c.prepare("SELECT scope FROM collection_folders").unwrap();
        }
    }
    #[test]
    fn legacy_reopen_version_marker_does_not_replay_non_idempotent_steps() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c.execute("INSERT INTO collection_folders(id,name,scope) VALUES('keep','保留我的资料','collections')",[]).unwrap();
        let before: String = c
            .query_row(
                "SELECT created_at FROM collection_folders WHERE id='keep'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // Existing 0.3.2 structure/log, but a historical executable restored marker 1.
        c.execute_batch("PRAGMA user_version=1").unwrap();
        migrate(&c).unwrap();
        migrate(&c).unwrap();
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            VERSION
        );
        assert_eq!(
            c.query_row(
                "SELECT name,created_at FROM collection_folders WHERE id='keep'",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("保留我的资料".into(), before)
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            VERSION - 1
        );
    }
    #[test]
    fn newer_migration_log_is_rejected_even_if_legacy_marker_was_reset() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c.execute_batch(&format!(
            "INSERT INTO schema_migrations(version) VALUES({}); PRAGMA user_version=1;",
            VERSION + 1
        ))
        .unwrap();
        assert!(migrate(&c).is_err());
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    #[ignore = "requires an explicitly supplied disposable database copy"]
    fn disposable_database_copy_preserves_user_rows_after_upgrade() {
        let path = std::env::var("BILIMUSIC_MIGRATION_FIXTURE_FILE")
            .expect("supply a disposable copy, never the live database");
        let c = Connection::open(path).unwrap();
        let tables = [
            "tracks",
            "playlists",
            "playlist_items",
            "play_history",
            "listening_buckets",
        ];
        let counts = || {
            tables
                .iter()
                .map(|table| {
                    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                        r.get::<_, i64>(0)
                    })
                    .unwrap()
                })
                .collect::<Vec<_>>()
        };
        let before = counts();
        migrate(&c).unwrap();
        migrate(&c).unwrap();
        assert_eq!(counts(), before);
        assert_eq!(
            c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            VERSION
        );
    }
    #[test]
    fn source_title_cache_upgrade_preserves_version_six_user_data() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c.execute_batch("INSERT INTO source_items(id,provider,bvid,cid) VALUES('keep','bilibili','BVkeep',1);
            INSERT INTO tracks(id,source_item_id,title) VALUES('keep','keep','原始标题');
            INSERT INTO metadata_overrides(track_id,title) VALUES('keep','我的名称');
            INSERT INTO favorites(track_id) VALUES('keep');
            DROP TABLE source_title_cache;DELETE FROM schema_migrations WHERE version=7;PRAGMA user_version=6;").unwrap();
        migrate(&c).unwrap();
        migrate(&c).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT title FROM metadata_overrides WHERE track_id='keep'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "我的名称"
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM favorites", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM source_title_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn newer_database_is_rejected_without_changes() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(&format!("PRAGMA user_version={}", VERSION + 1))
            .unwrap();
        assert!(migrate(&c).is_err());
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            VERSION + 1
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn file_database_and_failed_legacy_conversion_are_transactional() {
        let path = std::env::temp_dir().join(format!("migration-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let c = Connection::open(&path).unwrap();
            migrate(&c).unwrap();
        }
        {
            let c = Connection::open(&path).unwrap();
            migrate(&c).unwrap();
            assert_eq!(
                c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                VERSION
            );
        }
        std::fs::remove_file(path).unwrap();
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE collection_folders(id TEXT PRIMARY KEY); PRAGMA user_version=1;",
        )
        .unwrap();
        assert!(migrate(&c).is_err());
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='tracks'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
