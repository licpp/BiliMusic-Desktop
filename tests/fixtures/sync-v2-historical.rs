//! Compiled into three isolated source snapshots by scripts/test-sync-history.mjs.
use super::{Config, Database, engine, migration::Genesis, test_dav, transport::Secret};
use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

const SHARED_LIST: &str = "00000000-0000-4000-8000-000000000111";
const OFFLINE_LIST: &str = "00000000-0000-4000-8000-000000000112";

fn schema(connection: &Connection) -> i64 {
    connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

fn named(connection: &Connection, id: &str) -> String {
    connection
        .query_row("SELECT name FROM playlists WHERE id=?1", [id], |r| r.get(0))
        .unwrap()
}

fn actor(connection: &Connection) -> String {
    connection
        .query_row(
            "SELECT actor FROM sync_v2_documents WHERE domain='library'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

async fn sync(database: &Database, cfg: &Config, secret: &Secret) {
    let result = engine::sync(database, cfg, secret, None, false)
        .await
        .unwrap();
    assert!(result.conflicts.is_empty(), "unexpected V2 conflicts");
}

async fn serve(root: &Path) {
    let (mut config, secret, store, server) = test_dav::server().await;
    config.history = true;
    let genesis = Genesis::for_config(&config).unwrap();
    let base = format!("/dav/BiliMusic-sync-v1/{}/sync-v2/", config.uid);
    let vault = format!("{base}{}/", genesis.vault);
    // Older engines expect 404 for an absent object in a provisioned directory.
    store.lock().unwrap().dirs.extend([
        base,
        format!("{vault}bootstrap/"),
        format!("{vault}control/"),
        vault,
    ]);
    let ready = root.join("ready.tmp");
    fs::write(&ready, serde_json::to_vec(&(config, secret)).unwrap()).unwrap();
    fs::rename(ready, root.join("ready.json")).unwrap();
    let done = root.join("done");
    let outcome = loop {
        match fs::read_to_string(&done) {
            Ok(outcome) => break outcome,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => panic!("could not read replay status: {error}"),
        }
    };
    let store = store.lock().unwrap();
    if outcome == "failed" {
        eprintln!("Local WebDAV requests: {:?}", store.requests);
    } else {
        assert!(
            store.files.keys().any(|name| name.contains("/sync-v2/")),
            "historical replay did not write V2 objects"
        );
    }
    server.abort();
}

#[tokio::test]
async fn replay() {
    let root = PathBuf::from(std::env::var_os("BILIMUSIC_SYNC_HISTORY_ROOT").unwrap());
    let mode = std::env::var("BILIMUSIC_SYNC_HISTORY_MODE").unwrap();
    assert!(root.join("history-test-marker").is_file());
    if mode == "serve" {
        return tokio::time::timeout(Duration::from_secs(45), serve(&root))
            .await
            .expect("historical sync server timed out");
    }
    let (config, secret): (Config, Secret) =
        serde_json::from_slice(&fs::read(root.join("ready.json")).unwrap()).unwrap();
    let directory = root.join("app-data");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("active-profile"), &config.uid).unwrap();
    let db = Database(
        Mutex::new(Connection::open(directory.join("profile-42.sqlite3")).unwrap()),
        directory,
    );
    let original_schema = schema(&db.0.lock().unwrap());
    if mode == "reject" {
        assert!(original_schema > 4);
        let connection = db.0.lock().unwrap();
        assert!(crate::infrastructure::migrations::migrate(&connection).is_err());
        assert_eq!(schema(&connection), original_schema);
        assert_eq!(named(&connection, SHARED_LIST), "新版修改");
        return;
    }
    crate::infrastructure::migrations::migrate(&db.0.lock().unwrap()).unwrap();
    let migrated_schema = schema(&db.0.lock().unwrap());
    {
        let connection = db.0.lock().unwrap();
        match mode.as_str() {
            "seed" => {
                assert_eq!(migrated_schema, 4);
                connection
                    .execute(
                        "INSERT INTO sync_settings VALUES(1,?1)",
                        [serde_json::to_string(&config).unwrap()],
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO playlists(id,name) VALUES(?1,'旧版歌单')",
                        [SHARED_LIST],
                    )
                    .unwrap();
            }
            "upgrade" => {
                assert_eq!(original_schema, 4);
                assert!(migrated_schema > 4);
                assert_eq!(named(&connection, SHARED_LIST), "旧版歌单");
                assert_eq!(named(&connection, OFFLINE_LIST), "旧版离线新增");
            }
            "rollback" => {
                assert_eq!(migrated_schema, 4);
                assert_eq!(named(&connection, SHARED_LIST), "旧版歌单");
            }
            "rejoin" => assert!(migrated_schema > 4),
            _ => panic!("unknown historical replay step"),
        }
    }
    sync(&db, &config, &secret).await;
    {
        let connection = db.0.lock().unwrap();
        match mode.as_str() {
            "seed" => {
                fs::write(root.join("original-actor"), actor(&connection)).unwrap();
                connection
                    .execute(
                        "INSERT INTO playlists(id,name) VALUES(?1,'旧版离线新增')",
                        [OFFLINE_LIST],
                    )
                    .unwrap();
            }
            "upgrade" => {
                connection
                    .execute(
                        "UPDATE playlists SET name='新版修改' WHERE id=?1",
                        [SHARED_LIST],
                    )
                    .unwrap();
            }
            "rollback" => {
                assert_eq!(named(&connection, SHARED_LIST), "新版修改");
                assert_eq!(named(&connection, OFFLINE_LIST), "旧版离线新增");
                assert_ne!(
                    actor(&connection),
                    fs::read_to_string(root.join("original-actor")).unwrap(),
                    "a restored database must allocate a fresh writer"
                );
                connection
                    .execute(
                        "UPDATE playlists SET name='回退后再次修改' WHERE id=?1",
                        [OFFLINE_LIST],
                    )
                    .unwrap();
            }
            "rejoin" => {
                assert_eq!(named(&connection, SHARED_LIST), "新版修改");
                assert_eq!(named(&connection, OFFLINE_LIST), "回退后再次修改");
            }
            _ => unreachable!(),
        }
    }
    if matches!(mode.as_str(), "upgrade" | "rollback") {
        sync(&db, &config, &secret).await;
    }
    db.0.lock()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    eprintln!(
        "BiliMusic {} {mode}: SQLite {original_schema} → {migrated_schema}",
        env!("CARGO_PKG_VERSION")
    );
}
