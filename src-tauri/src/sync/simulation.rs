//! Deterministic offline simulations. Only loopback WebDAV and disposable SQLite
//! profiles are used; every failing seed can be replayed without any cloud account.
use super::{
    Config, Database,
    causal::{self, Cell, Document, Domain, Scope},
    engine,
    model::Snapshot,
    storage,
    test_dav::{self, Failure, Fault},
    transport::Secret,
};
use rusqlite::Connection;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

const LIST: &str = "00000000-0000-4000-8000-000000000001";
fn seeds(default: u64) -> std::ops::Range<u64> {
    let count = std::env::var("BILIMUSIC_SYNC_SIM_SEEDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
        .clamp(1, 4096);
    let start = std::env::var("BILIMUSIC_SYNC_SIM_START")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    start
        ..start
            .checked_add(count)
            .expect("invalid simulation seed range")
}

struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut n = self.0;
        n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
        n ^ (n >> 31)
    }
    fn index(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}
struct Profile(Database);
impl Profile {
    fn new(cfg: &Config) -> Self {
        let path =
            std::env::temp_dir().join(format!("bilimusic-simulation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("active-profile"), &cfg.uid).unwrap();
        let c = Connection::open(path.join("profile.sqlite")).unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute(
            "INSERT INTO sync_settings VALUES(1,?1)",
            [serde_json::to_string(cfg).unwrap()],
        )
        .unwrap();
        Self(Database(std::sync::Mutex::new(c), path))
    }
    fn sql(&self, sql: &str) {
        self.0.0.lock().unwrap().execute_batch(sql).unwrap();
    }
    fn snapshot(&self, cfg: &Config) -> Snapshot {
        storage::export(&self.0.0.lock().unwrap(), &cfg.uid, cfg.history).unwrap()
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        let c = std::mem::replace(
            self.0
                .0
                .get_mut()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            Connection::open_in_memory().unwrap(),
        );
        let _ = c.close();
        if std::thread::panicking() {
            eprintln!("retained synthetic failing profile: {}", self.0.1.display());
        } else {
            let _ = std::fs::remove_dir_all(&self.0.1);
        }
    }
}
async fn sync(p: &Profile, cfg: &Config, secret: &Secret) -> super::Outcome {
    tokio::time::timeout(
        Duration::from_secs(5),
        engine::sync(&p.0, cfg, secret, None, false),
    )
    .await
    .expect("sync stalled")
    .unwrap()
}

#[tokio::test]
async fn followed_collection_progress_round_trips_without_creating_favorites() {
    use crate::infrastructure::repositories::collections::{change, progress, save_progress};
    let (mut cfg, secret, store, server) = test_dav::server().await;
    cfg.history = true;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    let first = "season:42:73";
    let second = "season:42:74";
    let first_key = format!("collectionProgress:{first}");
    let second_key = format!("collectionProgress:{second}");
    let insert = |profile: &Profile, reference, track, seconds, time| {
        assert!(save_progress(&profile.0.0.lock().unwrap(), reference, track, seconds, time).unwrap());
    };
    a.sql("INSERT INTO collections(bvid) VALUES('up:42')");
    insert(&a, first, "bilibili:BV1tZuKzgENQ:12101234567", 85.0, 1_794_355_030_000);
    insert(&a, second, "bilibili:BV1qFuQz2EVx:12101234568", 22.0, 1_794_355_040_000);
    let snapshot = a.snapshot(&cfg);
    assert_eq!(snapshot.records.len(), 3);
    assert!(!snapshot.records.contains_key(&format!("collection:{first}")));
    let mut legacy_view = snapshot.clone();
    legacy_view.omit_followed_season_progress();
    legacy_view.validate(&cfg.uid).unwrap();
    assert_eq!(legacy_view.records.len(), 1);
    let new_bytes = serde_json::to_vec(&snapshot).unwrap().len() - serde_json::to_vec(&legacy_view).unwrap().len();
    assert!(new_bytes < 400, "two checkpoint records add {new_bytes} bytes");
    eprintln!("two season checkpoints add {new_bytes} JSON bytes");
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    // A device without history sync still downloads the follow, without
    // importing or erasing the collection's playback checkpoints.
    let mut without_history = cfg.clone();
    without_history.history = false;
    let c = Profile::new(&without_history);
    assert!(sync(&c, &without_history, &secret).await.conflicts.is_empty());
    assert_eq!(c.snapshot(&without_history), legacy_view);
    assert!(progress(&c.0.0.lock().unwrap(), first).unwrap().is_none());

    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    assert_eq!(b.snapshot(&cfg), snapshot);
    assert_eq!(
        progress(&b.0.0.lock().unwrap(), "up:42").unwrap().unwrap().collection_ref.as_deref(),
        Some(second)
    );
    // Write from a favorited entry, then remove that exact favorite. The
    // unchanged creator membership retains the one canonical checkpoint.
    b.sql(&format!("INSERT INTO collections(bvid) VALUES('{first}')"));
    insert(&b, first, "bilibili:BV1tZuKzgENQ:12101234567", 97.25, 1_794_355_050_000);
    change(&mut b.0.0.lock().unwrap(), "remove", first, "", None).unwrap();
    let old_objects: BTreeSet<_> = store.lock().unwrap().files.keys().cloned().collect();
    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    let uploaded: usize = store.lock().unwrap().files.iter()
        .filter(|(path, _)| path.contains("/objects/") && !old_objects.contains(*path))
        .map(|(_, (data, _))| data.len()).sum();
    assert!((1..=2048).contains(&uploaded), "checkpoint update uploaded {uploaded} object bytes");
    eprintln!("single season update added {uploaded} WebDAV object bytes");
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    let point = progress(&a.0.0.lock().unwrap(), "up:42").unwrap().unwrap();
    assert_eq!((point.collection_ref.as_deref(), point.position_ms), (Some(first), 97_250));

    b.sql(&format!("INSERT INTO collections(bvid) VALUES('{second}')"));
    change(&mut b.0.0.lock().unwrap(), "remove", "up:42", "", None).unwrap();
    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    let received = a.snapshot(&cfg);
    assert_eq!(received, b.snapshot(&cfg));
    assert!(!received.records.contains_key(&first_key));
    assert!(received.records.contains_key(&second_key));
    server.abort();
}

/// This oracle stores an event DAG, not CRDT registers/contexts. A candidate survives
/// exactly when no later assignment to that field explicitly observed that event.
#[test]
fn event_dag_oracle_checks_random_sparse_observations_reordering_and_duplicates() {
    #[derive(Clone)]
    struct Event {
        key: String,
        actor: String,
        seq: u64,
        cell: Cell,
        parents: BTreeSet<usize>,
    }
    for seed in seeds(256) {
        let mut rng = Random(seed);
        let scope = Scope {
            uid: "42".into(),
            vault: LIST.into(),
            seed: "a".repeat(64),
            domain: Domain::Library,
        };
        let mut replicas = vec![Document::empty(scope); 5];
        let mut known = vec![BTreeSet::<usize>::new(); 5];
        let mut observed = replicas.clone();
        let mut observed_events = known.clone();
        let actors: Vec<_> = (1..=5)
            .map(|n| format!("10000000-0000-4000-8000-{n:012}"))
            .collect();
        let mut events = Vec::<Event>::new();
        for step in 0..180 {
            let a = rng.index(5);
            let b = rng.index(5);
            match rng.index(4) {
                0 => {
                    let packet = replicas[b].clone();
                    replicas[a].join(&packet).unwrap();
                    let packet = known[b].clone();
                    known[a].extend(packet);
                    // Repeat the same packet, including stale checkpoints.
                    let packet = replicas[b].clone();
                    replicas[a].join(&packet).unwrap();
                }
                1 => {
                    observed[a] = replicas[a].clone();
                    observed_events[a] = known[a].clone();
                }
                _ => {
                    let field = ["name", "description", "coverUrl", "__present"][rng.index(4)];
                    let key = causal::key("playlist:oracle", field);
                    let cell = if field == "__present" {
                        Cell::Value(json!(rng.index(2) == 0))
                    } else {
                        match rng.index(4) {
                            0 => Cell::Missing,
                            1 => Cell::Value(json!(null)),
                            n => Cell::Value(json!(format!("{n}:{}", rng.index(4)))),
                        }
                    };
                    let batch = replicas[a]
                        .make_observed_batch(
                            &actors[a],
                            BTreeMap::from([(key.clone(), cell.clone())]),
                            &observed[a].registers,
                        )
                        .unwrap()
                        .expect("non-empty displayed-view edit must retain its own event identity");
                    {
                        let id = events.len();
                        events.push(Event {
                            key,
                            actor: actors[a].clone(),
                            seq: batch.seq,
                            cell,
                            parents: observed_events[a].clone(),
                        });
                        replicas[a].apply(&batch).unwrap();
                        known[a].insert(id);
                        // Displayed local edits advance the observed register only; receipt
                        // alone does not imply the user saw every hidden conflict candidate.
                        for (k, r) in &batch.registers {
                            observed[a].registers.insert(k.clone(), r.clone());
                        }
                        observed_events[a].insert(id);
                    }
                }
            }
            assert!(replicas[a].valid(), "seed={seed}, step={step}");
        }
        let mut expected = replicas[0].clone();
        for replica in &replicas {
            expected.join(replica).unwrap();
        }
        for a in 0..5 {
            for _ in 0..3 {
                for j in 0..5 {
                    let b = (j + a) % 5;
                    let packet = replicas[b].clone();
                    replicas[a].join(&packet).unwrap();
                }
            }
            assert_eq!(replicas[a], expected, "seed={seed}, replica={a}");
        }
        let mut oracle = BTreeMap::<String, Vec<(String, u64, Cell)>>::new();
        for (id, event) in events.iter().enumerate() {
            if !events
                .iter()
                .any(|other| other.key == event.key && other.parents.contains(&id))
            {
                oracle.entry(event.key.clone()).or_default().push((
                    event.actor.clone(),
                    event.seq,
                    event.cell.clone(),
                ));
            }
        }
        for (key, register) in &expected.registers {
            let mut want = oracle.remove(key).unwrap_or_default();
            want.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
            let actual: Vec<_> = register
                .values
                .iter()
                .map(|v| (v.dot.actor.clone(), v.dot.seq, v.cell.clone()))
                .collect();
            assert_eq!(actual, want, "independent oracle seed={seed}, field={key}");
        }
        assert!(oracle.is_empty());
    }
}

#[tokio::test]
async fn every_bootstrap_request_boundary_recovers_before_and_after_server_commit() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let initial = Profile::new(&cfg);
    initial.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','retained')"
    ));
    assert!(sync(&initial, &cfg, &secret).await.conflicts.is_empty());
    let requests = store.lock().unwrap().requests.clone();
    server.abort();
    for (i, (method, _)) in requests.iter().enumerate() {
        for after in [false, true] {
            if after && !["PUT", "MKCOL", "DELETE"].contains(&method.as_str()) {
                continue;
            }
            let (cfg, secret, store, server) = test_dav::server().await;
            let a = Profile::new(&cfg);
            a.sql(&format!(
                "INSERT INTO playlists(id,name) VALUES('{LIST}','retained')"
            ));
            store.lock().unwrap().fault = Some(Fault {
                ordinal: Some(i + 1),
                method: None,
                contains: String::new(),
                failure: if after {
                    Failure::After(503)
                } else {
                    Failure::Before(503)
                },
            });
            let first = engine::sync(&a.0, &cfg, &secret, None, false).await;
            assert!(
                store.lock().unwrap().fault.is_none(),
                "unvisited request {i} {method}"
            );
            assert!(
                first.as_ref().map_or(true, super::Outcome::has_extension_error),
                "failure was silently accepted at {i} {method}"
            );
            for _ in 0..2 {
                assert!(
                    sync(&a, &cfg, &secret).await.conflicts.is_empty(),
                    "boundary={i},after={after}"
                );
            }
            let b = Profile::new(&cfg);
            assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
            assert_eq!(
                a.snapshot(&cfg),
                b.snapshot(&cfg),
                "boundary={i},after={after}"
            );
            assert_eq!(
                a.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["name"],
                json!("retained")
            );
            store.lock().unwrap().requests.clear();
            sync(&a, &cfg, &secret).await;
            sync(&b, &cfg, &secret).await;
            assert!(
                store
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .all(|(m, _)| m != "PUT"),
                "receive echo at {i}"
            );
            server.abort();
        }
    }
    eprintln!(
        "bootstrap fault matrix: {} request boundaries",
        requests.len()
    );
}

fn choose(
    p: &Profile,
    cfg: &Config,
    secret: &Secret,
    want: impl Fn(&str, &Cell) -> bool,
) -> String {
    let target = storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username).unwrap();
    let menu: engine::ConflictMenu = engine::get(&p.0.0.lock().unwrap(), &target, "conflict-menu")
        .unwrap()
        .unwrap();
    let choices: BTreeMap<_, _> = menu
        .options
        .iter()
        .map(|(key, values)| {
            let cell = values
                .iter()
                .find(|o| want(key, &o.cell))
                .unwrap_or_else(|| panic!("candidate missing: {key}"));
            (key.clone(), cell.cell.clone())
        })
        .collect();
    json!({"token":menu.token,"choices":choices}).to_string()
}
#[tokio::test]
async fn delete_author_can_choose_to_restore_a_remote_concurrent_edit() {
    let (cfg, secret, _, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    a.sql("DELETE FROM playlists");
    b.sql("UPDATE playlists SET name='offline edit'");
    sync(&a, &cfg, &secret).await;
    assert!(!sync(&b, &cfg, &secret).await.conflicts.is_empty());
    // The deleting device has no visible SQL record. It must still offer recovery
    // of the other device's concurrent edit, not only another copy of 'delete'.
    assert!(!sync(&a, &cfg, &secret).await.conflicts.is_empty());
    let decision = choose(&a, &cfg, &secret, |_, cell| {
        *cell == Cell::Value(json!(true))
    });
    assert!(
        engine::sync(&a.0, &cfg, &secret, Some(&decision), false)
            .await
            .unwrap()
            .conflicts
            .is_empty()
    );
    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    assert_eq!(
        a.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["name"],
        json!("offline edit")
    );
    server.abort();
}
#[tokio::test]
async fn local_edits_during_upload_survive_exact_prefix_acknowledgement() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    a.sql("UPDATE playlists SET name='queued before upload'");
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    store.lock().unwrap().gate = Some(test_dav::Gate {
        method: "PUT".into(),
        contains: "/control/".into(),
        entered: entered.clone(),
        release: release.clone(),
    });
    let editing = async {
        entered.notified().await;
        a.sql("UPDATE playlists SET description='edited during upload'");
        release.notify_one();
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        let (outcome, _) = tokio::join!(engine::sync(&a.0, &cfg, &secret, None, false), editing);
        assert!(outcome.unwrap().conflicts.is_empty());
    })
    .await
    .expect("upload held SQLite lock");
    sync(&b, &cfg, &secret).await;
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    assert_eq!(
        b.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["description"],
        json!("edited during upload")
    );
    server.abort();
}
#[tokio::test]
async fn late_old_put_stale_directory_and_partial_visibility_never_roll_back_data() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    a.sql("UPDATE playlists SET name='first generation'");
    store.lock().unwrap().fault = Some(Fault {
        ordinal: None,
        method: Some("PUT".into()),
        contains: "/control/".into(),
        failure: Failure::DelayPut,
    });
    assert!(
        engine::sync(&a.0, &cfg, &secret, None, false)
            .await
            .is_err()
    );
    sync(&a, &cfg, &secret).await;
    a.sql("UPDATE playlists SET name='latest generation'");
    sync(&a, &cfg, &secret).await;
    store.lock().unwrap().flush_delayed();
    sync(&b, &cfg, &secret).await;
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    let before = b.snapshot(&cfg);
    let latest = store
        .lock()
        .unwrap()
        .files
        .keys()
        .filter(|p| p.contains("/control/"))
        .max()
        .unwrap()
        .clone();
    store.lock().unwrap().hidden.insert(latest);
    assert!(
        engine::sync(&b.0, &cfg, &secret, None, false)
            .await
            .is_err()
    );
    assert_eq!(b.snapshot(&cfg), before);
    store.lock().unwrap().hidden.clear();
    let cold = Profile::new(&cfg);
    cold.sql("INSERT INTO playlists(id,name) VALUES('00000000-0000-4000-8000-000000000002','local safe')");
    let objects: Vec<_> = store
        .lock()
        .unwrap()
        .files
        .keys()
        .filter(|p| p.contains("/objects/"))
        .cloned()
        .collect();
    store.lock().unwrap().hidden.extend(objects);
    let local = cold.snapshot(&cfg);
    assert!(
        engine::sync(&cold.0, &cfg, &secret, None, false)
            .await
            .is_err()
    );
    assert_eq!(cold.snapshot(&cfg), local);
    store.lock().unwrap().hidden.clear();
    store.lock().unwrap().fault = Some(Fault {
        ordinal: None,
        method: Some("GET".into()),
        contains: "/objects/".into(),
        failure: Failure::CorruptGet,
    });
    assert!(
        engine::sync(&cold.0, &cfg, &secret, None, false)
            .await
            .is_err()
    );
    assert_eq!(cold.snapshot(&cfg), local);
    assert!(sync(&cold, &cfg, &secret).await.conflicts.is_empty());
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    assert_eq!(a.snapshot(&cfg), cold.snapshot(&cfg));
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    server.abort();
}

fn sample(p: &Profile, cfg: &Config, milliseconds: u64) {
    super::statistics::record(
        &p.0.0.lock().unwrap(),
        &p.0.1,
        &cfg.uid,
        "bilibili:BV1:1",
        milliseconds as f64 / 1000.0,
        None,
        None,
    )
    .unwrap();
}
fn total_ms(p: &Profile, cfg: &Config) -> u64 {
    let data = super::statistics::query(&p.0.0.lock().unwrap(), &p.0.1, &cfg.uid).unwrap();
    (data["total"]["seconds"].as_f64().unwrap() * 1000.0).round() as u64
}
async fn stats(p: &Profile, cfg: &Config, secret: &Secret) {
    tokio::time::timeout(
        Duration::from_secs(5),
        super::statistics_v2::exchange(&p.0, cfg, secret),
    )
    .await
    .expect("statistics stalled")
    .unwrap();
}
#[tokio::test]
async fn every_statistics_bootstrap_boundary_is_idempotent_and_keeps_inflight_samples() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let initial = Profile::new(&cfg);
    sample(&initial, &cfg, 60_125);
    stats(&initial, &cfg, &secret).await;
    let requests = store.lock().unwrap().requests.clone();
    server.abort();
    for (i, (method, _)) in requests.iter().enumerate() {
        for after in [false, true] {
            if after && !["PUT", "MKCOL"].contains(&method.as_str()) {
                continue;
            }
            let (cfg, secret, store, server) = test_dav::server().await;
            let a = Profile::new(&cfg);
            sample(&a, &cfg, 60_125);
            store.lock().unwrap().fault = Some(Fault {
                ordinal: Some(i + 1),
                method: None,
                contains: String::new(),
                failure: if after {
                    Failure::After(503)
                } else {
                    Failure::Before(503)
                },
            });
            assert!(
                super::statistics_v2::exchange(&a.0, &cfg, &secret)
                    .await
                    .is_err(),
                "statistics boundary={i},after={after}"
            );
            assert!(store.lock().unwrap().fault.is_none());
            sample(&a, &cfg, 15_375);
            stats(&a, &cfg, &secret).await;
            stats(&a, &cfg, &secret).await;
            let b = Profile::new(&cfg);
            stats(&b, &cfg, &secret).await;
            assert_eq!(total_ms(&a, &cfg), 75_500, "boundary={i},after={after}");
            assert_eq!(total_ms(&b, &cfg), 75_500);
            store.lock().unwrap().requests.clear();
            stats(&a, &cfg, &secret).await;
            stats(&b, &cfg, &secret).await;
            assert!(
                store
                    .lock()
                    .unwrap()
                    .requests
                    .iter()
                    .all(|(m, _)| m != "PUT")
            );
            server.abort();
        }
    }
    eprintln!(
        "statistics fault matrix: {} request boundaries",
        requests.len()
    );
}
fn restart(p: &Profile) {
    let mut c = p.0.0.lock().unwrap();
    let path = c.path().unwrap().to_owned();
    let old = std::mem::replace(&mut *c, Connection::open_in_memory().unwrap());
    old.close().unwrap();
    *c = Connection::open(path).unwrap();
    crate::infrastructure::migrations::migrate(&c).unwrap();
}
#[tokio::test]
async fn five_device_statistics_random_schedule_matches_independent_sample_sum() {
    for seed in seeds(16) {
        let (cfg, secret, store, server) = test_dav::server().await;
        let devices: Vec<_> = (0..5).map(|_| Profile::new(&cfg)).collect();
        let mut rng = Random(seed);
        let mut expected = 0u64;
        for step in 0..90 {
            let a = rng.index(5);
            let amount = 1 + rng.next() % 30_000;
            sample(&devices[a], &cfg, amount);
            expected += amount;
            if step % 7 == 0 {
                restart(&devices[a]);
            }
            if rng.index(3) == 0 {
                let failing = rng.index(4) == 0;
                if failing {
                    store.lock().unwrap().fault = Some(Fault {
                        ordinal: None,
                        method: Some("PUT".into()),
                        contains: "/control/".into(),
                        failure: Failure::After(503),
                    });
                }
                let result = super::statistics_v2::exchange(&devices[a].0, &cfg, &secret).await;
                if !failing {
                    result.unwrap_or_else(|error| {
                        panic!("statistics seed={seed},step={step}: {error}")
                    });
                }
                store.lock().unwrap().fault = None;
            }
        }
        // Stop edits, restore a fair network, then visit every replica in different orders.
        for pass in 0..3 {
            for i in 0..5 {
                let a = (i + pass + seed as usize) % 5;
                stats(&devices[a], &cfg, &secret).await;
            }
        }
        for (i, device) in devices.iter().enumerate() {
            assert_eq!(
                total_ms(device, &cfg),
                expected,
                "statistics oracle seed={seed}, replica={i}"
            );
        }
        store.lock().unwrap().requests.clear();
        for device in &devices {
            stats(device, &cfg, &secret).await;
        }
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(m, _)| m != "PUT"),
            "statistics receive echo seed={seed}"
        );
        server.abort();
    }
}
#[tokio::test]
async fn concurrent_statistics_initialization_uses_distinct_contributions_in_one_vault() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    sample(&a, &cfg, 50_100);
    sample(&b, &cfg, 70_900);
    for device in [&a, &b] {
        store.lock().unwrap().fault = Some(Fault {
            ordinal: None,
            method: Some("PUT".into()),
            contains: "/objects/".into(),
            failure: Failure::Before(503),
        });
        assert!(
            super::statistics_v2::exchange(&device.0, &cfg, &secret)
                .await
                .is_err()
        );
    }
    let (ra, rb) = tokio::join!(
        super::statistics_v2::exchange(&a.0, &cfg, &secret),
        super::statistics_v2::exchange(&b.0, &cfg, &secret)
    );
    ra.unwrap();
    rb.unwrap();
    stats(&a, &cfg, &secret).await;
    stats(&b, &cfg, &secret).await;
    assert_eq!(total_ms(&a, &cfg), 121_000);
    assert_eq!(total_ms(&b, &cfg), 121_000);
    server.abort();
}

fn library_doc(p: &Profile, cfg: &Config, secret: &Secret) -> Document {
    let target = storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username).unwrap();
    super::outbox::overlay(&p.0.0.lock().unwrap(), &target, Domain::Library).unwrap()
}
async fn settle_library(devices: &[Profile], cfg: &Config, secret: &Secret, seed: u64) {
    for pass in 0..12 {
        for i in 0..devices.len() {
            let p = &devices[(i + pass + seed as usize) % devices.len()];
            let result = sync(p, cfg, secret).await;
            if !result.conflicts.is_empty() {
                let target =
                    storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username)
                        .unwrap();
                let menu: engine::ConflictMenu =
                    engine::get(&p.0.0.lock().unwrap(), &target, "conflict-menu")
                        .unwrap()
                        .unwrap();
                let choices: BTreeMap<_, _> = menu
                    .options
                    .iter()
                    .map(|(k, v)| {
                        let cell = v
                            .iter()
                            .max_by_key(|o| serde_json::to_string(&o.cell).unwrap())
                            .unwrap()
                            .cell
                            .clone();
                        (k.clone(), cell)
                    })
                    .collect();
                let resolution = json!({"token":menu.token,"choices":choices}).to_string();
                let _ = engine::sync(&p.0, cfg, secret, Some(&resolution), false)
                    .await
                    .unwrap();
            }
        }
        let expected = library_doc(&devices[0], cfg, secret);
        if devices
            .iter()
            .all(|p| library_doc(p, cfg, secret) == expected)
        {
            let (_, conflicts) = expected.materialize().unwrap();
            if conflicts.iter().all(|key| {
                let (_, field): (String, String) = serde_json::from_str(key).unwrap();
                field == "__order" || super::upgrade_merge::automatic_field(&field)
            }) {
                return;
            }
        }
    }
    panic!("library did not converge after fair delivery, seed={seed}");
}
#[tokio::test]
async fn production_library_random_offline_edits_restarts_deletes_and_readds_converge() {
    for seed in seeds(24) {
        let (cfg, secret, store, server) = test_dav::server().await;
        let devices: Vec<_> = (0..4).map(|_| Profile::new(&cfg)).collect();
        let mut rng = Random(seed);
        let mut independent = BTreeSet::new();
        devices[0].sql(&format!(
            "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
        ));
        for p in &devices {
            sync(p, &cfg, &secret).await;
        }
        for step in 0..64 {
            let a = rng.index(4);
            let p = &devices[a];
            match rng.index(6) {
                0 => {
                    let id = format!("20000000-0000-4000-8000-{:012}", step + 1);
                    independent.insert(format!("playlist:{id}"));
                    p.sql(&format!(
                        "INSERT INTO playlists(id,name) VALUES('{id}','unique {step}')"
                    ));
                }
                1 => p.sql(&format!(
                    "UPDATE playlists SET name='name {step}' WHERE id='{LIST}'"
                )),
                2 => p.sql(&format!(
                    "UPDATE playlists SET description='description {step}' WHERE id='{LIST}'"
                )),
                3 => p.sql(&format!("DELETE FROM playlists WHERE id='{LIST}'")),
                4 => p.sql(&format!(
                    "INSERT OR IGNORE INTO playlists(id,name) VALUES('{LIST}','readded {step}')"
                )),
                _ => restart(p),
            }
            if rng.index(2) == 0 {
                let fault = rng.index(5) == 0;
                if fault {
                    store.lock().unwrap().fault = Some(Fault {
                        ordinal: None,
                        method: Some("PUT".into()),
                        contains: "/control/".into(),
                        failure: Failure::After(503),
                    });
                }
                let result = engine::sync(&p.0, &cfg, &secret, None, false).await;
                if !fault {
                    result.unwrap_or_else(|e| panic!("seed={seed},step={step}: {e}"));
                }
                store.lock().unwrap().fault = None;
            }
        }
        settle_library(&devices, &cfg, &secret, seed).await;
        let expected = devices[0].snapshot(&cfg);
        for p in &devices {
            let actual = p.snapshot(&cfg);
            assert_eq!(actual, expected, "seed={seed}");
            assert!(
                independent.iter().all(|id| actual.records.contains_key(id)),
                "independent addition lost seed={seed}"
            );
        }
        store.lock().unwrap().requests.clear();
        for p in &devices {
            assert!(sync(p, &cfg, &secret).await.conflicts.is_empty());
        }
        assert!(
            store
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(m, _)| m != "PUT"),
            "library receive echo seed={seed}"
        );
        server.abort();
    }
}

#[tokio::test]
async fn sql_transaction_failures_burn_identity_without_losing_local_intentions() {
    let cases = [
        "BEFORE INSERT ON sync_v2_outbox",
        "BEFORE UPDATE OF allocated ON sync_v2_documents WHEN new.allocated>old.allocated",
        "BEFORE UPDATE OF generation ON sync_v2_publications WHEN new.generation>old.generation",
        "BEFORE UPDATE ON sync_v2_state WHEN new.key='runtime' AND new.json<>old.json",
        "BEFORE DELETE ON sync_v2_outbox",
        "BEFORE UPDATE ON playlists",
    ];
    for case in cases {
        let (cfg, secret, _, server) = test_dav::server().await;
        let a = Profile::new(&cfg);
        let b = Profile::new(&cfg);
        a.sql(&format!(
            "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
        ));
        sync(&a, &cfg, &secret).await;
        sync(&b, &cfg, &secret).await;
        b.sql("UPDATE playlists SET description='remote field'");
        sync(&b, &cfg, &secret).await;
        a.sql("UPDATE playlists SET name='local field'");
        a.sql(&format!("CREATE TRIGGER simulated_sql_failure {case} BEGIN SELECT RAISE(ABORT,'simulated transaction failure'); END"));
        let failed = engine::sync(&a.0, &cfg, &secret, None, false).await;
        assert!(failed.is_err(), "SQL fault was not reached: {case}");
        assert_eq!(
            a.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["name"],
            json!("local field"),
            "local edit rolled back: {case}"
        );
        a.sql("DROP TRIGGER simulated_sql_failure");
        assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty(), "{case}");
        assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty(), "{case}");
        assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg), "{case}");
        assert_eq!(
            a.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["description"],
            json!("remote field")
        );
        server.abort();
    }
}

#[tokio::test]
async fn cold_reader_interleaves_alternating_writer_prefixes_and_waits_for_missing_dependencies() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    b.sql("UPDATE playlists SET description='B1'");
    sync(&b, &cfg, &secret).await;
    sync(&a, &cfg, &secret).await;
    a.sql("UPDATE playlists SET name='A2'");
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    b.sql("UPDATE playlists SET description='B2'");
    sync(&b, &cfg, &secret).await;
    sync(&a, &cfg, &secret).await;
    a.sql("UPDATE playlists SET name='A3'");
    sync(&a, &cfg, &secret).await;
    let target = storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username).unwrap();
    let actor: String =
        b.0.0
            .lock()
            .unwrap()
            .query_row(
                "SELECT actor FROM sync_v2_documents WHERE target=?1 AND domain='library'",
                [target],
                |r| r.get(0),
            )
            .unwrap();
    let vault = super::migration::Genesis::for_config(&cfg).unwrap().vault;
    let hidden = format!("/dav/BiliMusic-sync-v1/42/sync-v2/{vault}/control/{actor}/");
    store.lock().unwrap().hidden.insert(hidden);
    let cold = Profile::new(&cfg);
    cold.sql("INSERT INTO playlists(id,name) VALUES('00000000-0000-4000-8000-000000000002','local retained')");
    let before = cold.snapshot(&cfg);
    assert!(
        engine::sync(&cold.0, &cfg, &secret, None, false)
            .await
            .is_err()
    );
    assert_eq!(cold.snapshot(&cfg), before);
    store.lock().unwrap().hidden.clear();
    assert!(sync(&cold, &cfg, &secret).await.conflicts.is_empty());
    let snapshot = cold.snapshot(&cfg);
    let fields = &snapshot.records[&format!("playlist:{LIST}")].fields;
    assert_eq!(fields["name"], json!("A3"));
    assert_eq!(fields["description"], json!("B2"));
    assert!(
        snapshot
            .records
            .contains_key("playlist:00000000-0000-4000-8000-000000000002")
    );
    server.abort();
}

#[tokio::test]
async fn checkpoint_compaction_and_marker_cleanup_preserve_long_offline_edits() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    let c = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    for p in [&a, &b, &c] {
        sync(p, &cfg, &secret).await;
    }
    b.sql("UPDATE playlists SET description='long offline independent edit'");
    c.sql("UPDATE playlists SET name='long offline conflicting edit'");
    for i in 0..90 {
        a.sql(&format!("UPDATE playlists SET name='online {i:03}'"));
        sync(&a, &cfg, &secret).await;
    }
    let checkpoints = store
        .lock()
        .unwrap()
        .files
        .iter()
        .filter(|(p, _)| p.contains("/manifests/") && p.contains("/library/"))
        .map(|(_, (body, _))| serde_json::from_slice::<super::protocol_v2::Manifest>(body).unwrap())
        .collect::<Vec<_>>();
    assert!(
        checkpoints.iter().any(|m| m.checkpoint.last_seq > 1),
        "test did not cross a checkpoint boundary"
    );
    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    assert!(sync(&c, &cfg, &secret).await.conflicts.is_empty());
    for p in [&a, &b, &c] {
        assert!(sync(p, &cfg, &secret).await.conflicts.is_empty());
    }
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    assert_eq!(a.snapshot(&cfg), c.snapshot(&cfg));
    let snapshot = a.snapshot(&cfg);
    let fields = &snapshot.records[&format!("playlist:{LIST}")].fields;
    assert!(
        [json!("long offline conflicting edit"), json!("online 089")].contains(&fields["name"])
    );
    assert_eq!(
        fields["description"],
        json!("long offline independent edit")
    );
    server.abort();
}
#[tokio::test]
async fn five_thousand_tracks_bootstrap_and_cold_restore_with_one_sparse_change() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    {
        let c = a.0.0.lock().unwrap();
        let tx = c.unchecked_transaction().unwrap();
        c.execute(
            "INSERT INTO playlists(id,name) VALUES(?1,'large library')",
            [LIST],
        )
        .unwrap();
        for i in 1..=5000 {
            let bvid = format!("BV{i:010}");
            let id = format!("bilibili:{bvid}:{i}");
            c.execute(
                "INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili',?2,?3)",
                rusqlite::params![id, bvid, i],
            )
            .unwrap();
            c.execute(
                "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'synthetic music')",
                [&id],
            )
            .unwrap();
            c.execute(
                "INSERT INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,?3)",
                rusqlite::params![LIST, id, i - 1],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    let expected = a.snapshot(&cfg);
    assert_eq!(expected.records.len(), 10_001);
    for p in [&a, &b] {
        let result = tokio::time::timeout(
            Duration::from_secs(90),
            engine::sync(&p.0, &cfg, &secret, None, false),
        )
        .await
        .expect("large restore stalled")
        .unwrap();
        assert!(result.conflicts.is_empty());
    }
    assert_eq!(b.snapshot(&cfg), expected);
    let old_objects: BTreeSet<_> = store.lock().unwrap().files.keys().cloned().collect();
    a.sql("UPDATE playlists SET description='one small field change'");
    let result = engine::sync(&a.0, &cfg, &secret, None, false)
        .await
        .unwrap();
    assert!(result.conflicts.is_empty());
    let new_payload_bytes: usize = store
        .lock()
        .unwrap()
        .files
        .iter()
        .filter(|(p, _)| p.contains("/objects/") && !old_objects.contains(*p))
        .map(|(_, (body, _))| body.len())
        .sum();
    assert!(
        new_payload_bytes < 8192,
        "small edit uploaded a full library: {new_payload_bytes} bytes"
    );
    engine::sync(&b.0, &cfg, &secret, None, false)
        .await
        .unwrap();
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    eprintln!("5000-track sparse-change compressed payload: {new_payload_bytes} bytes");
    server.abort();
}

#[tokio::test]
async fn edits_after_network_validation_cannot_be_overwritten_by_projection_commit() {
    let (cfg, secret, _, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    b.sql("UPDATE playlists SET name='remote name'");
    sync(&b, &cfg, &secret).await;
    let hook: Box<dyn Fn(&Database)> = Box::new(|db| {
        db.0.lock()
            .unwrap()
            .execute(
                "UPDATE playlists SET description='edit at commit boundary'",
                [],
            )
            .unwrap();
    });
    let result = engine::BEFORE_PROJECT
        .scope(hook, engine::sync(&a.0, &cfg, &secret, None, false))
        .await;
    assert!(
        result
            .err()
            .expect("concurrent edit should defer projection")
            .contains("本机资料已变化")
    );
    assert_eq!(
        a.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["description"],
        json!("edit at commit boundary")
    );
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    assert_eq!(
        a.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["name"],
        json!("remote name")
    );
    server.abort();
}
#[tokio::test]
async fn v2_statistics_samples_while_uploading_remain_pending_until_the_next_publication() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    sample(&a, &cfg, 60_000);
    stats(&a, &cfg, &secret).await;
    stats(&b, &cfg, &secret).await;
    sample(&a, &cfg, 10_000);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    store.lock().unwrap().gate = Some(test_dav::Gate {
        method: "PUT".into(),
        contains: "/control/".into(),
        entered: entered.clone(),
        release: release.clone(),
    });
    let recording = async {
        entered.notified().await;
        sample(&a, &cfg, 5_000);
        release.notify_one();
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        let (result, _) = tokio::join!(
            super::statistics_v2::exchange(&a.0, &cfg, &secret),
            recording
        );
        result.unwrap();
    })
    .await
    .unwrap();
    assert_eq!(total_ms(&a, &cfg), 75_000);
    let target = storage::target_key(&cfg.provider, &cfg.uid, &cfg.url, &secret.username).unwrap();
    assert!(
        !super::outbox::pending(&a.0.0.lock().unwrap(), &target, Domain::Statistics)
            .unwrap()
            .is_empty()
    );
    stats(&b, &cfg, &secret).await;
    assert_eq!(total_ms(&b, &cfg), 70_000);
    stats(&a, &cfg, &secret).await;
    stats(&b, &cfg, &secret).await;
    assert_eq!(total_ms(&b, &cfg), 75_000);
    assert!(
        super::outbox::pending(&a.0.0.lock().unwrap(), &target, Domain::Statistics)
            .unwrap()
            .is_empty()
    );
    server.abort();
}

#[tokio::test]
async fn forged_head_watermarks_and_same_generation_forks_never_advance_the_view() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    a.sql("UPDATE playlists SET name='latest'");
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    let before = b.snapshot(&cfg);
    let path = store
        .lock()
        .unwrap()
        .files
        .keys()
        .filter(|p| p.contains("/control/"))
        .max()
        .unwrap()
        .clone();
    let head: super::protocol_v2::Head =
        serde_json::from_slice(&store.lock().unwrap().files[&path].0).unwrap();
    let root = format!("{}/", path.rsplit_once('/').unwrap().0);
    for kind in 0..3 {
        let mut forged = head.clone();
        if kind < 2 {
            forged.generation += 1;
        }
        let domain = forged.domains.get_mut(&Domain::Library).unwrap();
        if kind == 0 {
            domain.self_seq -= 1;
        } else {
            domain.self_seq += 10;
        }
        let name = format!("{root}{}", forged.filename().unwrap());
        store.lock().unwrap().files.insert(
            name.clone(),
            (serde_json::to_vec(&forged).unwrap(), 1_700_000_000),
        );
        assert!(
            engine::sync(&b.0, &cfg, &secret, None, false)
                .await
                .is_err(),
            "invalid head accepted, kind={kind}"
        );
        assert_eq!(b.snapshot(&cfg), before);
        store.lock().unwrap().files.remove(&name);
        assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    }
    server.abort();
}
#[tokio::test]
async fn statistics_projection_sql_failure_does_not_partially_add_remote_totals() {
    let (cfg, secret, _, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    sample(&a, &cfg, 40_000);
    sample(&b, &cfg, 50_000);
    stats(&a, &cfg, &secret).await;
    stats(&b, &cfg, &secret).await;
    let own = super::statistics::meta(&a.0.0.lock().unwrap(), "source")
        .unwrap()
        .unwrap();
    a.sql(&format!("CREATE TRIGGER simulated_statistics_failure BEFORE INSERT ON listening_buckets WHEN new.source<>'{own}' BEGIN SELECT RAISE(ABORT,'simulated statistics projection failure'); END"));
    assert!(
        super::statistics_v2::exchange(&a.0, &cfg, &secret)
            .await
            .is_err()
    );
    assert_eq!(total_ms(&a, &cfg), 40_000);
    a.sql("DROP TRIGGER simulated_statistics_failure");
    sample(&a, &cfg, 5_000);
    stats(&a, &cfg, &secret).await;
    stats(&b, &cfg, &secret).await;
    assert_eq!(total_ms(&a, &cfg), 95_000);
    assert_eq!(total_ms(&b, &cfg), 95_000);
    server.abort();
}
#[test]
fn compressed_payload_inflate_limit_is_enforced_before_decoding() {
    use std::io::Write;
    let mut zip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let chunk = [b' '; 8192];
    for _ in 0..(super::protocol_v2::MAX_INFLATED / 8192 + 1) {
        zip.write_all(&chunk).unwrap();
    }
    let body = zip.finish().unwrap();
    let reference = super::protocol_v2::ObjectRef {
        hash: causal::hash(&body),
        bytes: body.len() as u64,
        first_seq: 0,
        last_seq: 0,
    };
    assert!(
        super::protocol_v2::decode::<serde_json::Value>(&body, &reference)
            .unwrap_err()
            .contains("解压大小超限")
    );
}

#[tokio::test]
async fn editing_to_an_unseen_cloud_value_still_records_the_local_causal_intention() {
    let (cfg, secret, _, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    let c = Profile::new(&cfg);
    a.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','initial')"
    ));
    for p in [&a, &b, &c] {
        sync(p, &cfg, &secret).await;
    }
    b.sql("UPDATE playlists SET name='same value' ");
    sync(&b, &cfg, &secret).await;
    // Preview receives B's version without applying it to A's visible business view.
    assert!(
        engine::sync(&a.0, &cfg, &secret, None, true)
            .await
            .unwrap()
            .conflicts
            .is_empty()
    );
    assert_eq!(
        a.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["name"],
        json!("initial")
    );
    sync(&c, &cfg, &secret).await;
    c.sql("UPDATE playlists SET name='later cloud value'");
    sync(&c, &cfg, &secret).await;
    // This is a real local edit, despite coinciding with A's hidden received value.
    a.sql("UPDATE playlists SET name='same value'");
    let outcome = sync(&a, &cfg, &secret).await;
    assert!(outcome.conflicts.is_empty());
    let doc = library_doc(&a, &cfg, &secret);
    let register = &doc.registers[&super::causal::key(&format!("playlist:{LIST}"), "name")];
    assert!(
        register
            .values
            .iter()
            .any(|candidate| candidate.cell == Cell::Value(json!("same value"))),
        "local intention must remain in the archive even if automatically losing"
    );
    for p in [&b, &c] {
        assert!(sync(p, &cfg, &secret).await.conflicts.is_empty());
        assert_eq!(p.snapshot(&cfg), a.snapshot(&cfg));
    }
    server.abort();
}

#[tokio::test]
async fn local_recent_200_trimming_is_not_an_account_wide_delete_of_an_offline_replay() {
    let (mut cfg, secret, _, server) = test_dav::server().await;
    cfg.history = true;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    {
        let c = a.0.0.lock().unwrap();
        let tx = c.unchecked_transaction().unwrap();
        for i in 0..201 {
            let id = format!("bilibili:BVhistory:{cid}", cid = i + 1);
            c.execute("INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili','BVhistory',?2)",rusqlite::params![id,i+1]).unwrap();
            c.execute(
                "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'history fixture')",
                [&id],
            )
            .unwrap();
            if i < 200 {
                c.execute(
                    "INSERT INTO play_history(track_id,played_at) VALUES(?1,?2)",
                    rusqlite::params![id, format!("2026-01-01 00:{:02}:{:02}", i / 60, i % 60)],
                )
                .unwrap();
            }
        }
        tx.commit().unwrap();
    }
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    // A's most recent 200 drops song 1; B still has it and plays it again offline.
    a.sql("INSERT INTO play_history(track_id,played_at) VALUES('bilibili:BVhistory:201','2026-01-01 00:10:00')");
    b.sql("INSERT INTO play_history(track_id,played_at) VALUES('bilibili:BVhistory:1','2026-01-01 00:11:00')");
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    let snapshot = a.snapshot(&cfg);
    assert_eq!(
        snapshot.records["history:bilibili:BVhistory:1"].fields["playedAt"],
        json!("2026-01-01 00:11:00")
    );
    assert!(
        snapshot
            .records
            .contains_key("history:bilibili:BVhistory:201")
    );
    assert_eq!(
        snapshot
            .records
            .values()
            .filter(|r| r.kind == "history")
            .count(),
        200
    );
    server.abort();
}

#[tokio::test]
async fn removing_the_last_local_reference_cannot_delete_metadata_needed_by_another_domain() {
    let (mut cfg, secret, _, server) = test_dav::server().await;
    cfg.history = true;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    a.sql("INSERT INTO source_items(id,provider,bvid,cid) VALUES('bilibili:BVreference:1','bilibili','BVreference',1); INSERT INTO tracks(id,source_item_id,title) VALUES('bilibili:BVreference:1','bilibili:BVreference:1','shared metadata'); INSERT INTO favorites(track_id) VALUES('bilibili:BVreference:1')");
    sync(&a, &cfg, &secret).await;
    sync(&b, &cfg, &secret).await;
    a.sql("DELETE FROM favorites");
    b.sql("INSERT INTO play_history(track_id) VALUES('bilibili:BVreference:1')");
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    assert!(sync(&b, &cfg, &secret).await.conflicts.is_empty());
    assert!(sync(&a, &cfg, &secret).await.conflicts.is_empty());
    assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg));
    assert!(
        a.snapshot(&cfg)
            .records
            .contains_key("history:bilibili:BVreference:1")
    );
    assert!(
        a.snapshot(&cfg)
            .records
            .contains_key("track:bilibili:BVreference:1")
    );
    assert!(
        !a.snapshot(&cfg)
            .records
            .contains_key("favorite:bilibili:BVreference:1")
    );
    server.abort();
}

/// Exhaust actual HTTP admission at each bootstrap boundary, then restore the
/// budget. Same durable outbox is replayed; an offline edit made while waiting
/// must survive on both the writer and a cold receiver.
#[tokio::test]
async fn quota_exhaustion_at_every_bootstrap_boundary_resumes_without_losing_offline_edits() {
    use super::request_budget::{self, Budget};
    let (cfg, secret, store, server) = test_dav::server().await;
    let initial = Profile::new(&cfg);
    initial.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','retained')"
    ));
    sync(&initial, &cfg, &secret).await;
    let boundaries = store.lock().unwrap().requests.len();
    server.abort();
    assert!(boundaries < 120);
    for cutoff in 0..boundaries {
        let (cfg, secret, store, server) = test_dav::server().await;
        let a = Profile::new(&cfg);
        a.sql(&format!(
            "INSERT INTO playlists(id,name) VALUES('{LIST}','retained')"
        ));
        let budget = Arc::new(Budget::testing(&a.0.1, cutoff));
        let result = request_budget::scoped(
            budget.clone(),
            engine::sync(&a.0, &cfg, &secret, None, false),
        )
        .await;
        assert!(
            result.as_ref().map_or(true, super::Outcome::has_extension_error),
            "cutoff={cutoff}"
        );
        assert_eq!(store.lock().unwrap().requests.len(), cutoff);
        a.sql(&format!(
            "UPDATE playlists SET name='edited while deferred' WHERE id='{LIST}'"
        ));
        let result = request_budget::scoped(
            budget.clone(),
            engine::sync(&a.0, &cfg, &secret, None, false),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            store.lock().unwrap().requests.len(),
            cutoff,
            "denials must issue no HTTP"
        );
        budget.elapse_window();
        for _ in 0..2 {
            request_budget::scoped(budget.clone(), sync(&a, &cfg, &secret)).await;
        }
        let b = Profile::new(&cfg);
        sync(&b, &cfg, &secret).await;
        assert_eq!(a.snapshot(&cfg), b.snapshot(&cfg), "cutoff={cutoff}");
        assert_eq!(
            b.snapshot(&cfg).records[&format!("playlist:{LIST}")].fields["name"],
            json!("edited while deferred")
        );
        server.abort();
    }
}

#[tokio::test]
async fn library_and_statistics_share_one_actor_discovery_per_background_round() {
    let (cfg, secret, store, server) = test_dav::server().await;
    let a = Profile::new(&cfg);
    let b = Profile::new(&cfg);
    b.sql(&format!(
        "INSERT INTO playlists(id,name) VALUES('{LIST}','a second library writer')"
    ));
    for device in [&a, &b] {
        sync(device, &cfg, &secret).await;
        sample(device, &cfg, 30_000);
        super::statistics_v2::exchange(&device.0, &cfg, &secret)
            .await
            .unwrap();
    }
    // Stabilize all received facts. No source should echo them back as a write.
    for _ in 0..2 {
        sync(&a, &cfg, &secret).await;
        super::statistics_v2::exchange(&a.0, &cfg, &secret)
            .await
            .unwrap();
    }
    store.lock().unwrap().requests.clear();
    super::v2_net::discovery_round(async {
        sync(&a, &cfg, &secret).await;
        super::statistics_v2::exchange(&a.0, &cfg, &secret)
            .await
            .unwrap();
    })
    .await;
    let calls = store.lock().unwrap().requests.clone();
    let mut directories = BTreeSet::new();
    for (method, path) in &calls {
        if method == "PROPFIND" && path.contains("/control/") {
            assert!(
                directories.insert(path.clone()),
                "duplicate discovery {path}"
            );
        }
    }
    assert_eq!(
        directories.len(),
        5,
        "root plus four library/statistics actors"
    );
    assert!(calls.iter().all(|(method, _)| method != "PUT"));
    eprintln!(
        "two-device stable round: {} HTTP requests, {} control listings",
        calls.len(),
        directories.len()
    );
    server.abort();
}

#[tokio::test]
async fn statistics_quota_exhaustion_preserves_samples_and_deduplicates_replay() {
    use super::request_budget::{self, Budget};
    let (cfg, secret, store, server) = test_dav::server().await;
    let initial = Profile::new(&cfg);
    sample(&initial, &cfg, 60_000);
    super::statistics_v2::exchange(&initial.0, &cfg, &secret)
        .await
        .unwrap();
    let boundaries = store.lock().unwrap().requests.len();
    server.abort();
    for cutoff in 0..boundaries {
        let (cfg, secret, store, server) = test_dav::server().await;
        let a = Profile::new(&cfg);
        sample(&a, &cfg, 60_000);
        let budget = Arc::new(Budget::testing(&a.0.1, cutoff));
        let result = request_budget::scoped(
            budget.clone(),
            super::statistics_v2::exchange(&a.0, &cfg, &secret),
        )
        .await;
        assert!(
            result.is_err()
                || a.0
                    .0
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT count(*) FROM visibility_runtime WHERE key='sync_error'",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap()
                    > 0,
            "cutoff={cutoff}"
        );
        assert_eq!(store.lock().unwrap().requests.len(), cutoff);
        sample(&a, &cfg, 15_000);
        budget.elapse_window();
        for _ in 0..2 {
            request_budget::scoped(
                budget.clone(),
                super::statistics_v2::exchange(&a.0, &cfg, &secret),
            )
            .await
            .unwrap();
        }
        let cold = Profile::new(&cfg);
        super::statistics_v2::exchange(&cold.0, &cfg, &secret)
            .await
            .unwrap();
        let value =
            super::statistics::query(&cold.0.0.lock().unwrap(), &cold.0.1, &cfg.uid).unwrap();
        assert_eq!(value["total"]["seconds"], json!(75.0), "cutoff={cutoff}");
        server.abort();
    }
}

#[tokio::test]
async fn discovery_larger_than_a_request_window_resumes_after_restart_and_then_refreshes() {
    use super::{
        migration::Genesis,
        request_budget::{self, Budget},
        v2_net::Client,
    };
    let (cfg, secret, store, server) = test_dav::server().await;
    let p = Profile::new(&cfg);
    let g = Genesis::for_config(&cfg).unwrap();
    let control = format!("/dav/BiliMusic-sync-v1/42/sync-v2/{}/control/", g.vault);
    let actors: Vec<_> = (0..150)
        .map(|n| format!("10000000-0000-4000-8000-{n:012}"))
        .collect();
    {
        let mut s = store.lock().unwrap();
        s.dirs.insert(control.clone());
        for actor in &actors {
            s.dirs.insert(format!("{control}{actor}/"));
        }
    }
    let cache = p.0.1.join("discovery-cache");
    let budget = Arc::new(Budget::testing(&p.0.1, 120));
    let first = Client::cached(&cfg, &secret, cache.clone()).unwrap();
    assert!(
        request_budget::scoped(budget.clone(), engine::heads(&first, &g, &BTreeMap::new()))
            .await
            .is_err()
    );
    assert_eq!(store.lock().unwrap().requests.len(), 120);
    drop(first);
    // A successful scan prefix survives rebuilding the client (process restart).
    budget.elapse_window();
    let restarted = Client::cached(&cfg, &secret, cache.clone()).unwrap();
    assert!(
        request_budget::scoped(
            budget.clone(),
            engine::heads(&restarted, &g, &BTreeMap::new())
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert_eq!(store.lock().unwrap().requests.len(), 152);
    // The completed checkpoint must be discarded, so later commits are discovered.
    let doc = Document::empty(g.scope(Domain::Library));
    let publication =
        super::protocol_v2::bootstrap_checkpoint(&doc, &actors[0], 1, BTreeMap::new()).unwrap();
    let head = publication.head;
    store.lock().unwrap().files.insert(
        format!("{control}{}/{}", actors[0], head.filename().unwrap()),
        (serde_json::to_vec(&head).unwrap(), 1_700_000_000),
    );
    budget.elapse_window();
    assert!(
        request_budget::scoped(
            budget.clone(),
            engine::heads(&restarted, &g, &BTreeMap::new())
        )
        .await
        .is_err()
    );
    budget.elapse_window();
    let heads = request_budget::scoped(
        budget.clone(),
        engine::heads(&restarted, &g, &BTreeMap::new()),
    )
    .await
    .unwrap();
    assert_eq!(heads.get(&actors[0]), Some(&head));
    server.abort();
}
