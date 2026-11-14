//! One transactional entry point for fresh, account and guest databases.
use rusqlite::{Connection, Transaction, TransactionBehavior};

const VERSION: i64 = 4;

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
    let newest: i64 = if has_log { c.query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations",[],|r|r.get(0))? } else { 0 };
    if version > VERSION || newest > VERSION { return Err(rusqlite::Error::InvalidQuery); }

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
        if !has_created { c.execute_batch("ALTER TABLE collection_folders ADD COLUMN created_at TEXT;")?; }
        c.execute_batch(include_str!("../../migrations/0004_sync_runtime.sql"))?;
        c.execute_batch("INSERT OR IGNORE INTO schema_migrations(version) VALUES(4); PRAGMA user_version=4;")?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
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
                3
            );
            c.prepare("SELECT scope FROM collection_folders").unwrap();
        }
    }
    #[test]
    fn legacy_reopen_version_marker_does_not_replay_non_idempotent_steps() {
        let c=Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c.execute("INSERT INTO collection_folders(id,name,scope) VALUES('keep','保留我的资料','collections')",[]).unwrap();
        let before:String=c.query_row("SELECT created_at FROM collection_folders WHERE id='keep'",[],|r|r.get(0)).unwrap();
        // Existing 0.3.2 structure/log, but a historical executable restored marker 1.
        c.execute_batch("PRAGMA user_version=1").unwrap();
        migrate(&c).unwrap();migrate(&c).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),VERSION);
        assert_eq!(c.query_row("SELECT name,created_at FROM collection_folders WHERE id='keep'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(),("保留我的资料".into(),before));
        assert_eq!(c.query_row("SELECT COUNT(*) FROM schema_migrations",[],|r|r.get::<_,i64>(0)).unwrap(),3);
    }
    #[test]
    fn newer_migration_log_is_rejected_even_if_legacy_marker_was_reset() {
        let c=Connection::open_in_memory().unwrap();migrate(&c).unwrap();
        c.execute_batch("INSERT INTO schema_migrations(version) VALUES(7); PRAGMA user_version=1;").unwrap();
        assert!(migrate(&c).is_err());
        assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    #[ignore = "requires an explicitly supplied disposable database copy"]
    fn disposable_database_copy_preserves_user_rows_after_upgrade() {
        let path=std::env::var("BILIMUSIC_MIGRATION_FIXTURE_FILE").expect("supply a disposable copy, never the live database");
        let c=Connection::open(path).unwrap();
        let tables=["tracks","playlists","playlist_items","play_history","listening_buckets"];
        let counts=||tables.iter().map(|table|c.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap()).collect::<Vec<_>>();
        let before=counts();migrate(&c).unwrap();migrate(&c).unwrap();
        assert_eq!(counts(),before);
        assert_eq!(c.query_row("PRAGMA quick_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
        assert_eq!(c.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),VERSION);
    }
    #[test]
    fn newer_database_is_rejected_without_changes() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA user_version=7").unwrap();
        assert!(migrate(&c).is_err());
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
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
