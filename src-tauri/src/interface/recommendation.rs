//! Device-scoped recommendation commands.
//!
//! These commands intentionally do not require a Bilibili `account_session`:
//! recommendation sources belong to the device, not to the active Bilibili
//! profile. Every write instead carries the source's random credential token
//! and a per-row revision so a late or duplicate response cannot overwrite a
//! newer login or a manual match.
use super::error::CommandError;
use crate::infrastructure::providers::netease::{NeteaseError, NeteaseProvider, QrPoll};
use crate::infrastructure::recommendation_store::{
    self, BindMode, NewRecommendationSong, NewSource, RecommendationBinding,
    RecommendationDatabase, RecommendationSnapshotRecord, RecommendationSongRecord,
    RecommendationSourceRecord, RecommendationStoreError,
};
use serde::Serialize;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const MAX_SOURCE_NAME: usize = 40;

pub struct RecommendationState {
    database: Result<RecommendationDatabase, String>,
    provider: Result<NeteaseProvider, String>,
}

impl RecommendationState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        Self {
            database: RecommendationDatabase::open(app).map_err(|error| error.to_string()),
            provider: NeteaseProvider::new().map_err(|error| error.to_string()),
        }
    }

    fn database(&self) -> Result<&RecommendationDatabase, CommandError> {
        self.database
            .as_ref()
            .map_err(|_| CommandError::recommendation_unavailable())
    }

    fn provider(&self) -> Result<&NeteaseProvider, CommandError> {
        self.provider
            .as_ref()
            .map_err(|_| CommandError::netease_unavailable())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrGenerateResponse {
    pub attempt_id: String,
    pub qr_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrPollResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RecommendationSourceRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationRefreshResponse {
    pub snapshot: Option<RecommendationSnapshotRecord>,
    pub needs_confirmation: bool,
}

#[tauri::command]
pub async fn netease_qr_login_generate(
    state: State<'_, RecommendationState>,
    terms_accepted: bool,
) -> Result<QrGenerateResponse, CommandError> {
    require_terms(terms_accepted)?;
    let (attempt_id, qr_url) = state
        .provider()?
        .generate_qr()
        .await
        .map_err(CommandError::netease)?;
    Ok(QrGenerateResponse { attempt_id, qr_url })
}

#[tauri::command]
pub async fn netease_qr_login_poll(
    state: State<'_, RecommendationState>,
    attempt_id: String,
    terms_accepted: bool,
) -> Result<QrPollResponse, CommandError> {
    require_terms(terms_accepted)?;
    let poll = state
        .provider()?
        .poll_qr(&attempt_id)
        .await
        .map_err(CommandError::netease)?;
    match poll {
        QrPoll::Waiting => Ok(QrPollResponse {
            status: "waiting",
            source: None,
        }),
        QrPoll::Scanned => Ok(QrPollResponse {
            status: "scanned",
            source: None,
        }),
        QrPoll::Expired => Ok(QrPollResponse {
            status: "expired",
            source: None,
        }),
        QrPoll::Authorized {
            music_u,
            csrf,
            profile,
        } => {
            let database = state.database()?;
            let mut connection = database.lock().map_err(CommandError::recommendation)?;
            let now = now_millis();
            let token = uuid::Uuid::new_v4().simple().to_string();
            let source = create_or_update_source(
                &mut connection,
                &music_u,
                &csrf,
                &token,
                &profile.user_id,
                &profile.nickname,
                now,
            )?;
            Ok(QrPollResponse {
                status: "authorized",
                source: Some(source),
            })
        }
    }
}

#[tauri::command]
pub async fn netease_qr_login_cancel(
    state: State<'_, RecommendationState>,
    attempt_id: String,
) -> Result<(), CommandError> {
    state.provider()?.cancel_qr(&attempt_id).await;
    Ok(())
}

#[tauri::command]
pub fn recommendation_sources(
    state: State<'_, RecommendationState>,
) -> Result<Vec<RecommendationSourceRecord>, CommandError> {
    let database = state.database()?;
    let connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::list_sources(&connection).map_err(CommandError::recommendation)
}

#[tauri::command]
pub fn recommendation_daily(
    state: State<'_, RecommendationState>,
    source_id: String,
    day: String,
) -> Result<Option<RecommendationSnapshotRecord>, CommandError> {
    validate_day(&day)?;
    let database = state.database()?;
    let connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::snapshot(&connection, &source_id, &day)
        .map_err(CommandError::recommendation)
}

#[tauri::command]
pub async fn recommendation_refresh(
    state: State<'_, RecommendationState>,
    source_id: String,
    day: String,
    expected_token: String,
    confirm_empty: Option<bool>,
) -> Result<RecommendationRefreshResponse, CommandError> {
    validate_day(&day)?;
    let (music_u, csrf, existing) = {
        let database = state.database()?;
        let connection = database.lock().map_err(CommandError::recommendation)?;
        let (source, music_u, csrf) =
            recommendation_store::source_credentials(&connection, &source_id)
                .map_err(CommandError::recommendation)?
                .ok_or_else(|| CommandError::recommendation_not_found())?;
        if source.credential_token != expected_token {
            return Err(CommandError::recommendation_source_changed());
        }
        // Overlapping refreshes could each land an upsert and the later answer
        // would delete manual bindings made from the earlier one.
        if !recommendation_store::begin_refresh(
            &connection,
            &source_id,
            &expected_token,
            now_millis(),
        )
        .map_err(CommandError::recommendation)?
        {
            return Err(CommandError::recommendation_refresh_busy());
        }
        let existing = recommendation_store::snapshot(&connection, &source_id, &day)
            .map_err(CommandError::recommendation)?;
        (music_u, csrf, existing)
    };

    let provider = match state.provider() {
        Ok(provider) => provider,
        Err(error) => {
            release_refresh(state.inner(), &source_id, &expected_token);
            return Err(error);
        }
    };
    let songs = match provider.daily_songs(&music_u, &csrf).await {
        Ok(songs) => songs,
        Err(error) => {
            record_refresh_failure(state.inner(), &source_id, &expected_token, &error);
            return Err(CommandError::netease(error));
        }
    };

    let existing_count = existing.as_ref().map(|item| item.song_count).unwrap_or(0);
    if songs.is_empty() && existing_count > 0 && !confirm_empty.unwrap_or(false) {
        let database = state.database()?;
        let connection = database.lock().map_err(CommandError::recommendation)?;
        recommendation_store::set_refresh_state(
            &connection,
            &source_id,
            &expected_token,
            "idle",
            None,
            None,
            now_millis(),
        )
        .map_err(CommandError::recommendation)?;
        return Ok(RecommendationRefreshResponse {
            snapshot: existing,
            needs_confirmation: true,
        });
    }

    let rows: Vec<NewRecommendationSong> = songs
        .into_iter()
        .map(|song| NewRecommendationSong {
            netease_song_id: song.id,
            title: song.title,
            artists: song.artists,
            album: song.album,
            duration_seconds: song.duration_seconds,
            cover_url: song.cover_url,
        })
        .collect();

    let database = state.database()?;
    let mut connection = database.lock().map_err(CommandError::recommendation)?;
    let current = recommendation_store::get_source(&connection, &source_id)
        .map_err(|error| CommandError::recommendation(error.into()))?
        .ok_or_else(CommandError::recommendation_not_found)?;
    if current.credential_token != expected_token {
        // A re-login already reset the source to `idle`; releasing with the
        // current token keeps the lease from covering the new session.
        let _ = recommendation_store::set_refresh_state(
            &connection,
            &source_id,
            &current.credential_token,
            "idle",
            None,
            None,
            now_millis(),
        );
        return Err(CommandError::recommendation_source_changed());
    }
    let now = now_millis();
    let snapshot = match recommendation_store::upsert_day(
        &mut connection,
        &source_id,
        &day,
        now,
        None,
        &rows,
        &expected_token,
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            drop(connection);
            release_refresh(state.inner(), &source_id, &expected_token);
            return Err(CommandError::recommendation(error));
        }
    };
    recommendation_store::set_refresh_state(
        &connection,
        &source_id,
        &expected_token,
        "ready",
        None,
        None,
        now,
    )
    .map_err(CommandError::recommendation)?;
    let _ = recommendation_store::prune_fetched_before(
        &connection,
        &source_id,
        now - 7 * 24 * 60 * 60 * 1000,
    );
    Ok(RecommendationRefreshResponse {
        snapshot: Some(snapshot),
        needs_confirmation: false,
    })
}

#[tauri::command]
pub async fn recommendation_bind(
    state: State<'_, RecommendationState>,
    source_id: String,
    day: String,
    song_id: String,
    track: Value,
    expected_entry_revision: i64,
    expected_token: String,
) -> Result<RecommendationSongRecord, CommandError> {
    bind_song(
        state.inner(),
        &source_id,
        &day,
        &song_id,
        track,
        expected_entry_revision,
        &expected_token,
        BindMode::Automatic,
    )
}

#[tauri::command]
pub async fn recommendation_bind_manual(
    state: State<'_, RecommendationState>,
    source_id: String,
    day: String,
    song_id: String,
    track: Value,
    expected_entry_revision: i64,
    expected_token: String,
) -> Result<RecommendationSongRecord, CommandError> {
    bind_song(
        state.inner(),
        &source_id,
        &day,
        &song_id,
        track,
        expected_entry_revision,
        &expected_token,
        BindMode::Manual,
    )
}

#[allow(clippy::too_many_arguments)]
fn bind_song(
    state: &RecommendationState,
    source_id: &str,
    day: &str,
    song_id: &str,
    track: Value,
    expected_entry_revision: i64,
    expected_token: &str,
    mode: BindMode,
) -> Result<RecommendationSongRecord, CommandError> {
    validate_day(day)?;
    let binding = binding_from_track(track)?;
    let database = state.database()?;
    let mut connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::bind(
        &mut connection,
        source_id,
        day,
        song_id,
        &binding,
        mode,
        expected_entry_revision,
        expected_token,
        now_millis(),
    )
    .map_err(CommandError::recommendation)
}

#[tauri::command]
pub fn recommendation_match_fail(
    state: State<'_, RecommendationState>,
    source_id: String,
    day: String,
    song_id: String,
    match_state: String,
    error_code: Option<String>,
    retry_at: Option<i64>,
    expected_entry_revision: i64,
    expected_token: String,
) -> Result<RecommendationSongRecord, CommandError> {
    validate_day(&day)?;
    let database = state.database()?;
    let mut connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::mark_match_failed(
        &mut connection,
        &source_id,
        &day,
        &song_id,
        &match_state,
        error_code.as_deref(),
        retry_at,
        expected_entry_revision,
        &expected_token,
    )
    .map_err(CommandError::recommendation)
}

#[tauri::command]
pub fn recommendation_match_reset(
    state: State<'_, RecommendationState>,
    source_id: String,
    day: String,
    expected_token: String,
) -> Result<usize, CommandError> {
    validate_day(&day)?;
    let database = state.database()?;
    let connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::reset_matches(&connection, &source_id, &day, &expected_token)
        .map_err(CommandError::recommendation)
}

#[tauri::command]
pub fn recommendation_source_rename(
    state: State<'_, RecommendationState>,
    source_id: String,
    name: String,
    expected_revision: i64,
) -> Result<RecommendationSourceRecord, CommandError> {
    let name = validate_source_name(&name)?;
    let database = state.database()?;
    let connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::rename_source(
        &connection,
        &source_id,
        &name,
        expected_revision,
        now_millis(),
    )
    .map_err(CommandError::recommendation)
}

#[tauri::command]
pub fn recommendation_source_remove(
    state: State<'_, RecommendationState>,
    source_id: String,
    expected_revision: i64,
) -> Result<(), CommandError> {
    let database = state.database()?;
    let connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::remove_source(&connection, &source_id, expected_revision)
        .map_err(CommandError::recommendation)
}

#[tauri::command]
pub fn recommendation_clear_all(
    state: State<'_, RecommendationState>,
) -> Result<usize, CommandError> {
    let database = state.database()?;
    let connection = database.lock().map_err(CommandError::recommendation)?;
    recommendation_store::clear_all(&connection)
        .map_err(|error| CommandError::recommendation(error.into()))
}

fn require_terms(accepted: bool) -> Result<(), CommandError> {
    if accepted {
        Ok(())
    } else {
        Err(CommandError::validation(
            "请先阅读并确认网易云登录的风险说明",
        ))
    }
}

fn create_or_update_source(
    connection: &mut rusqlite::Connection,
    music_u: &str,
    csrf: &str,
    token: &str,
    provider_uid: &str,
    nickname: &str,
    now: i64,
) -> Result<RecommendationSourceRecord, CommandError> {
    let default_name = default_source_name(nickname);
    if let Some(existing) =
        recommendation_store::source_by_provider_uid(connection, "netease", provider_uid)
            .map_err(|error| CommandError::recommendation(error.into()))?
    {
        return recommendation_store::update_credentials(
            connection,
            &existing.id,
            nickname,
            &default_name,
            music_u,
            csrf,
            token,
            now,
        )
        .map_err(CommandError::recommendation);
    }
    let id = format!("netease-{}", uuid::Uuid::new_v4().simple());
    match recommendation_store::insert_source(
        connection,
        &NewSource {
            id: &id,
            provider: "netease",
            provider_uid,
            nickname,
            name: &default_name,
            cookie: music_u,
            csrf,
            credential_token: token,
            terms_accepted_at: Some(now),
            now,
        },
    ) {
        Ok(source) => Ok(source),
        Err(RecommendationStoreError::DuplicateSource) => {
            let existing =
                recommendation_store::source_by_provider_uid(connection, "netease", provider_uid)
                    .map_err(|error| CommandError::recommendation(error.into()))?
                    .ok_or_else(CommandError::recommendation_not_found)?;
            recommendation_store::update_credentials(
                connection,
                &existing.id,
                nickname,
                &default_name,
                music_u,
                csrf,
                token,
                now,
            )
            .map_err(CommandError::recommendation)
        }
        Err(error) => Err(CommandError::recommendation(error)),
    }
}

/// Best-effort release of the refresh lease for paths that end without a
/// terminal refresh state.
fn release_refresh(state: &RecommendationState, source_id: &str, expected_token: &str) {
    let Ok(database) = state.database() else {
        return;
    };
    let Ok(connection) = database.lock() else {
        return;
    };
    let _ = recommendation_store::set_refresh_state(
        &connection,
        source_id,
        expected_token,
        "idle",
        None,
        None,
        now_millis(),
    );
}

/// Source state persisted when a daily refresh fails. Pure so the mapping the
/// frontend branches on is covered without a database or network.
fn refresh_failure_state(
    error: &NeteaseError,
) -> (&'static str, Option<&'static str>, Option<u64>) {
    match error {
        NeteaseError::AuthRequired => ("auth-required", Some("netease_auth_required"), None),
        // The credentials are intact, but the account needs a user action in
        // the NetEase app; flag it like a login problem so the source is fixed
        // by re-authenticating instead of retrying the daily request.
        NeteaseError::VerificationRequired => {
            ("auth-required", Some("netease_verification_required"), None)
        }
        NeteaseError::RateLimited { retry_at } => {
            ("error", Some("netease_rate_limited"), *retry_at)
        }
        NeteaseError::RiskBlocked => ("error", Some("netease_risk_blocked"), None),
        NeteaseError::Protocol => ("error", Some("netease_protocol_error"), None),
        NeteaseError::AccountMismatch => ("error", Some("netease_account_mismatch"), None),
        NeteaseError::Network(_) | NeteaseError::Unavailable => {
            ("error", Some("netease_unavailable"), None)
        }
        // Not expected from the daily endpoint, but never leave the lease held.
        NeteaseError::QrUnknown => ("idle", None, None),
    }
}

fn record_refresh_failure(
    state: &RecommendationState,
    source_id: &str,
    expected_token: &str,
    error: &NeteaseError,
) {
    let (refresh_state, code, retry_at) = refresh_failure_state(error);
    let Ok(database) = state.database() else {
        return;
    };
    let Ok(connection) = database.lock() else {
        return;
    };
    let _ = recommendation_store::set_refresh_state(
        &connection,
        source_id,
        expected_token,
        refresh_state,
        code,
        retry_at.map(|value| value as i64),
        now_millis(),
    );
}

fn default_source_name(nickname: &str) -> String {
    let nickname = nickname.trim();
    if nickname.is_empty() {
        "网易云音乐".into()
    } else {
        format!("网易云音乐 · {nickname}")
    }
}

fn validate_source_name(name: &str) -> Result<String, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::validation("推荐源名称不能为空"));
    }
    if name.chars().count() > MAX_SOURCE_NAME {
        return Err(CommandError::validation(format!(
            "推荐源名称不能超过 {MAX_SOURCE_NAME} 个字符"
        )));
    }
    if name.chars().any(char::is_control) {
        return Err(CommandError::validation("推荐源名称不能包含控制字符"));
    }
    Ok(name.to_owned())
}

fn validate_day(day: &str) -> Result<(), CommandError> {
    let valid = day.len() == 10
        && day.as_bytes().iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !valid {
        return Err(CommandError::validation("推荐日期格式无效"));
    }
    let month: u32 = day[5..7].parse().unwrap_or(0);
    let date: u32 = day[8..10].parse().unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&date) {
        return Err(CommandError::validation("推荐日期格式无效"));
    }
    Ok(())
}

fn binding_from_track(track: Value) -> Result<RecommendationBinding, CommandError> {
    let track_id = track["id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandError::validation("B 站视频信息不完整"))?
        .to_owned();
    let source = &track["source"];
    if source["provider"].as_str() != Some("bilibili") {
        return Err(CommandError::validation("只能绑定 B 站视频"));
    }
    let bvid = source["bvid"]
        .as_str()
        .filter(|value| valid_bvid(value))
        .ok_or_else(|| CommandError::validation("B 站 BV 号无效"))?
        .to_owned();
    let cid = source["cid"]
        .as_i64()
        .filter(|value| *value > 0)
        .ok_or_else(|| CommandError::validation("B 站分 P 无效"))?;
    Ok(RecommendationBinding {
        track_id,
        bvid,
        cid,
        track,
    })
}

fn valid_bvid(bvid: &str) -> bool {
    bvid.len() == 12
        && bvid.starts_with("BV")
        && bvid[2..].bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recommendation_id_starts_with_a_bucket_and_is_not_a_timestamp() {
        assert!(validate_day("2026-11-24").is_ok());
        for invalid in ["2026-1-1", "2026-13-01", "2026-00-10", "abcd-ef-gh", ""] {
            assert!(validate_day(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn source_names_are_trimmed_and_bounded() {
        assert_eq!(validate_source_name("  我的推荐  ").unwrap(), "我的推荐");
        assert!(validate_source_name("   ").is_err());
        assert!(validate_source_name(&"名".repeat(41)).is_err());
        assert!(validate_source_name("坏\u{0000}名").is_err());
    }

    #[test]
    fn binding_requires_a_real_bilibili_track_and_valid_cid() {
        let valid = json!({
            "id": "bilibili:BV1xx411c7mD:1",
            "source": {"provider": "bilibili", "bvid": "BV1xx411c7mD", "cid": 1, "page": 1}
        });
        let binding = binding_from_track(valid).unwrap();
        assert_eq!(binding.track_id, "bilibili:BV1xx411c7mD:1");
        assert_eq!(binding.bvid, "BV1xx411c7mD");
        assert_eq!(binding.cid, 1);

        for invalid in [
            json!({"id": "x", "source": {"provider": "bilibili", "bvid": "BVbad", "cid": 1}}),
            json!({"id": "x", "source": {"provider": "netease", "bvid": "BV1xx411c7mD", "cid": 1}}),
            json!({"id": "x", "source": {"provider": "bilibili", "bvid": "BV1xx411c7mD", "cid": 0}}),
            json!({"source": {"provider": "bilibili", "bvid": "BV1xx411c7mD", "cid": 1}}),
        ] {
            assert!(binding_from_track(invalid).is_err());
        }
    }

    #[test]
    fn bvid_shape_matches_bilibili_identifiers() {
        assert!(valid_bvid("BV1xx411c7mD"));
        assert!(!valid_bvid("av123"));
        assert!(!valid_bvid("BV1xx411c7m"));
        assert!(!valid_bvid("BV1xx411c7mD-"));
    }

    #[test]
    fn default_source_name_follows_the_nickname() {
        assert_eq!(default_source_name("小明"), "网易云音乐 · 小明");
        assert_eq!(default_source_name("  "), "网易云音乐");
    }

    #[test]
    fn a_safety_gate_is_persisted_as_a_login_problem_not_a_retry() {
        // The frontend shows the source banner and skips automatic refresh on
        // "auth-required", and matches this exact error code for the copy.
        assert_eq!(
            refresh_failure_state(&NeteaseError::VerificationRequired),
            ("auth-required", Some("netease_verification_required"), None)
        );
        // Transient failures stay in "error" so the next attempt is allowed.
        assert_eq!(
            refresh_failure_state(&NeteaseError::Unavailable),
            ("error", Some("netease_unavailable"), None)
        );
    }
}
