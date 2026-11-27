//! Device-scoped recommendation storage.
//!
//! This database is deliberately independent from the Bilibili profile
//! databases: logging into a recommendation provider never changes
//! `active-profile`, never resets playback and never touches Bilibili
//! credentials. The handle is opened once by Tauri and every write is guarded
//! by the source's random `credential_token` plus a per-row revision.
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub const VERSION: i64 = 2;

/// A refresh that never reached a terminal state (crash, force quit) stops
/// blocking new refreshes after this window.
const REFRESH_LEASE_MS: i64 = 5 * 60 * 1000;

/// Cross-day reuse keeps at most this many bindings per source. One daily list
/// holds a few dozen songs and the retained snapshots cover a week, so the cap
/// only matters for a source that has been in use for a long time.
const MATCH_CACHE_LIMIT: i64 = 2000;

const SOURCE_COLUMNS: &str = "id, provider, provider_uid, nickname, name, name_custom, sort_order, revision, credential_token, terms_accepted_at, last_refresh_at, last_refresh_state, last_error_code, last_error_at, retry_at, created_at, updated_at";
const SONG_COLUMNS: &str = "source_id, day, position, netease_song_id, title, artists_json, album, duration_seconds, cover_url, match_state, track_id, bvid, cid, track_json, match_mode, entry_revision, match_attempts, match_retry_at, match_error_code, matched_at";

pub fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > VERSION {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let transaction =
        rusqlite::Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < 1 {
        connection.execute_batch(include_str!(
            "../../migrations_recommendation/0001_recommendations.sql"
        ))?;
        connection.execute_batch("PRAGMA user_version=1;")?;
    }
    if version < 2 {
        connection.execute_batch(include_str!(
            "../../migrations_recommendation/0002_recommendation_matches.sql"
        ))?;
        connection.execute_batch("PRAGMA user_version=2;")?;
    }
    transaction.commit()
}

#[derive(Debug)]
pub enum RecommendationStoreError {
    Database(rusqlite::Error),
    Busy,
    NotFound,
    DuplicateSource,
    SourceChanged,
    BindingStale,
    ManualBindingProtected,
    InvalidState,
}

impl std::fmt::Display for RecommendationStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "{error}"),
            Self::Busy => formatter.write_str("推荐数据库正忙"),
            Self::NotFound => formatter.write_str("推荐数据不存在"),
            Self::DuplicateSource => formatter.write_str("该网易云账号已经添加"),
            Self::SourceChanged => formatter.write_str("推荐源已变更，请重试"),
            Self::BindingStale => formatter.write_str("推荐匹配已变更，请重试"),
            Self::ManualBindingProtected => formatter.write_str("自动匹配不会覆盖手动选择"),
            Self::InvalidState => formatter.write_str("推荐状态无效"),
        }
    }
}

impl std::error::Error for RecommendationStoreError {}

impl From<rusqlite::Error> for RecommendationStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationSourceRecord {
    pub id: String,
    pub provider: String,
    pub provider_uid: String,
    pub nickname: String,
    pub name: String,
    pub name_custom: bool,
    pub sort_order: i64,
    pub revision: i64,
    pub credential_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terms_accepted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refresh_at: Option<i64>,
    pub last_refresh_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationSongRecord {
    pub source_id: String,
    pub day: String,
    pub position: i64,
    pub netease_song_id: String,
    pub title: String,
    pub artists: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    pub match_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bvid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_mode: Option<String>,
    pub entry_revision: i64,
    pub match_attempts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_retry_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationSnapshotRecord {
    pub source: RecommendationSourceRecord,
    pub day: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<i64>,
    pub song_count: i64,
    pub songs: Vec<RecommendationSongRecord>,
}

#[derive(Debug, Clone)]
pub struct NewSource<'a> {
    pub id: &'a str,
    pub provider: &'a str,
    pub provider_uid: &'a str,
    pub nickname: &'a str,
    pub name: &'a str,
    pub cookie: &'a str,
    pub csrf: &'a str,
    pub credential_token: &'a str,
    pub terms_accepted_at: Option<i64>,
    pub now: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRecommendationSong {
    pub netease_song_id: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RecommendationBinding {
    pub track_id: String,
    pub bvid: String,
    pub cid: i64,
    pub track: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindMode {
    Automatic,
    Manual,
}

impl BindMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Manual => "manual",
        }
    }
}

pub struct RecommendationDatabase {
    connection: Mutex<Connection>,
}

impl RecommendationDatabase {
    pub fn open(app: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        use tauri::Manager;
        let directory = app.path().app_data_dir()?;
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        Self::open_path(&directory.join("recommendations.sqlite3"))
    }

    pub fn open_path(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let connection = Connection::open(path)?;
        migrate(&connection)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // WAL and SHM carry the same plaintext credentials as the main file
            // and are created by the migration, so narrow all three sidecars.
            for candidate in [
                path.to_owned(),
                sidecar(path, "-wal"),
                sidecar(path, "-shm"),
            ] {
                match std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>, RecommendationStoreError> {
        self.connection
            .lock()
            .map_err(|_| RecommendationStoreError::Busy)
    }
}

#[cfg(unix)]
fn sidecar(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    std::path::PathBuf::from(value)
}

pub fn list_sources(
    connection: &Connection,
) -> Result<Vec<RecommendationSourceRecord>, RecommendationStoreError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SOURCE_COLUMNS} FROM recommendation_sources ORDER BY sort_order, created_at, id"
    ))?;
    statement
        .query_map([], source_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(RecommendationStoreError::Database)
}

pub fn get_source(
    connection: &Connection,
    id: &str,
) -> rusqlite::Result<Option<RecommendationSourceRecord>> {
    connection
        .query_row(
            &format!("SELECT {SOURCE_COLUMNS} FROM recommendation_sources WHERE id=?1"),
            params![id],
            source_from_row,
        )
        .optional()
}

pub fn source_by_provider_uid(
    connection: &Connection,
    provider: &str,
    provider_uid: &str,
) -> rusqlite::Result<Option<RecommendationSourceRecord>> {
    connection
        .query_row(
            &format!(
                "SELECT {SOURCE_COLUMNS} FROM recommendation_sources WHERE provider=?1 AND provider_uid=?2"
            ),
            params![provider, provider_uid],
            source_from_row,
        )
        .optional()
}

/// Credentials are intentionally not part of the serialized source record.
pub fn source_credentials(
    connection: &Connection,
    id: &str,
) -> Result<Option<(RecommendationSourceRecord, String, String)>, RecommendationStoreError> {
    let Some(source) = get_source(connection, id)? else {
        return Ok(None);
    };
    let (cookie, csrf) = connection.query_row(
        "SELECT cookie, csrf FROM recommendation_sources WHERE id=?1",
        params![id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    Ok(Some((source, cookie, csrf)))
}

pub fn insert_source(
    connection: &mut Connection,
    source: &NewSource<'_>,
) -> Result<RecommendationSourceRecord, RecommendationStoreError> {
    let result = connection.execute(
        "INSERT INTO recommendation_sources
         (id, provider, provider_uid, nickname, name, name_custom, sort_order, cookie, csrf,
          credential_token, terms_accepted_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0,
                 (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM recommendation_sources),
                 ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            source.id,
            source.provider,
            source.provider_uid,
            source.nickname,
            source.name,
            source.cookie,
            source.csrf,
            source.credential_token,
            source.terms_accepted_at,
            source.now,
        ],
    );
    match result {
        Ok(_) => get_source(connection, source.id)?.ok_or(RecommendationStoreError::NotFound),
        Err(error) if unique_violation(&error) => Err(RecommendationStoreError::DuplicateSource),
        Err(error) => Err(RecommendationStoreError::Database(error)),
    }
}

/// Re-login updates credentials without changing the source identity or its
/// row revision guard. A custom name is preserved; a default name follows the
/// new nickname.
pub fn update_credentials(
    connection: &Connection,
    id: &str,
    nickname: &str,
    default_name: &str,
    cookie: &str,
    csrf: &str,
    credential_token: &str,
    now: i64,
) -> Result<RecommendationSourceRecord, RecommendationStoreError> {
    let changed = connection.execute(
        "UPDATE recommendation_sources SET nickname=?1,
           name=CASE WHEN name_custom=0 THEN ?2 ELSE name END,
           cookie=?3, csrf=?4, credential_token=?5, revision=revision+1,
           last_refresh_state='idle', last_error_code=NULL, last_error_at=NULL,
           retry_at=NULL, updated_at=?6
         WHERE id=?7",
        params![
            nickname,
            default_name,
            cookie,
            csrf,
            credential_token,
            now,
            id
        ],
    )?;
    if changed == 0 {
        return Err(RecommendationStoreError::NotFound);
    }
    get_source(connection, id)?.ok_or(RecommendationStoreError::NotFound)
}

pub fn rename_source(
    connection: &Connection,
    id: &str,
    name: &str,
    expected_revision: i64,
    now: i64,
) -> Result<RecommendationSourceRecord, RecommendationStoreError> {
    let changed = connection.execute(
        "UPDATE recommendation_sources SET name=?1, name_custom=1, revision=revision+1, updated_at=?2
         WHERE id=?3 AND revision=?4",
        params![name, now, id, expected_revision],
    )?;
    if changed == 0 {
        return source_change_error(connection, id);
    }
    get_source(connection, id)?.ok_or(RecommendationStoreError::NotFound)
}

pub fn remove_source(
    connection: &Connection,
    id: &str,
    expected_revision: i64,
) -> Result<(), RecommendationStoreError> {
    let changed = connection.execute(
        "DELETE FROM recommendation_sources WHERE id=?1 AND revision=?2",
        params![id, expected_revision],
    )?;
    if changed == 0 {
        return if get_source(connection, id)?.is_some() {
            Err(RecommendationStoreError::SourceChanged)
        } else {
            Err(RecommendationStoreError::NotFound)
        };
    }
    Ok(())
}

pub fn set_refresh_state(
    connection: &Connection,
    id: &str,
    expected_token: &str,
    state: &str,
    error_code: Option<&str>,
    retry_at: Option<i64>,
    now: i64,
) -> Result<RecommendationSourceRecord, RecommendationStoreError> {
    if !matches!(
        state,
        "idle" | "refreshing" | "ready" | "error" | "auth-required"
    ) {
        return Err(RecommendationStoreError::InvalidState);
    }
    check_token(connection, id, expected_token)?;
    connection.execute(
        "UPDATE recommendation_sources SET last_refresh_state=?1,
           last_refresh_at=CASE WHEN ?1='ready' THEN ?2 ELSE last_refresh_at END,
           last_error_code=?3,
           last_error_at=CASE WHEN ?3 IS NULL THEN NULL ELSE ?2 END,
           retry_at=?4, updated_at=?2
         WHERE id=?5",
        params![state, now, error_code, retry_at, id],
    )?;
    get_source(connection, id)?.ok_or(RecommendationStoreError::NotFound)
}

/// Claims the single refresh slot of a source. Two overlapping refreshes would
/// both upsert the same day; the later response could then delete bindings made
/// from the earlier one. The claim is token-guarded and released by every
/// terminal `set_refresh_state` call, or by `REFRESH_LEASE_MS` when a previous
/// attempt died without one.
pub fn begin_refresh(
    connection: &Connection,
    id: &str,
    expected_token: &str,
    now: i64,
) -> Result<bool, RecommendationStoreError> {
    check_token(connection, id, expected_token)?;
    let changed = connection.execute(
        "UPDATE recommendation_sources SET last_refresh_state='refreshing', updated_at=?1
         WHERE id=?2 AND credential_token=?3
           AND (last_refresh_state<>'refreshing' OR updated_at<?4)",
        params![now, id, expected_token, now - REFRESH_LEASE_MS],
    )?;
    Ok(changed == 1)
}

pub fn snapshot(
    connection: &Connection,
    source_id: &str,
    day: &str,
) -> Result<Option<RecommendationSnapshotRecord>, RecommendationStoreError> {
    let Some(source) = get_source(connection, source_id)? else {
        return Err(RecommendationStoreError::NotFound);
    };
    let day_row: Option<(i64, i64)> = connection
        .query_row(
            "SELECT fetched_at, song_count FROM recommendation_days WHERE source_id=?1 AND day=?2",
            params![source_id, day],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((fetched_at, song_count)) = day_row else {
        return Ok(None);
    };
    let mut statement = connection.prepare(&format!(
        "SELECT {SONG_COLUMNS} FROM recommendation_songs
         WHERE source_id=?1 AND day=?2 ORDER BY position, netease_song_id"
    ))?;
    let songs = statement
        .query_map(params![source_id, day], song_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(RecommendationSnapshotRecord {
        source,
        day: day.to_owned(),
        fetched_at: Some(fetched_at),
        song_count,
        songs,
    }))
}

/// Replace one day while retaining every existing binding. Songs that vanished
/// from a successful response are removed; a song that remains keeps its match
/// state even when it moves to a new position.
pub fn upsert_day(
    connection: &mut Connection,
    source_id: &str,
    day: &str,
    fetched_at: i64,
    upstream_code: Option<i64>,
    songs: &[NewRecommendationSong],
    expected_token: &str,
) -> Result<RecommendationSnapshotRecord, RecommendationStoreError> {
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&NewRecommendationSong> = songs
        .iter()
        .filter(|song| seen.insert(song.netease_song_id.as_str()))
        .collect();
    let transaction =
        rusqlite::Transaction::new_unchecked(&*connection, TransactionBehavior::Immediate)?;
    // A re-login rotates the credential token; a refresh fetched with the old
    // session must not replace a day written after the new login.
    check_token(&transaction, source_id, expected_token)?;
    transaction.execute(
        "INSERT INTO recommendation_days (source_id, day, fetched_at, song_count, upstream_code)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_id, day) DO UPDATE SET
           fetched_at=excluded.fetched_at, song_count=excluded.song_count,
           upstream_code=excluded.upstream_code",
        params![
            source_id,
            day,
            fetched_at,
            unique.len() as i64,
            upstream_code
        ],
    )?;
    for (position, song) in unique.iter().enumerate() {
        let artists = serde_json::to_string(&song.artists)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        transaction.execute(
            "INSERT INTO recommendation_songs
             (source_id, day, position, netease_song_id, title, artists_json, album,
              duration_seconds, cover_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(source_id, day, netease_song_id) DO UPDATE SET
               position=excluded.position, title=excluded.title,
               artists_json=excluded.artists_json, album=excluded.album,
               duration_seconds=excluded.duration_seconds, cover_url=excluded.cover_url",
            params![
                source_id,
                day,
                position as i64,
                song.netease_song_id,
                song.title,
                artists,
                song.album,
                song.duration_seconds,
                song.cover_url,
            ],
        )?;
    }
    let existing: Vec<String> = {
        let mut statement = transaction.prepare(
            "SELECT netease_song_id FROM recommendation_songs WHERE source_id=?1 AND day=?2",
        )?;
        statement
            .query_map(params![source_id, day], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in existing {
        if !seen.contains(id.as_str()) {
            transaction.execute(
                "DELETE FROM recommendation_songs WHERE source_id=?1 AND day=?2 AND netease_song_id=?3",
                params![source_id, day, id],
            )?;
        }
    }
    seed_cached_matches(&transaction, source_id, day)?;
    touch_cached_matches(&transaction, source_id, day, fetched_at)?;
    prune_match_cache(&transaction, source_id)?;
    transaction.commit()?;
    snapshot(connection, source_id, day)?.ok_or(RecommendationStoreError::NotFound)
}

/// A day starts as pending rows. Before the matching lane can see them, copy
/// the binding that the same external song received on an earlier day so that
/// a returning song does not search Bilibili again. Only rows the user has
/// never touched are seeded; a surviving row keeps its own binding, and a row
/// the user reset keeps its reset.
fn seed_cached_matches(
    connection: &Connection,
    source_id: &str,
    day: &str,
) -> rusqlite::Result<usize> {
    connection.execute(
        "UPDATE recommendation_songs AS target
         SET match_state='matched', track_id=cached.track_id, bvid=cached.bvid,
           cid=cached.cid, track_json=cached.track_json, match_mode=cached.match_mode,
           matched_at=cached.matched_at
         FROM recommendation_matches AS cached
         WHERE target.source_id=?1 AND target.day=?2
           AND cached.source_id=target.source_id
           AND cached.netease_song_id=target.netease_song_id
           AND target.match_state='pending' AND target.entry_revision=0
           AND target.track_json IS NULL",
        params![source_id, day],
    )
}

/// A binding ages out when its song stops being listed, not when it gets old.
/// Every song in a written day refreshes the cached timestamp, so the size cap
/// evicts the songs that left the list instead of the ones still in use. The
/// song row keeps the timestamp it was seeded with; only the cache entry moves.
fn touch_cached_matches(
    connection: &Connection,
    source_id: &str,
    day: &str,
    seen_at: i64,
) -> rusqlite::Result<usize> {
    connection.execute(
        "UPDATE recommendation_matches AS cached
         SET matched_at=?3
         WHERE cached.source_id=?1
           AND cached.netease_song_id IN (
             SELECT netease_song_id FROM recommendation_songs
             WHERE source_id=?1 AND day=?2)",
        params![source_id, day, seen_at],
    )
}

/// Drops cached bindings whose song no longer appears in any retained day, so
/// a list change clears the corresponding cache, and enforces the size cap.
fn prune_match_cache(connection: &Connection, source_id: &str) -> rusqlite::Result<usize> {
    let orphaned = connection.execute(
        "DELETE FROM recommendation_matches
         WHERE source_id=?1
           AND netease_song_id NOT IN (
             SELECT netease_song_id FROM recommendation_songs WHERE source_id=?1)",
        params![source_id],
    )?;
    let excess = connection.execute(
        "DELETE FROM recommendation_matches
         WHERE source_id=?1
           AND netease_song_id NOT IN (
             SELECT netease_song_id FROM recommendation_matches
             WHERE source_id=?1 ORDER BY matched_at DESC, netease_song_id LIMIT ?2)",
        params![source_id, MATCH_CACHE_LIMIT],
    )?;
    Ok(orphaned + excess)
}

pub fn bind(
    connection: &mut Connection,
    source_id: &str,
    day: &str,
    netease_song_id: &str,
    binding: &RecommendationBinding,
    mode: BindMode,
    expected_entry_revision: i64,
    expected_token: &str,
    now: i64,
) -> Result<RecommendationSongRecord, RecommendationStoreError> {
    let transaction =
        rusqlite::Transaction::new_unchecked(&*connection, TransactionBehavior::Immediate)?;
    check_token(&transaction, source_id, expected_token)?;
    let current: Option<(i64, Option<String>)> = transaction
        .query_row(
            "SELECT entry_revision, match_mode FROM recommendation_songs
             WHERE source_id=?1 AND day=?2 AND netease_song_id=?3",
            params![source_id, day, netease_song_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((entry_revision, match_mode)) = current else {
        return Err(RecommendationStoreError::NotFound);
    };
    if entry_revision != expected_entry_revision {
        return Err(RecommendationStoreError::BindingStale);
    }
    if mode == BindMode::Automatic && match_mode.as_deref() == Some("manual") {
        return Err(RecommendationStoreError::ManualBindingProtected);
    }
    let track_json = serde_json::to_string(&binding.track)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let changed = transaction.execute(
        "UPDATE recommendation_songs SET match_state='matched', track_id=?1, bvid=?2, cid=?3,
           track_json=?4, match_mode=?5, entry_revision=entry_revision+1,
           match_attempts=match_attempts+1, match_retry_at=NULL, match_error_code=NULL,
           matched_at=?6
         WHERE source_id=?7 AND day=?8 AND netease_song_id=?9 AND entry_revision=?10
           AND (match_mode IS NULL OR match_mode != 'manual' OR ?5='manual')",
        params![
            binding.track_id,
            binding.bvid,
            binding.cid,
            track_json,
            mode.as_str(),
            now,
            source_id,
            day,
            netease_song_id,
            expected_entry_revision,
        ],
    )?;
    if changed == 0 {
        return Err(RecommendationStoreError::BindingStale);
    }
    remember_binding(
        &transaction,
        source_id,
        netease_song_id,
        binding,
        &track_json,
        mode,
        now,
    )?;
    transaction.commit()?;
    get_song(connection, source_id, day, netease_song_id)?.ok_or(RecommendationStoreError::NotFound)
}

/// Keeps the cross-day binding. A manual choice is cached too, so a later day
/// starts from the user's pick instead of asking the automatic lane again.
fn remember_binding(
    connection: &Connection,
    source_id: &str,
    netease_song_id: &str,
    binding: &RecommendationBinding,
    track_json: &str,
    mode: BindMode,
    now: i64,
) -> rusqlite::Result<usize> {
    connection.execute(
        "INSERT INTO recommendation_matches
         (source_id, netease_song_id, track_id, bvid, cid, track_json, match_mode, matched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(source_id, netease_song_id) DO UPDATE SET
           track_id=excluded.track_id, bvid=excluded.bvid, cid=excluded.cid,
           track_json=excluded.track_json, match_mode=excluded.match_mode,
           matched_at=excluded.matched_at",
        params![
            source_id,
            netease_song_id,
            binding.track_id,
            binding.bvid,
            binding.cid,
            track_json,
            mode.as_str(),
            now,
        ],
    )
}

pub fn mark_match_failed(
    connection: &mut Connection,
    source_id: &str,
    day: &str,
    netease_song_id: &str,
    state: &str,
    error_code: Option<&str>,
    retry_at: Option<i64>,
    expected_entry_revision: i64,
    expected_token: &str,
) -> Result<RecommendationSongRecord, RecommendationStoreError> {
    if !matches!(state, "missing" | "failed") {
        return Err(RecommendationStoreError::InvalidState);
    }
    let transaction =
        rusqlite::Transaction::new_unchecked(&*connection, TransactionBehavior::Immediate)?;
    check_token(&transaction, source_id, expected_token)?;
    let current: Option<i64> = transaction
        .query_row(
            "SELECT entry_revision FROM recommendation_songs
             WHERE source_id=?1 AND day=?2 AND netease_song_id=?3",
            params![source_id, day, netease_song_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(entry_revision) = current else {
        return Err(RecommendationStoreError::NotFound);
    };
    if entry_revision != expected_entry_revision {
        return Err(RecommendationStoreError::BindingStale);
    }
    let changed = transaction.execute(
        "UPDATE recommendation_songs SET match_state=?1, track_id=NULL, bvid=NULL, cid=NULL,
           track_json=NULL, match_mode=NULL, entry_revision=entry_revision+1,
           match_attempts=match_attempts+1, match_retry_at=?2, match_error_code=?3,
           matched_at=NULL
         WHERE source_id=?4 AND day=?5 AND netease_song_id=?6 AND entry_revision=?7
           AND (match_mode IS NULL OR match_mode != 'manual')",
        params![
            state,
            retry_at,
            error_code,
            source_id,
            day,
            netease_song_id,
            expected_entry_revision,
        ],
    )?;
    if changed == 0 {
        return Err(RecommendationStoreError::BindingStale);
    }
    transaction.commit()?;
    get_song(connection, source_id, day, netease_song_id)?.ok_or(RecommendationStoreError::NotFound)
}

/// Reset automatic matches for a day; manual choices survive a re-match.
///
/// The cached cross-day bindings for the rows this clears are dropped in the
/// same transaction: "重新匹配全部" means the next pass must search again, and a
/// later refresh must not seed the same bindings straight back. A manual pick
/// keeps its cache, because the same rule protects it on the next day.
pub fn reset_matches(
    connection: &Connection,
    source_id: &str,
    day: &str,
    expected_token: &str,
) -> Result<usize, RecommendationStoreError> {
    let transaction =
        rusqlite::Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    check_token(&transaction, source_id, expected_token)?;
    transaction.execute(
        "DELETE FROM recommendation_matches
         WHERE source_id=?1
           AND netease_song_id IN (
             SELECT netease_song_id FROM recommendation_songs
             WHERE source_id=?1 AND day=?2
               AND (match_mode IS NULL OR match_mode != 'manual'))",
        params![source_id, day],
    )?;
    let changed = transaction.execute(
        "UPDATE recommendation_songs SET match_state='pending', track_id=NULL, bvid=NULL,
           cid=NULL, track_json=NULL, match_mode=NULL, entry_revision=entry_revision+1,
           match_attempts=0, match_retry_at=NULL, match_error_code=NULL, matched_at=NULL
         WHERE source_id=?1 AND day=?2 AND (match_mode IS NULL OR match_mode != 'manual')
           AND NOT (match_state='pending' AND entry_revision=0)",
        params![source_id, day],
    )?;
    transaction.commit()?;
    Ok(changed)
}

/// Retention uses the fetch timestamp so it does not depend on the client's
/// clock or on a particular day string being supplied. The day delete and the
/// cache prune commit together, so a concurrent refresh never sees days
/// removed while their cached bindings are still present.
pub fn prune_fetched_before(
    connection: &Connection,
    source_id: &str,
    before_ms: i64,
) -> rusqlite::Result<usize> {
    let transaction =
        rusqlite::Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let deleted = transaction.execute(
        "DELETE FROM recommendation_days WHERE source_id=?1 AND fetched_at < ?2",
        params![source_id, before_ms],
    )?;
    prune_match_cache(&transaction, source_id)?;
    transaction.commit()?;
    Ok(deleted)
}

pub fn clear_all(connection: &Connection) -> rusqlite::Result<usize> {
    connection.execute("DELETE FROM recommendation_sources", [])
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecommendationSourceRecord> {
    Ok(RecommendationSourceRecord {
        id: row.get("id")?,
        provider: row.get("provider")?,
        provider_uid: row.get("provider_uid")?,
        nickname: row.get("nickname")?,
        name: row.get("name")?,
        name_custom: row.get::<_, i64>("name_custom")? != 0,
        sort_order: row.get("sort_order")?,
        revision: row.get("revision")?,
        credential_token: row.get("credential_token")?,
        terms_accepted_at: row.get("terms_accepted_at")?,
        last_refresh_at: row.get("last_refresh_at")?,
        last_refresh_state: row.get("last_refresh_state")?,
        last_error_code: row.get("last_error_code")?,
        last_error_at: row.get("last_error_at")?,
        retry_at: row.get("retry_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn song_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecommendationSongRecord> {
    let artists_json: String = row.get("artists_json")?;
    let track_json: Option<String> = row.get("track_json")?;
    Ok(RecommendationSongRecord {
        source_id: row.get("source_id")?,
        day: row.get("day")?,
        position: row.get("position")?,
        netease_song_id: row.get("netease_song_id")?,
        title: row.get("title")?,
        artists: serde_json::from_str(&artists_json).unwrap_or_default(),
        album: row.get("album")?,
        duration_seconds: row.get("duration_seconds")?,
        cover_url: row.get("cover_url")?,
        match_state: row.get("match_state")?,
        track_id: row.get("track_id")?,
        bvid: row.get("bvid")?,
        cid: row.get("cid")?,
        track: track_json.and_then(|json| serde_json::from_str(&json).ok()),
        match_mode: row.get("match_mode")?,
        entry_revision: row.get("entry_revision")?,
        match_attempts: row.get("match_attempts")?,
        match_retry_at: row.get("match_retry_at")?,
        match_error_code: row.get("match_error_code")?,
        matched_at: row.get("matched_at")?,
    })
}

pub(crate) fn get_song(
    connection: &Connection,
    source_id: &str,
    day: &str,
    netease_song_id: &str,
) -> rusqlite::Result<Option<RecommendationSongRecord>> {
    connection
        .query_row(
            &format!(
                "SELECT {SONG_COLUMNS} FROM recommendation_songs
                 WHERE source_id=?1 AND day=?2 AND netease_song_id=?3"
            ),
            params![source_id, day, netease_song_id],
            song_from_row,
        )
        .optional()
}

fn check_token(
    connection: &Connection,
    source_id: &str,
    expected_token: &str,
) -> Result<(), RecommendationStoreError> {
    let token: Option<String> = connection
        .query_row(
            "SELECT credential_token FROM recommendation_sources WHERE id=?1",
            params![source_id],
            |row| row.get(0),
        )
        .optional()?;
    match token {
        None => Err(RecommendationStoreError::NotFound),
        Some(token) if token != expected_token => Err(RecommendationStoreError::SourceChanged),
        Some(_) => Ok(()),
    }
}

fn source_change_error(
    connection: &Connection,
    id: &str,
) -> Result<RecommendationSourceRecord, RecommendationStoreError> {
    if get_source(connection, id)?.is_some() {
        Err(RecommendationStoreError::SourceChanged)
    } else {
        Err(RecommendationStoreError::NotFound)
    }
}

fn unique_violation(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(details, Some(message))
            if details.code == rusqlite::ErrorCode::ConstraintViolation
                && message.contains("UNIQUE")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection
    }

    fn upsert(
        connection: &mut Connection,
        source_id: &str,
        day: &str,
        fetched_at: i64,
        upstream_code: Option<i64>,
        songs: &[NewRecommendationSong],
    ) -> Result<RecommendationSnapshotRecord, RecommendationStoreError> {
        upsert_day(
            connection,
            source_id,
            day,
            fetched_at,
            upstream_code,
            songs,
            "token",
        )
    }

    fn source<'a>(id: &'a str, uid: &'a str, token: &'a str) -> NewSource<'a> {
        NewSource {
            id,
            provider: "netease",
            provider_uid: uid,
            nickname: "小明",
            name: "网易云音乐 · 小明",
            cookie: "MUSIC_U=secret",
            csrf: "csrf",
            credential_token: token,
            terms_accepted_at: Some(1),
            now: 100,
        }
    }

    fn song(id: &str, title: &str) -> NewRecommendationSong {
        NewRecommendationSong {
            netease_song_id: id.into(),
            title: title.into(),
            artists: vec!["歌手".into()],
            album: None,
            duration_seconds: Some(180.0),
            cover_url: None,
        }
    }

    fn binding(bvid: &str) -> RecommendationBinding {
        RecommendationBinding {
            track_id: format!("bilibili:{bvid}:1"),
            bvid: bvid.into(),
            cid: 1,
            track: serde_json::json!({
                "id": format!("bilibili:{bvid}:1"),
                "source": {"provider": "bilibili", "bvid": bvid, "cid": 1, "page": 1},
                "title": bvid,
                "durationSeconds": 180,
                "liked": false
            }),
        }
    }

    #[test]
    fn fresh_database_reaches_version_one_and_replays_safely() {
        let connection = database();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            VERSION
        );
        migrate(&connection).unwrap();
        assert_eq!(list_sources(&connection).unwrap().len(), 0);
    }

    #[test]
    fn sources_are_unique_by_provider_account_and_names_use_revisions() {
        let mut connection = database();
        let created = insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        assert_eq!(created.sort_order, 0);
        assert_eq!(created.revision, 0);
        assert!(matches!(
            insert_source(&mut connection, &source("s2", "42", "other")),
            Err(RecommendationStoreError::DuplicateSource)
        ));
        let second = insert_source(&mut connection, &source("s2", "43", "other")).unwrap();
        assert_eq!(second.sort_order, 1);

        assert!(matches!(
            rename_source(&connection, "s1", "新名字", 9, 200),
            Err(RecommendationStoreError::SourceChanged)
        ));
        let renamed = rename_source(&connection, "s1", "新名字", 0, 200).unwrap();
        assert_eq!(renamed.name, "新名字");
        assert!(renamed.name_custom);
        assert_eq!(renamed.revision, 1);

        assert!(matches!(
            remove_source(&connection, "s1", 0),
            Err(RecommendationStoreError::SourceChanged)
        ));
        remove_source(&connection, "s1", 1).unwrap();
        assert!(get_source(&connection, "s1").unwrap().is_none());
    }

    #[test]
    fn refresh_preserves_bindings_and_removes_vanished_songs() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        let first = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            100,
            Some(200),
            &[song("a", "A"), song("b", "B")],
        )
        .unwrap();
        assert_eq!(first.song_count, 2);
        assert_eq!(first.songs[0].position, 0);
        assert_eq!(first.songs[1].position, 1);

        let bound = bind(
            &mut connection,
            "s1",
            "2026-11-24",
            "a",
            &binding("BV1"),
            BindMode::Automatic,
            0,
            "token",
            110,
        )
        .unwrap();
        assert_eq!(bound.match_state, "matched");
        assert_eq!(bound.entry_revision, 1);
        assert_eq!(bound.bvid.as_deref(), Some("BV1"));

        let refreshed = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            120,
            None,
            &[song("c", "C"), song("b", "B")],
        )
        .unwrap();
        assert_eq!(refreshed.song_count, 2);
        assert!(refreshed.songs.iter().all(|row| row.netease_song_id != "a"));
        let b = refreshed
            .songs
            .iter()
            .find(|row| row.netease_song_id == "b")
            .unwrap();
        assert_eq!(b.position, 1);
        assert_eq!(b.match_state, "pending");

        remove_source(&connection, "s1", 0).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM recommendation_songs", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM recommendation_days", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn duplicate_song_ids_are_ignored_and_empty_days_clear_only_that_day() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        let day = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            100,
            None,
            &[song("a", "A"), song("a", "A again")],
        )
        .unwrap();
        assert_eq!(day.song_count, 1);
        assert_eq!(day.songs[0].title, "A");

        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            90,
            None,
            &[song("z", "Z")],
        )
        .unwrap();
        upsert(&mut connection, "s1", "2026-11-24", 110, None, &[]).unwrap();
        let cleared = snapshot(&connection, "s1", "2026-11-24").unwrap().unwrap();
        assert_eq!(cleared.song_count, 0);
        assert!(cleared.songs.is_empty());
        assert!(snapshot(&connection, "s1", "2026-11-23").unwrap().is_some());
    }

    #[test]
    fn automatic_matching_cannot_overwrite_a_manual_choice() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            100,
            None,
            &[song("a", "A"), song("b", "B")],
        )
        .unwrap();
        let manual = bind(
            &mut connection,
            "s1",
            "2026-11-24",
            "a",
            &binding("BV1"),
            BindMode::Manual,
            0,
            "token",
            110,
        )
        .unwrap();
        assert_eq!(manual.match_mode.as_deref(), Some("manual"));

        assert!(matches!(
            bind(
                &mut connection,
                "s1",
                "2026-11-24",
                "a",
                &binding("BV2"),
                BindMode::Automatic,
                1,
                "token",
                120,
            ),
            Err(RecommendationStoreError::ManualBindingProtected)
        ));
        assert!(matches!(
            bind(
                &mut connection,
                "s1",
                "2026-11-24",
                "a",
                &binding("BV2"),
                BindMode::Automatic,
                0,
                "token",
                120,
            ),
            Err(RecommendationStoreError::BindingStale)
        ));
        assert!(matches!(
            bind(
                &mut connection,
                "s1",
                "2026-11-24",
                "a",
                &binding("BV2"),
                BindMode::Manual,
                1,
                "other-token",
                120,
            ),
            Err(RecommendationStoreError::SourceChanged)
        ));

        bind(
            &mut connection,
            "s1",
            "2026-11-24",
            "b",
            &binding("BV3"),
            BindMode::Automatic,
            0,
            "token",
            130,
        )
        .unwrap();
        let reset = reset_matches(&connection, "s1", "2026-11-24", "token").unwrap();
        assert_eq!(reset, 1);
        let snapshot = snapshot(&connection, "s1", "2026-11-24").unwrap().unwrap();
        let a = snapshot
            .songs
            .iter()
            .find(|row| row.netease_song_id == "a")
            .unwrap();
        assert_eq!(a.match_state, "matched");
        assert_eq!(a.match_mode.as_deref(), Some("manual"));
        let b = snapshot
            .songs
            .iter()
            .find(|row| row.netease_song_id == "b")
            .unwrap();
        assert_eq!(b.match_state, "pending");
        assert_eq!(b.track, None);
    }

    #[test]
    fn failures_are_revision_guarded_and_refresh_state_is_token_guarded() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();

        assert!(matches!(
            mark_match_failed(
                &mut connection,
                "s1",
                "2026-11-24",
                "a",
                "missing",
                Some("no_match"),
                Some(500),
                1,
                "token",
            ),
            Err(RecommendationStoreError::BindingStale)
        ));
        let failed = mark_match_failed(
            &mut connection,
            "s1",
            "2026-11-24",
            "a",
            "missing",
            Some("no_match"),
            Some(500),
            0,
            "token",
        )
        .unwrap();
        assert_eq!(failed.match_state, "missing");
        assert_eq!(failed.match_error_code.as_deref(), Some("no_match"));
        assert_eq!(failed.match_retry_at, Some(500));
        assert_eq!(failed.match_attempts, 1);

        assert!(matches!(
            set_refresh_state(&connection, "s1", "other", "ready", None, None, 300),
            Err(RecommendationStoreError::SourceChanged)
        ));
        let ready =
            set_refresh_state(&connection, "s1", "token", "ready", None, None, 300).unwrap();
        assert_eq!(ready.last_refresh_state, "ready");
        assert_eq!(ready.last_refresh_at, Some(300));
        assert_eq!(ready.last_error_code, None);
    }

    #[test]
    fn only_one_refresh_can_hold_the_lease() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();

        assert!(begin_refresh(&connection, "s1", "token", 1000).unwrap());
        assert_eq!(
            get_source(&connection, "s1")
                .unwrap()
                .unwrap()
                .last_refresh_state,
            "refreshing"
        );
        assert!(!begin_refresh(&connection, "s1", "token", 1001).unwrap());
        assert!(matches!(
            begin_refresh(&connection, "s1", "other", 1001),
            Err(RecommendationStoreError::SourceChanged)
        ));
        // A crash must not block refresh forever.
        assert!(begin_refresh(&connection, "s1", "token", 1000 + REFRESH_LEASE_MS + 1).unwrap());

        set_refresh_state(&connection, "s1", "token", "ready", None, None, 2000).unwrap();
        assert!(begin_refresh(&connection, "s1", "token", 2001).unwrap());
    }

    #[test]
    fn a_refresh_from_an_old_session_cannot_replace_a_newer_day() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        update_credentials(
            &mut connection,
            "s1",
            "小明",
            "网易云音乐 · 小明",
            "MUSIC_U=new",
            "csrf",
            "new-token",
            150,
        )
        .unwrap();

        assert!(matches!(
            upsert_day(
                &mut connection,
                "s1",
                "2026-11-24",
                160,
                None,
                &[song("b", "B")],
                "token",
            ),
            Err(RecommendationStoreError::SourceChanged)
        ));
        let kept = snapshot(&connection, "s1", "2026-11-24").unwrap().unwrap();
        assert_eq!(kept.songs[0].netease_song_id, "a");

        upsert_day(
            &mut connection,
            "s1",
            "2026-11-24",
            170,
            None,
            &[song("b", "B")],
            "new-token",
        )
        .unwrap();
        let replaced = snapshot(&connection, "s1", "2026-11-24").unwrap().unwrap();
        assert_eq!(replaced.songs[0].netease_song_id, "b");
    }

    #[test]
    fn pruning_drops_old_days_and_clear_all_removes_every_source() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-22",
            80,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            90,
            None,
            &[song("b", "B")],
        )
        .unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            100,
            None,
            &[song("c", "C")],
        )
        .unwrap();
        assert_eq!(prune_fetched_before(&connection, "s1", 100).unwrap(), 2);
        assert!(snapshot(&connection, "s1", "2026-11-22").unwrap().is_none());
        assert!(snapshot(&connection, "s1", "2026-11-24").unwrap().is_some());

        assert_eq!(clear_all(&connection).unwrap(), 1);
        assert!(list_sources(&connection).unwrap().is_empty());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM recommendation_songs", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn fetch_based_pruning_keeps_only_the_recent_window() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        for (day, fetched_at) in [("2026-11-22", 80), ("2026-11-23", 90), ("2026-11-24", 100)] {
            upsert(
                &mut connection,
                "s1",
                day,
                fetched_at,
                None,
                &[song(day, day)],
            )
            .unwrap();
        }
        assert_eq!(prune_fetched_before(&connection, "s1", 95).unwrap(), 2);
        assert!(snapshot(&connection, "s1", "2026-11-23").unwrap().is_none());
        assert!(snapshot(&connection, "s1", "2026-11-24").unwrap().is_some());
    }

    #[test]
    fn a_song_matched_on_one_day_starts_matched_on_the_next_day() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "a",
            &binding("BV1"),
            BindMode::Automatic,
            0,
            "token",
            110,
        )
        .unwrap();

        let next = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            120,
            None,
            &[song("a", "A"), song("b", "B")],
        )
        .unwrap();
        let a = next
            .songs
            .iter()
            .find(|row| row.netease_song_id == "a")
            .unwrap();
        assert_eq!(a.match_state, "matched");
        assert_eq!(a.bvid.as_deref(), Some("BV1"));
        assert_eq!(a.track_id.as_deref(), Some("bilibili:BV1:1"));
        assert_eq!(a.match_mode.as_deref(), Some("automatic"));
        assert_eq!(a.matched_at, Some(110));
        // A seeded row is untouched by the user, so the lane may still replace
        // it with a better match using the snapshot's own revision.
        assert_eq!(a.entry_revision, 0);
        let b = next
            .songs
            .iter()
            .find(|row| row.netease_song_id == "b")
            .unwrap();
        assert_eq!(b.match_state, "pending");
        // The earlier day keeps its own binding.
        let previous = snapshot(&connection, "s1", "2026-11-23").unwrap().unwrap();
        assert_eq!(previous.songs[0].match_state, "matched");
    }

    #[test]
    fn a_manual_choice_is_reused_and_still_cannot_be_overwritten() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "a",
            &binding("BV9"),
            BindMode::Manual,
            0,
            "token",
            110,
        )
        .unwrap();

        let next = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            120,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        assert_eq!(next.songs[0].match_mode.as_deref(), Some("manual"));
        assert_eq!(next.songs[0].bvid.as_deref(), Some("BV9"));
        assert!(matches!(
            bind(
                &mut connection,
                "s1",
                "2026-11-24",
                "a",
                &binding("BV2"),
                BindMode::Automatic,
                0,
                "token",
                130,
            ),
            Err(RecommendationStoreError::ManualBindingProtected)
        ));
    }

    #[test]
    fn resetting_matches_for_a_day_drops_its_cached_binding() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "a",
            &binding("BV1"),
            BindMode::Automatic,
            0,
            "token",
            110,
        )
        .unwrap();
        assert_eq!(
            reset_matches(&connection, "s1", "2026-11-23", "token").unwrap(),
            1
        );
        assert_eq!(cached_binding_count(&connection), 0);

        let next = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            120,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        assert_eq!(next.songs[0].match_state, "pending");
    }

    #[test]
    fn resetting_matches_keeps_a_manual_pick_and_its_cached_binding() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            100,
            None,
            &[song("a", "A"), song("m", "M")],
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "a",
            &binding("BV1"),
            BindMode::Automatic,
            0,
            "token",
            110,
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "m",
            &binding("BV2"),
            BindMode::Manual,
            0,
            "token",
            111,
        )
        .unwrap();

        assert_eq!(
            reset_matches(&connection, "s1", "2026-11-23", "token").unwrap(),
            1
        );
        // Only the automatic row is dropped, and only its cache goes with it.
        assert_eq!(cached_binding_count(&connection), 1);
        let day = snapshot(&connection, "s1", "2026-11-23").unwrap().unwrap();
        let manual = day
            .songs
            .iter()
            .find(|row| row.netease_song_id == "m")
            .unwrap();
        assert_eq!(manual.match_mode.as_deref(), Some("manual"));

        // The next day seeds the manual pick and searches the reset song again.
        let next = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            200,
            None,
            &[song("a", "A"), song("m", "M")],
        )
        .unwrap();
        let automatic = next
            .songs
            .iter()
            .find(|row| row.netease_song_id == "a")
            .unwrap();
        assert_eq!(automatic.match_state, "pending");
        let manual = next
            .songs
            .iter()
            .find(|row| row.netease_song_id == "m")
            .unwrap();
        assert_eq!(manual.bvid.as_deref(), Some("BV2"));
        assert_eq!(manual.match_mode.as_deref(), Some("manual"));
    }

    #[test]
    fn a_song_missing_from_every_retained_day_loses_its_cached_binding() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "a",
            &binding("BV1"),
            BindMode::Automatic,
            0,
            "token",
            110,
        )
        .unwrap();
        // The provider replaces the list: the vanished song loses its cache.
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            115,
            None,
            &[song("b", "B")],
        )
        .unwrap();
        assert_eq!(cached_binding_count(&connection), 0);

        let next = upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            120,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        assert_eq!(next.songs[0].match_state, "pending");
    }

    #[test]
    fn removing_a_source_cascades_to_its_cached_bindings() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "a",
            &binding("BV1"),
            BindMode::Automatic,
            0,
            "token",
            110,
        )
        .unwrap();
        assert_eq!(cached_binding_count(&connection), 1);
        remove_source(&connection, "s1", 0).unwrap();
        assert_eq!(cached_binding_count(&connection), 0);
    }

    #[test]
    fn the_cache_cap_keeps_the_newest_bindings() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            100,
            None,
            &[song("seed", "Seed")],
        )
        .unwrap();
        for index in 0..(MATCH_CACHE_LIMIT + 5) {
            let id = format!("x{index}");
            connection
                .execute(
                    "INSERT INTO recommendation_songs
                     (source_id, day, position, netease_song_id, title, artists_json)
                     VALUES ('s1', '2026-11-24', ?1, ?2, ?2, '[]')",
                    params![index + 1, id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO recommendation_matches
                     (source_id, netease_song_id, track_id, bvid, cid, track_json,
                      match_mode, matched_at)
                     VALUES ('s1', ?1, ?1, ?1, 1, '{}', 'automatic', ?2)",
                    params![id, index],
                )
                .unwrap();
        }
        prune_match_cache(&connection, "s1").unwrap();
        assert_eq!(cached_binding_count(&connection), MATCH_CACHE_LIMIT);
        let oldest = connection
            .query_row(
                "SELECT COUNT(*) FROM recommendation_matches WHERE netease_song_id=?1",
                params!["x0"],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(oldest, 0);
        let newest = connection
            .query_row(
                "SELECT COUNT(*) FROM recommendation_matches WHERE netease_song_id=?1",
                params![format!("x{}", MATCH_CACHE_LIMIT + 4)],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(newest, 1);
    }

    #[test]
    fn a_song_still_in_the_list_refreshes_its_cached_timestamp() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        upsert(
            &mut connection,
            "s1",
            "2026-11-23",
            100,
            None,
            &[song("a", "A")],
        )
        .unwrap();
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "a",
            &binding("BV1"),
            BindMode::Automatic,
            0,
            "token",
            110,
        )
        .unwrap();
        // The same song is still recommended the next day.
        upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            500,
            None,
            &[song("a", "A")],
        )
        .unwrap();

        let cached: i64 = connection
            .query_row(
                "SELECT matched_at FROM recommendation_matches
                 WHERE source_id='s1' AND netease_song_id='a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cached, 500);
        // The row keeps the time it was first matched, not the last refresh.
        let day = snapshot(&connection, "s1", "2026-11-24").unwrap().unwrap();
        assert_eq!(day.songs[0].matched_at, Some(110));
    }

    #[test]
    fn the_cache_cap_evicts_songs_that_left_the_list_before_ones_still_listed() {
        let mut connection = database();
        insert_source(&mut connection, &source("s1", "42", "token")).unwrap();
        let mut listed: Vec<NewRecommendationSong> = (0..MATCH_CACHE_LIMIT)
            .map(|index| song(&format!("x{index}"), "Old"))
            .collect();
        listed.push(song("keep", "Keep"));
        upsert(&mut connection, "s1", "2026-11-23", 100, None, &listed).unwrap();
        for index in 0..MATCH_CACHE_LIMIT {
            connection
                .execute(
                    "INSERT INTO recommendation_matches
                     (source_id, netease_song_id, track_id, bvid, cid, track_json,
                      match_mode, matched_at)
                     VALUES ('s1', ?1, ?1, ?1, 1, '{}', 'automatic', ?2)",
                    params![format!("x{index}"), 1000 + index],
                )
                .unwrap();
        }
        // 「keep」 was matched first, long before every other binding.
        bind(
            &mut connection,
            "s1",
            "2026-11-23",
            "keep",
            &binding("BVkeep"),
            BindMode::Automatic,
            0,
            "token",
            1,
        )
        .unwrap();

        // Only 「keep」 is still recommended the next day.
        upsert(
            &mut connection,
            "s1",
            "2026-11-24",
            5000,
            None,
            &[song("keep", "Keep")],
        )
        .unwrap();

        assert_eq!(cached_binding_count(&connection), MATCH_CACHE_LIMIT);
        let kept: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM recommendation_matches WHERE netease_song_id='keep'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1);
        let evicted: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM recommendation_matches WHERE netease_song_id='x0'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(evicted, 0);
    }

    fn cached_binding_count(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT COUNT(*) FROM recommendation_matches", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
}
