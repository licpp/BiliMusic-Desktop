//! Device-scoped recommendation commands.
//!
//! These commands intentionally do not require a Bilibili `account_session`:
//! recommendation sources belong to the device, not to the active Bilibili
//! profile. Every write instead carries the source's random credential token
//! and a per-row revision so a late or duplicate response cannot overwrite a
//! newer login or a manual match.
use super::error::CommandError;
use crate::infrastructure::database::Database;
use crate::infrastructure::providers::netease::{NeteaseError, NeteaseProvider, QrPoll};
use crate::infrastructure::recommendation_store::{
    self, BindMode, NewRecommendationSong, NewSource, RecommendationBinding,
    RecommendationDatabase, RecommendationSnapshotRecord, RecommendationSongRecord,
    RecommendationSourceRecord, RecommendationStoreError,
};
use crate::infrastructure::repositories::{
    library::{LibraryRepository, MetadataPatch, TrackInput, TrackRecord},
    lyrics::{LyricsRepository, SaveLyricsInput, StoredLyrics},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, State};

const MAX_SOURCE_NAME: usize = 40;
const NETEASE_LOGIN_LABEL: &str = "netease-login";
const NETEASE_LOGIN_URL: &str = "https://music.163.com/#/login";
const NETEASE_LOGIN_COOKIE_URL: &str = "https://music.163.com/";
const NETEASE_LOGIN_POLL: Duration = Duration::from_millis(500);
#[cfg(target_os = "android")]
const NETEASE_LOGIN_PROFILE_RETRY: Duration = Duration::from_secs(3);
const NETEASE_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// Centres the QR code in the login view. Re-evaluated on every poll because
/// the page renders its login box asynchronously; the script is idempotent and
/// ignores anything outside a 163.com document.
#[cfg(any(desktop, target_os = "android"))]
const NETEASE_LOGIN_FOCUS_SCRIPT: &str = include_str!("netease_login_focus.js");
/// Android reuses the main webview, so the first ticks after `navigate` still
/// report the app URL. The login page counts as unreachable only after this.
#[cfg(any(target_os = "android", test))]
const NETEASE_LOGIN_NAVIGATION_GRACE: Duration = Duration::from_secs(30);

#[derive(Default)]
struct WebLoginSlot {
    active: bool,
    cancelled: bool,
}

pub struct RecommendationState {
    database: Result<RecommendationDatabase, String>,
    provider: Result<NeteaseProvider, String>,
    web_login: Mutex<WebLoginSlot>,
    /// Where the Android login leaves its result for the page it reloads.
    web_login_outcome: Mutex<Option<WebLoginOutcome>>,
}

impl RecommendationState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        Self {
            database: RecommendationDatabase::open(app).map_err(|error| error.to_string()),
            provider: NeteaseProvider::new().map_err(|error| error.to_string()),
            web_login: Mutex::new(WebLoginSlot::default()),
            web_login_outcome: Mutex::new(None),
        }
    }

    fn set_web_login_outcome(&self, outcome: WebLoginOutcome) {
        *self
            .web_login_outcome
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(outcome);
    }

    fn take_web_login_outcome(&self) -> Option<WebLoginOutcome> {
        self.web_login_outcome
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
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

    fn web_login_slot(&self) -> std::sync::MutexGuard<'_, WebLoginSlot> {
        // A panic in an unrelated command must not disable login permanently.
        self.web_login
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// One embedded login at a time: two windows would share the cookie store
    /// and the second one could capture the first attempt's session. The slot
    /// is guarded by a mutex so `begin` and `cancel` cannot interleave and
    /// lose a cancellation that arrives while the window is being created.
    fn begin_web_login(&self) -> bool {
        let mut slot = self.web_login_slot();
        if slot.active {
            return false;
        }
        slot.active = true;
        slot.cancelled = false;
        true
    }

    fn finish_web_login(&self) {
        let mut slot = self.web_login_slot();
        slot.active = false;
        slot.cancelled = false;
    }

    fn cancel_web_login(&self) {
        let mut slot = self.web_login_slot();
        if slot.active {
            slot.cancelled = true;
        }
    }

    fn web_login_cancelled(&self) -> bool {
        self.web_login_slot().cancelled
    }
}

struct WebLoginGuard<'a>(&'a RecommendationState);

impl Drop for WebLoginGuard<'_> {
    fn drop(&mut self) {
        self.0.finish_web_login();
    }
}

/// What the app page learns about the login that reloaded it. The Android
/// login replaces the app page, so the command's return value reaches a
/// document that no longer exists; the outcome waits here instead and the
/// reloaded page asks for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLoginOutcome {
    /// Wall clock at the end of the attempt, so the page can tell its own
    /// attempt's result from one left behind by an earlier attempt.
    pub finished_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RecommendationSourceRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WebLoginOutcomeError>,
}

/// `CommandError` is handed to the frontend by value and is not shared, so the
/// fields the UI reads are copied out of it. `message` is already sanitized:
/// it never carries the token, the nickname or a raw URL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLoginOutcomeError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl From<&CommandError> for WebLoginOutcomeError {
    fn from(error: &CommandError) -> Self {
        Self {
            code: error.code,
            message: error.message.clone(),
            retryable: error.retryable,
        }
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

/// Opens the official NetEase login page in an isolated webview and waits for
/// the session cookie. This is the desktop path: the QR endpoint rejects the
/// client with business code 8821 on some networks, while a real browser
/// session works for the account and daily-recommendation endpoints.
///
/// Android has its own main-webview fallback for QR login failures.
#[cfg(desktop)]
#[tauri::command]
pub async fn netease_web_login(
    app: tauri::AppHandle,
    state: State<'_, RecommendationState>,
    terms_accepted: bool,
) -> Result<RecommendationSourceRecord, CommandError> {
    require_terms(terms_accepted)?;
    let provider = state.provider()?;
    if !state.begin_web_login() {
        return Err(CommandError::netease_login_in_progress());
    }
    let _guard = WebLoginGuard(state.inner());

    let login_url = NETEASE_LOGIN_URL
        .parse::<tauri::Url>()
        .map_err(CommandError::netease_login_window)?;
    let cookie_url = NETEASE_LOGIN_COOKIE_URL
        .parse::<tauri::Url>()
        .map_err(CommandError::netease_login_window)?;
    if let Some(stale) = app.get_webview_window(NETEASE_LOGIN_LABEL) {
        let _ = stale.close();
    }
    // Incognito keeps the session out of the app's persistent WebView profile
    // so the Bilibili login stored there can never be read or deleted by the
    // cleanup below.
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        NETEASE_LOGIN_LABEL,
        tauri::WebviewUrl::External(login_url),
    )
    .title("登录网易云音乐")
    .inner_size(460.0, 720.0)
    .min_inner_size(360.0, 560.0)
    .center()
    .incognito(true)
    .on_navigation(is_netease_url)
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .build()
    .map_err(CommandError::netease_login_window)?;

    let deadline = Instant::now() + NETEASE_LOGIN_TIMEOUT;
    loop {
        if state.web_login_cancelled() {
            let _ = window.close();
            return Err(CommandError::netease_login_cancelled());
        }
        // The user may close the login window instead of using the in-app
        // cancel button; treat that as a cancel rather than waiting out the
        // timeout with an invisible window.
        if app.get_webview_window(NETEASE_LOGIN_LABEL).is_none() {
            return Err(CommandError::netease_login_cancelled());
        }
        // The login box is not guaranteed to be in view (a narrow window also
        // clips it sideways); keep the QR code visible. The script no-ops once
        // the user takes over.
        let _ = window.eval(NETEASE_LOGIN_FOCUS_SCRIPT);
        let cookies = match window.cookies_for_url(cookie_url.clone()) {
            Ok(cookies) => cookies,
            Err(_) => {
                let _ = window.close();
                return Err(CommandError::netease_login_cancelled());
            }
        };
        if let Some((music_u, csrf)) = login_credentials(&cookies) {
            let profile = match provider.profile(&music_u, &csrf).await {
                Ok(profile) => profile,
                Err(error) => {
                    discard_netease_cookies(&window, &cookies);
                    let _ = window.close();
                    return Err(CommandError::netease(error));
                }
            };
            let persisted = if app.get_webview_window(NETEASE_LOGIN_LABEL).is_some() {
                persist_web_login(state.inner(), &music_u, &csrf, &profile)
            } else {
                Err(CommandError::netease_login_cancelled())
            };
            // The credentials now live in the device database; do not leave a
            // second copy in the WebView cookie store. This also runs when the
            // database rejects the write, so a failure cannot strand an open
            // window holding a live session.
            discard_netease_cookies(&window, &cookies);
            let _ = window.close();
            return persisted;
        }
        if Instant::now() >= deadline {
            discard_netease_cookies(&window, &cookies);
            let _ = window.close();
            return Err(CommandError::netease_login_timeout());
        }
        tokio::time::sleep(NETEASE_LOGIN_POLL).await;
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn netease_web_login(
    app: tauri::AppHandle,
    state: State<'_, RecommendationState>,
    terms_accepted: bool,
) -> Result<RecommendationSourceRecord, CommandError> {
    require_terms(terms_accepted)?;
    let provider = state.provider()?;
    if !state.begin_web_login() {
        return Err(CommandError::netease_login_in_progress());
    }
    let _guard = WebLoginGuard(state.inner());
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| CommandError::netease_login_window("找不到主窗口"))?;
    // Android has no second webview, so the app page itself is replaced by the
    // official login page and put back afterwards. The app document reloads on
    // the way back; the frontend warns about the interrupted playback first.
    let app_url = window.url().map_err(CommandError::netease_login_window)?;
    let login_url = NETEASE_LOGIN_URL
        .parse::<tauri::Url>()
        .map_err(CommandError::netease_login_window)?;
    let cookie_url = NETEASE_LOGIN_COOKIE_URL
        .parse::<tauri::Url>()
        .map_err(CommandError::netease_login_window)?;
    // An earlier attempt's session is still in the shared cookie store; wry
    // cannot delete a cookie on Android, so the native side does it here.
    // Whatever survives is an earlier login rather than this one, so its value
    // is never accepted below -- even if the account call would still take it.
    let mut baseline_music_u = stored_music_u(&window, &cookie_url);
    reset_netease_web_session(&app).await;
    if let Some(survivor) = stored_music_u(&window, &cookie_url) {
        login_log("stored session survived the reset");
        baseline_music_u.get_or_insert(survivor);
    }
    window
        .navigate(login_url)
        .map_err(CommandError::netease_login_window)?;
    let started = Instant::now();
    let deadline = started + NETEASE_LOGIN_TIMEOUT;
    let mut reached_login = false;
    // The reset above normally leaves the page signed out; a value the page
    // carries anyway can only be judged by the account call, so remember what
    // it rejected instead of asking again.
    let mut rejected_music_u: Option<String> = None;
    // A failed account call that may pass on its own is not retried on every
    // poll: every 500ms would be two requests per second for minutes.
    let mut profile_retry_at = Instant::now();
    // logcat is the only place this flow can be observed, so it reports state
    // changes rather than one line per poll.
    let mut logged: Option<(bool, Vec<String>)> = None;
    let result = loop {
        if state.web_login_cancelled() {
            break Err(CommandError::netease_login_cancelled());
        }
        let on_login_page = window.url().ok().as_ref().is_some_and(is_netease_url);
        match app_login_tick(on_login_page, reached_login, started.elapsed()) {
            AppLoginTick::OnPage => {
                reached_login = true;
                // Same as the desktop window: the mobile login page also opens
                // with the QR code below the fold.
                let _ = window.eval(NETEASE_LOGIN_FOCUS_SCRIPT);
                let cookies = match window.cookies_for_url(cookie_url.clone()) {
                    Ok(cookies) => cookies,
                    Err(error) => {
                        login_log(format!("cookies error={error}"));
                        Vec::new()
                    }
                };
                let names = cookies
                    .iter()
                    .map(|cookie| cookie.name().to_string())
                    .collect::<Vec<_>>();
                let state_key = (on_login_page, names.clone());
                if logged.as_ref() != Some(&state_key) {
                    let current = window.url().ok().map(|url| url.to_string());
                    login_log(format!(
                        "tick url={current:?} on_login_page={on_login_page} elapsed={:?} cookies={:?}",
                        started.elapsed(),
                        names
                    ));
                    logged = Some(state_key);
                }
                if let Some((music_u, csrf)) =
                    fresh_login_credentials(&cookies, baseline_music_u.as_deref())
                {
                    if rejected_music_u.as_deref() != Some(music_u.as_str())
                        && Instant::now() >= profile_retry_at
                    {
                        match provider.profile(&music_u, &csrf).await {
                            Ok(profile) => {
                                if !window.url().ok().as_ref().is_some_and(is_netease_url) {
                                    break Err(CommandError::netease_login_cancelled());
                                }
                                break persist_web_login(state.inner(), &music_u, &csrf, &profile);
                            }
                            Err(error) => match profile_verdict(&error) {
                                ProfileVerdict::Stale => {
                                    login_log("profile rejected the stored session");
                                    rejected_music_u = Some(music_u);
                                }
                                ProfileVerdict::Transient => {
                                    login_log("profile not reachable, will retry");
                                    profile_retry_at = Instant::now() + NETEASE_LOGIN_PROFILE_RETRY;
                                }
                                ProfileVerdict::Fatal => break Err(CommandError::netease(error)),
                            },
                        }
                    }
                }
            }
            AppLoginTick::Left => break Err(CommandError::netease_login_cancelled()),
            AppLoginTick::NotLoaded => {
                break Err(CommandError::netease_login_window("网易云登录页没有打开"));
            }
            AppLoginTick::Wait => {}
        }
        if Instant::now() >= deadline {
            break Err(CommandError::netease_login_timeout());
        }
        tokio::time::sleep(NETEASE_LOGIN_POLL).await;
    };
    login_log(format!(
        "end ok={} reached={reached_login} elapsed={:?}",
        result.is_ok(),
        started.elapsed()
    ));
    // The reload below destroys the document that called this command, so the
    // result is left where the new document can pick it up.
    state.set_web_login_outcome(WebLoginOutcome {
        finished_at: now_millis(),
        source: result.as_ref().ok().cloned(),
        error: result.as_ref().err().map(WebLoginOutcomeError::from),
    });
    restore_app_page(&window, &app_url).await;
    // As on the desktop path, the credentials now live in the device database;
    // do not leave a second copy in the webview store. Cancelled and timed-out
    // attempts land here too, so a half-finished login never keeps a session.
    reset_netease_web_session(&app).await;
    result
}

/// What ended the last web login, for the app page that the Android login
/// reloads on its way back. Reading consumes it: the page asks once, so a
/// later reload cannot show an earlier attempt's result.
#[tauri::command]
pub fn netease_web_login_outcome(state: State<'_, RecommendationState>) -> Option<WebLoginOutcome> {
    state.take_web_login_outcome()
}

/// Android has no console, and the embedded login is the one flow that cannot
/// be inspected from the UI, so it reports to logcat. Cookie values, the
/// nickname and the user id stay out of the log.
#[cfg(target_os = "android")]
fn login_log(message: impl AsRef<str>) {
    use std::ffi::CString;
    unsafe extern "C" {
        fn __android_log_write(
            priority: i32,
            tag: *const std::os::raw::c_char,
            text: *const std::os::raw::c_char,
        ) -> i32;
    }
    let (Ok(tag), Ok(text)) = (
        CString::new("BiliMusicLogin"),
        CString::new(message.as_ref()),
    ) else {
        return;
    };
    // 4 is ANDROID_LOG_INFO.
    unsafe { __android_log_write(4, tag.as_ptr(), text.as_ptr()) };
}

/// One decision per poll of the Android main-webview login. `navigate` is
/// asynchronous, so the first ticks still report the app URL; leaving the page
/// only counts after the login page was really reached, otherwise every
/// attempt would cancel itself before the page loads.
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppLoginTick {
    OnPage,
    Left,
    NotLoaded,
    Wait,
}

#[cfg(any(target_os = "android", test))]
fn app_login_tick(on_login_page: bool, reached: bool, elapsed: Duration) -> AppLoginTick {
    if on_login_page {
        AppLoginTick::OnPage
    } else if reached {
        AppLoginTick::Left
    } else if elapsed >= NETEASE_LOGIN_NAVIGATION_GRACE {
        AppLoginTick::NotLoaded
    } else {
        AppLoginTick::Wait
    }
}

/// What the login loop does when the account call for a cookie value fails.
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileVerdict {
    /// The session does not authenticate any more: this attempt is not a login,
    /// so ignore that value and keep the login page open for a real one.
    Stale,
    /// May pass on its own; ask again shortly with the same value.
    Transient,
    /// Retrying escalates the restriction or repeats a settled failure.
    Fatal,
}

#[cfg(any(target_os = "android", test))]
fn profile_verdict(error: &NeteaseError) -> ProfileVerdict {
    match error {
        NeteaseError::AuthRequired | NeteaseError::AccountMismatch => ProfileVerdict::Stale,
        NeteaseError::Network(_) | NeteaseError::Unavailable => ProfileVerdict::Transient,
        NeteaseError::QrUnknown
        | NeteaseError::RateLimited { .. }
        | NeteaseError::RiskBlocked
        | NeteaseError::VerificationRequired
        | NeteaseError::Protocol => ProfileVerdict::Fatal,
    }
}

/// iOS and OHOS keep the generated QR code: their webviews cannot return to
/// the app page on their own, so the main-webview login would trap the user.
#[cfg(all(not(desktop), not(target_os = "android")))]
#[tauri::command]
pub async fn netease_web_login(
    terms_accepted: bool,
) -> Result<RecommendationSourceRecord, CommandError> {
    require_terms(terms_accepted)?;
    Err(CommandError::netease_login_window("当前平台请使用扫码登录"))
}

#[tauri::command]
pub fn netease_web_login_cancel(
    app: tauri::AppHandle,
    state: State<'_, RecommendationState>,
) -> Result<(), CommandError> {
    state.cancel_web_login();
    if let Some(window) = app.get_webview_window(NETEASE_LOGIN_LABEL) {
        let _ = window.close();
    }
    Ok(())
}

#[cfg(any(desktop, target_os = "android"))]
fn is_netease_url(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            let host = host.trim_start_matches('.');
            host == "163.com" || host.ends_with(".163.com")
        })
}

#[cfg(any(desktop, target_os = "android"))]
fn login_credentials(
    cookies: &[tauri::webview::cookie::Cookie<'static>],
) -> Option<(String, String)> {
    let mut music_u = None;
    let mut csrf = String::new();
    for cookie in cookies {
        match cookie.name() {
            "MUSIC_U" if !cookie.value().trim().is_empty() => {
                music_u = Some(cookie.value().to_string());
            }
            "__csrf" => csrf = cookie.value().to_string(),
            _ => {}
        }
    }
    music_u.map(|music_u| (music_u, csrf))
}

/// What the shared cookie jar held before this attempt opened the login page.
/// A `MUSIC_U` found there is an earlier session, never a result of this login.
#[cfg(any(target_os = "android", test))]
fn fresh_login_credentials(
    cookies: &[tauri::webview::cookie::Cookie<'static>],
    baseline_music_u: Option<&str>,
) -> Option<(String, String)> {
    login_credentials(cookies).filter(|(music_u, _)| baseline_music_u != Some(music_u.as_str()))
}

/// The `MUSIC_U` the shared webview store holds right now, if any.
#[cfg(target_os = "android")]
fn stored_music_u(window: &tauri::WebviewWindow, cookie_url: &tauri::Url) -> Option<String> {
    window
        .cookies_for_url(cookie_url.clone())
        .ok()
        .and_then(|cookies| login_credentials(&cookies))
        .map(|(music_u, _)| music_u)
}

/// Clears the NetEase session out of the webview the Android login reuses. A
/// failure is reported, not fatal: the baseline check still keeps an old
/// session from being accepted as a fresh login.
#[cfg(target_os = "android")]
async fn reset_netease_web_session(app: &tauri::AppHandle) {
    match tauri_plugin_android_player::clear_netease_web_data(app).await {
        Ok((removed, remaining)) => {
            login_log(format!("reset removed={removed} remaining={remaining}"))
        }
        Err(error) => login_log(format!("reset failed error={error}")),
    }
}

/// Writes the freshly captured session as the device's recommendation source.
/// Both embedded-login paths share it so the token and timestamps are created
/// exactly once per successful login.
#[cfg(any(desktop, target_os = "android"))]
fn persist_web_login(
    state: &RecommendationState,
    music_u: &str,
    csrf: &str,
    profile: &crate::infrastructure::providers::netease::NeteaseProfile,
) -> Result<RecommendationSourceRecord, CommandError> {
    let login = state.web_login_slot();
    if !login.active || login.cancelled {
        return Err(CommandError::netease_login_cancelled());
    }
    let now = now_millis();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let database = state.database()?;
    let mut connection = database.lock().map_err(CommandError::recommendation)?;
    create_or_update_source(
        &mut connection,
        music_u,
        csrf,
        &token,
        &profile.user_id,
        &profile.nickname,
        now,
    )
}

/// Puts the app back on screen after the main webview showed the login page.
/// Navigating is skipped when the page never left, so a failed attempt does
/// not reload the app and drop its in-memory state for nothing.
///
/// `navigate` appends a history entry, and BACK follows that history once the
/// app is back (the activity's back callback in `src-tauri/android/phone/`
/// steps through it), so restoring that way would reopen the login page on the
/// next BACK press. The login page instead steps back to the app page, which is
/// still the first history entry, so the login entry leaves with it; a document
/// that cannot run that script falls back to replacing its own entry with
/// `location.replace`, and the plain navigation covers everything else.
#[cfg(target_os = "android")]
async fn restore_app_page(window: &tauri::WebviewWindow, app_url: &tauri::Url) {
    let current = window.url().ok().map(|url| url.to_string());
    login_log(format!("restore current={current:?} app={app_url}"));
    if window.url().ok().as_ref() == Some(app_url) {
        return;
    }
    if window.url().ok().as_ref().is_some_and(is_netease_url) {
        if window
            .eval("if (history.length > 1) history.go(1 - history.length)")
            .is_ok()
        {
            if wait_for_app_page(window, app_url).await {
                login_log("restore stepped back to the app page");
                return;
            }
            login_log("restore step back did not reach the app page");
        }
        let app = serde_json::to_string(app_url.as_str()).unwrap_or_default();
        if window.url().ok().as_ref().is_some_and(is_netease_url)
            && window
                .eval(format!("window.location.replace({app})"))
                .is_ok()
        {
            if wait_for_app_page(window, app_url).await {
                login_log("restore replaced the login page entry");
                return;
            }
            login_log("restore replace did not navigate");
        }
    }
    login_log("restore navigating back to the app page");
    let _ = window.navigate(app_url.clone());
}

/// The reload takes a moment; the caller needs to know whether it happened.
#[cfg(target_os = "android")]
async fn wait_for_app_page(window: &tauri::WebviewWindow, app_url: &tauri::Url) -> bool {
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if window.url().ok().as_ref() == Some(app_url) {
            return true;
        }
    }
    false
}

#[cfg(desktop)]
fn discard_netease_cookies(
    window: &tauri::WebviewWindow,
    cookies: &[tauri::webview::cookie::Cookie<'static>],
) {
    for cookie in cookies {
        let domain = cookie.domain().unwrap_or_default().trim_start_matches('.');
        if domain == "163.com" || domain.ends_with(".163.com") {
            let _ = window.delete_cookie(cookie.clone());
        }
    }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecommendationBindingRef {
    source_id: String,
    day: String,
    netease_song_id: String,
    entry_revision: i64,
}

#[derive(Deserialize)]
pub struct PrepareRecommendationTrack {
    track: TrackInput,
    reference: RecommendationBindingRef,
}

#[derive(Serialize)]
pub struct PreparedRecommendationTrack {
    track: TrackRecord,
    lyrics: Option<StoredLyrics>,
    changed: bool,
}

/// Materialize the catalog identity before a recommendation enters the player
/// or library. The lyric body is filled by the standard selected-lyrics cache.
#[tauri::command]
pub fn recommendation_prepare_tracks(
    state: State<'_, RecommendationState>,
    library: State<'_, Database>,
    expected_account_session: String,
    bindings: Vec<PrepareRecommendationTrack>,
) -> Result<Vec<PreparedRecommendationTrack>, CommandError> {
    let recommendations = state
        .database()?
        .lock()
        .map_err(CommandError::recommendation)?;
    let mut library = library.0.lock().map_err(CommandError::database)?;
    super::account::check_account_session(&library, &expected_account_session)?;
    let tx = library.transaction().map_err(CommandError::database)?;
    let results = bindings
        .into_iter()
        .map(|binding| prepare_track(&recommendations, &tx, binding))
        .collect::<Result<Vec<_>, _>>()?;
    tx.commit().map_err(CommandError::database)?;
    Ok(results)
}

fn prepare_track(
    recommendations: &rusqlite::Connection,
    library: &rusqlite::Connection,
    binding: PrepareRecommendationTrack,
) -> Result<PreparedRecommendationTrack, CommandError> {
    let PrepareRecommendationTrack { track, reference } = binding;
    super::commands::validate_track(&track)?;
    let song = recommendation_store::get_song(
        recommendations,
        &reference.source_id,
        &reference.day,
        &reference.netease_song_id,
    )
    .map_err(CommandError::database)?
    .filter(|song| {
        song.match_state == "matched"
            && song.entry_revision == reference.entry_revision
            && song.track_id.as_deref() == Some(&track.id)
            && song.bvid.as_deref() == Some(&track.bvid)
            && song.cid == Some(track.cid)
    })
    .ok_or_else(|| CommandError::validation("每日推荐的匹配已更新，请重试"))?;
    apply_song(library, &track, song)
}

fn apply_song(
    library: &rusqlite::Connection,
    input: &TrackInput,
    song: RecommendationSongRecord,
) -> Result<PreparedRecommendationTrack, CommandError> {
    use super::batch_matching::{has_override, protected_lyrics, validate_metadata};

    let id = &input.id;
    let existing = LibraryRepository::get(library, id).map_err(CommandError::database)?;
    let selection = LyricsRepository::get(library, id).map_err(CommandError::database)?;
    if let Some(track) = existing {
        if has_override(library, id).map_err(CommandError::database)?
            || selection.as_ref().is_some_and(protected_lyrics)
        {
            return Ok(PreparedRecommendationTrack {
                track,
                lyrics: None,
                changed: false,
            });
        }
    } else {
        LibraryRepository::upsert_source(library, input).map_err(CommandError::database)?;
    }
    let artists = song
        .artists
        .iter()
        .map(|artist| artist.trim())
        .filter(|artist| !artist.is_empty())
        .collect::<Vec<_>>()
        .join(" / ");
    let metadata = MetadataPatch {
        title: song.title,
        artist: (!artists.is_empty()).then_some(artists),
        album: song.album.filter(|album| !album.trim().is_empty()),
        cover_url: song.cover_url.filter(|cover| !cover.trim().is_empty()),
    };
    validate_metadata(&metadata)?;
    let track = LibraryRepository::update_metadata(library, id, &metadata)
        .map_err(CommandError::database)?;
    let same_recording_length = song.duration_seconds.is_none_or(|length| {
        length <= 0.0
            || track.duration_seconds == 0
            || (length - track.duration_seconds as f64).abs() <= (length * 0.08).max(15.0)
    });
    let has_lyric_id = song.netease_song_id.parse::<i64>().is_ok_and(|id| id > 0);
    let lyrics = if same_recording_length
        && has_lyric_id
        && !selection.as_ref().is_some_and(|lyric| {
            lyric.provider == "netease" && lyric.provider_lyric_id == song.netease_song_id
        }) {
        Some(
            LyricsRepository::save(
                library,
                id,
                &SaveLyricsInput {
                    provider: "netease".into(),
                    provider_lyric_id: song.netease_song_id,
                    raw_text: String::new(),
                    parsed_json: "[]".into(),
                },
                false,
            )
            .map_err(CommandError::database)?,
        )
    } else {
        None
    };
    Ok(PreparedRecommendationTrack {
        track,
        lyrics,
        changed: true,
    })
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
    use rusqlite::Connection;
    use serde_json::json;

    fn matched_song(
        library: &Connection,
        recommendations: &mut Connection,
    ) -> PrepareRecommendationTrack {
        crate::infrastructure::migrations::migrate(library).unwrap();
        recommendation_store::migrate(recommendations).unwrap();
        recommendation_store::insert_source(
            recommendations,
            &NewSource {
                id: "source",
                provider: "netease",
                provider_uid: "1",
                nickname: "测试",
                name: "测试",
                cookie: "test",
                csrf: "",
                credential_token: "token",
                terms_accepted_at: None,
                now: 1,
            },
        )
        .unwrap();
        recommendation_store::upsert_day(
            recommendations,
            "source",
            "2026-11-27",
            1,
            None,
            &[NewRecommendationSong {
                netease_song_id: "42".into(),
                title: "推荐歌名".into(),
                artists: vec!["歌手甲".into(), "歌手乙".into()],
                album: Some("推荐专辑".into()),
                duration_seconds: Some(180.0),
                cover_url: Some("https://example.com/album.jpg".into()),
            }],
            "token",
        )
        .unwrap();
        let track: TrackInput = serde_json::from_value(json!({
            "id": "bilibili:BV1GJ411x7h7:2", "bvid": "BV1GJ411x7h7", "cid": 2, "page": 2,
            "title": "分 P 标题", "sourceTitle": "投稿原名", "durationSeconds": 183
        }))
        .unwrap();
        let bound = recommendation_store::bind(
            recommendations,
            "source",
            "2026-11-27",
            "42",
            &RecommendationBinding {
                track_id: track.id.clone(),
                bvid: track.bvid.clone(),
                cid: track.cid,
                track: json!({}),
            },
            BindMode::Automatic,
            0,
            "token",
            2,
        )
        .unwrap();
        PrepareRecommendationTrack {
            track,
            reference: RecommendationBindingRef {
                source_id: "source".into(),
                day: "2026-11-27".into(),
                netease_song_id: "42".into(),
                entry_revision: bound.entry_revision,
            },
        }
    }

    #[test]
    fn matched_recommendation_prepares_catalog_metadata_and_exact_lyrics_without_changing_video() {
        let library = Connection::open_in_memory().unwrap();
        let mut recommendations = Connection::open_in_memory().unwrap();
        let binding = matched_song(&library, &mut recommendations);
        let result = prepare_track(&recommendations, &library, binding).unwrap();
        assert_eq!(result.track.title, "推荐歌名");
        assert_eq!(result.track.artist.as_deref(), Some("歌手甲 / 歌手乙"));
        assert_eq!(result.track.album.as_deref(), Some("推荐专辑"));
        assert_eq!(
            result.track.cover_url.as_deref(),
            Some("https://example.com/album.jpg")
        );
        assert_eq!(result.track.source_video_title, "投稿原名");
        assert_eq!(result.track.source_display_title, "分 P 标题");
        assert_eq!(result.track.cid, 2);
        assert_eq!(result.track.duration_seconds, 183);
        let selected = result.lyrics.unwrap();
        assert_eq!(
            (&*selected.provider, &*selected.provider_lyric_id),
            ("netease", "42")
        );
        assert!(!selected.selected_manually);
        assert!(selected.raw_text.is_empty());
        assert!(LibraryRepository::recent(&library, 10).unwrap().is_empty());
    }

    #[test]
    fn stale_recommendation_cannot_write_library_information() {
        let library = Connection::open_in_memory().unwrap();
        let mut recommendations = Connection::open_in_memory().unwrap();
        let mut binding = matched_song(&library, &mut recommendations);
        binding.reference.entry_revision -= 1;
        let id = binding.track.id.clone();
        assert!(prepare_track(&recommendations, &library, binding).is_err());
        assert!(LibraryRepository::get(&library, &id).unwrap().is_none());
        assert!(LyricsRepository::get(&library, &id).unwrap().is_none());
    }

    #[test]
    fn recommendation_keeps_manual_selection_and_avoids_a_different_recording_length() {
        for manual in [true, false] {
            let mut library = Connection::open_in_memory().unwrap();
            let mut recommendations = Connection::open_in_memory().unwrap();
            let mut binding = matched_song(&library, &mut recommendations);
            binding.track.duration_seconds = if manual { 183 } else { 55 };
            let id = binding.track.id.clone();
            if manual {
                LibraryRepository::upsert(&mut library, &binding.track).unwrap();
                LyricsRepository::save(
                    &library,
                    &id,
                    &SaveLyricsInput {
                        provider: "local".into(),
                        provider_lyric_id: String::new(),
                        raw_text: "[00:01]自己选的歌词".into(),
                        parsed_json: "[]".into(),
                    },
                    true,
                )
                .unwrap();
            }
            let result = prepare_track(&recommendations, &library, binding).unwrap();
            assert!(result.lyrics.is_none());
            assert_eq!(result.changed, !manual);
            assert_eq!(
                result.track.title,
                if manual {
                    "分 P 标题"
                } else {
                    "推荐歌名"
                }
            );
            let stored = LyricsRepository::get(&library, &id).unwrap();
            assert_eq!(
                stored.as_ref().map(|lyric| lyric.provider.as_str()),
                manual.then_some("local")
            );
        }
    }

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

    #[test]
    fn web_login_navigation_stays_on_netease_https_hosts() {
        for allowed in [
            "https://music.163.com/#/login",
            "https://passport.163.com/login",
            "https://163.com/",
        ] {
            assert!(is_netease_url(&allowed.parse().unwrap()), "{allowed}");
        }
        for denied in [
            "http://music.163.com/",
            "https://music.163.com.evil.example/",
            "https://evil163.com/",
            "https://weixin.qq.com/",
        ] {
            assert!(!is_netease_url(&denied.parse().unwrap()), "{denied}");
        }
    }

    #[test]
    fn app_login_ignores_the_pre_navigation_url_but_detects_leaving_the_page() {
        // `navigate` returns before the page loads, so the tick that runs right
        // after it still reports the app URL; cancelling there would abort
        // every Android login before the login page had a chance to open.
        assert_eq!(
            app_login_tick(false, false, Duration::from_millis(500)),
            AppLoginTick::Wait
        );
        assert_eq!(
            app_login_tick(true, false, Duration::from_millis(500)),
            AppLoginTick::OnPage
        );
        // Once the official page was reached, the back button is a cancel.
        assert_eq!(
            app_login_tick(false, true, Duration::from_secs(20)),
            AppLoginTick::Left
        );
        // A page that never opens fails instead of waiting out the full timeout.
        assert_eq!(
            app_login_tick(false, false, NETEASE_LOGIN_NAVIGATION_GRACE),
            AppLoginTick::NotLoaded
        );
    }

    #[test]
    fn a_rejected_session_keeps_the_login_open_instead_of_failing() {
        // Android's cookie store cannot be cleared and survives attempts, so a
        // cookie left by an earlier login reaches the account call. Its answer
        // decides whether the loop waits for a real login or gives up.
        assert_eq!(
            profile_verdict(&NeteaseError::AuthRequired),
            ProfileVerdict::Stale
        );
        assert_eq!(
            profile_verdict(&NeteaseError::AccountMismatch),
            ProfileVerdict::Stale
        );
        assert_eq!(
            profile_verdict(&NeteaseError::Unavailable),
            ProfileVerdict::Transient
        );
        // Retrying these would deepen the restriction or repeat a settled answer.
        assert_eq!(
            profile_verdict(&NeteaseError::RiskBlocked),
            ProfileVerdict::Fatal
        );
        assert_eq!(
            profile_verdict(&NeteaseError::VerificationRequired),
            ProfileVerdict::Fatal
        );
        assert_eq!(
            profile_verdict(&NeteaseError::Protocol),
            ProfileVerdict::Fatal
        );
    }

    #[test]
    fn web_login_waits_for_music_u_instead_of_any_page_cookie() {
        use tauri::webview::cookie::Cookie;
        let cookies = vec![
            Cookie::new("NMTID", "device"),
            Cookie::new("__csrf", "token"),
            Cookie::new("MUSIC_U", "session"),
        ];
        assert_eq!(
            login_credentials(&cookies),
            Some(("session".to_owned(), "token".to_owned()))
        );
        assert_eq!(login_credentials(&cookies[..2]), None);
        assert_eq!(login_credentials(&[Cookie::new("MUSIC_U", " ")]), None);
    }

    #[test]
    fn a_session_that_was_there_before_the_attempt_is_not_a_login() {
        use tauri::webview::cookie::Cookie;
        // Android's webview keeps its cookies between attempts, so the value
        // still in the jar when the page opens cannot count as a new login --
        // the account call would report the old session as valid.
        let stored = [
            Cookie::new("MUSIC_U", "old"),
            Cookie::new("__csrf", "token"),
        ];
        assert_eq!(fresh_login_credentials(&stored, Some("old")), None);
        // A real login replaces the value; the reset removing it also works.
        assert_eq!(
            fresh_login_credentials(&stored, Some("other")),
            Some(("old".to_owned(), "token".to_owned()))
        );
        assert_eq!(
            fresh_login_credentials(&stored, None),
            Some(("old".to_owned(), "token".to_owned()))
        );
        let now = [Cookie::new("MUSIC_U", "new"), Cookie::new("__csrf", "t2")];
        assert_eq!(
            fresh_login_credentials(&now, Some("old")),
            Some(("new".to_owned(), "t2".to_owned()))
        );
    }
}
