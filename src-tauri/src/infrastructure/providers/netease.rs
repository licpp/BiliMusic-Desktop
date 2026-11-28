//! Authenticated NetEase Cloud Music adapter for the daily recommendation
//! source. This provider only reads account metadata and the daily song list;
//! it never requests audio, lyrics or membership content.
//!
//! The public web endpoints used here are unofficial and may change. A failed
//! protocol returns a typed error so the caller can stop instead of silently
//! retrying a different, unreviewed path.
use futures_util::StreamExt;
use reqwest::{
    Client, Response,
    header::{HeaderMap, RETRY_AFTER, SET_COOKIE},
    redirect::Policy,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::sync::Mutex;

const MAX_BODY: usize = 2 * 1024 * 1024;
const QR_TTL: Duration = Duration::from_secs(300);
const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Error)]
pub enum NeteaseError {
    #[error("网易云连接失败，请稍后重试")]
    Network(#[from] reqwest::Error),
    #[error("网易云服务暂时不可用，请稍后重试")]
    Unavailable,
    #[error("网易云登录状态未知，请重新生成二维码")]
    QrUnknown,
    #[error("网易云登录已失效，请重新登录")]
    AuthRequired,
    #[error("网易云请求过于频繁，请稍后重试")]
    RateLimited { retry_at: Option<u64> },
    #[error("网易云触发了风控验证，请稍后再试")]
    RiskBlocked,
    #[error("网易云要求在官方登录页完成安全验证")]
    VerificationRequired,
    #[error("网易云返回了无法识别的数据，请稍后重试")]
    Protocol,
    #[error("网易云账号信息不完整，请重新登录")]
    AccountMismatch,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseProfile {
    pub user_id: String,
    pub nickname: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeteaseSong {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration_seconds: Option<f64>,
    pub cover_url: Option<String>,
}

#[derive(Debug)]
pub enum QrPoll {
    Waiting,
    Scanned,
    Expired,
    Authorized {
        music_u: String,
        csrf: String,
        profile: NeteaseProfile,
    },
}

struct QrAttempt {
    unikey: String,
    created: Instant,
}

pub struct NeteaseProvider {
    client: Client,
    origin: String,
    attempts: Mutex<HashMap<String, QrAttempt>>,
    next_attempt: AtomicU64,
}

impl NeteaseProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        Self::with_origin("https://music.163.com")
    }

    pub fn with_origin(origin: &str) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .redirect(Policy::none())
                .user_agent(DESKTOP_UA)
                .build()?,
            origin: origin.trim_end_matches('/').to_owned(),
            attempts: Mutex::new(HashMap::new()),
            next_attempt: AtomicU64::new(1),
        })
    }

    /// Returns the opaque attempt id and the URL that should be rendered as a
    /// QR code. The unikey itself never leaves the backend.
    pub async fn generate_qr(&self) -> Result<(String, String), NeteaseError> {
        let (data, _) = self
            .send(
                self.client
                    .post(format!("{}/api/login/qrcode/unikey", self.origin))
                    .form(&[("type", "3")]),
                None,
                "qr-generate",
            )
            .await?;
        check_code(&data)?;
        let unikey = data["unikey"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or(NeteaseError::Protocol)?
            .to_owned();
        let attempt = format!(
            "netease-{}-{}",
            now_millis(),
            self.next_attempt.fetch_add(1, Ordering::Relaxed)
        );
        self.attempts.lock().await.insert(
            attempt.clone(),
            QrAttempt {
                unikey: unikey.clone(),
                created: Instant::now(),
            },
        );
        Ok((
            attempt,
            format!("https://music.163.com/login?codekey={unikey}"),
        ))
    }

    pub async fn poll_qr(&self, attempt_id: &str) -> Result<QrPoll, NeteaseError> {
        let unikey = {
            let mut attempts = self.attempts.lock().await;
            let Some(attempt) = attempts.get(attempt_id) else {
                return Err(NeteaseError::QrUnknown);
            };
            if attempt.created.elapsed() > QR_TTL {
                attempts.remove(attempt_id);
                return Ok(QrPoll::Expired);
            }
            attempt.unikey.clone()
        };
        let (data, cookies) = self
            .send(
                self.client
                    .post(format!("{}/api/login/qrcode/client/login", self.origin))
                    .form(&[("key", unikey.as_str()), ("type", "3")]),
                None,
                "qr-poll",
            )
            .await?;
        let code = data["code"].as_i64().unwrap_or(0);
        let music_u = cookie_from(&data, "MUSIC_U").or_else(|| header_cookie(&cookies, "MUSIC_U"));
        match code {
            800 => {
                self.attempts.lock().await.remove(attempt_id);
                Ok(QrPoll::Expired)
            }
            801 => Ok(QrPoll::Waiting),
            802 => Ok(QrPoll::Scanned),
            803 => {
                let music_u = music_u.ok_or(NeteaseError::Protocol)?;
                let csrf = cookie_from(&data, "__csrf")
                    .or_else(|| header_cookie(&cookies, "__csrf"))
                    .unwrap_or_default();
                // Profile is fallible and may be retried; keep the attempt until
                // it succeeds so a transient failure does not force a new scan.
                let profile = self.profile(&music_u, &csrf).await?;
                // Claim the attempt only now: a cancel during either request wins,
                // and two concurrent polls cannot both create a source.
                if self.attempts.lock().await.remove(attempt_id).is_none() {
                    return Err(NeteaseError::QrUnknown);
                }
                Ok(QrPoll::Authorized {
                    music_u,
                    csrf,
                    profile,
                })
            }
            _ => {
                eprintln!("[netease] stage=qr-poll status=200 code={code}");
                Err(map_code(&data))
            }
        }
    }

    pub async fn cancel_qr(&self, attempt_id: &str) {
        self.attempts.lock().await.remove(attempt_id);
    }

    pub async fn profile(&self, music_u: &str, csrf: &str) -> Result<NeteaseProfile, NeteaseError> {
        let (data, _) = self
            .send(
                self.client
                    .get(format!("{}/api/nuser/account/get", self.origin))
                    .header("Cookie", cookie_header(music_u, csrf)),
                Some((music_u, csrf)),
                "profile",
            )
            .await?;
        check_code(&data)?;
        let profile = &data["profile"];
        let user_id = profile["userId"]
            .as_i64()
            .map(|value| value.to_string())
            .or_else(|| profile["userId"].as_str().map(str::to_owned))
            .filter(|value| !value.is_empty())
            .ok_or(NeteaseError::AuthRequired)?;
        let nickname = profile["nickname"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(NeteaseError::AccountMismatch)?
            .to_owned();
        Ok(NeteaseProfile { user_id, nickname })
    }

    pub async fn daily_songs(
        &self,
        music_u: &str,
        csrf: &str,
    ) -> Result<Vec<NeteaseSong>, NeteaseError> {
        let (data, _) = self
            .send(
                self.client
                    .post(format!("{}/api/v3/discovery/recommend/songs", self.origin))
                    .header("Cookie", cookie_header(music_u, csrf))
                    .header("Referer", "https://music.163.com/")
                    .header("Origin", "https://music.163.com")
                    .form(&[
                        ("csrf_token", csrf),
                        ("limit", "30"),
                        ("offset", "0"),
                        ("total", "true"),
                        ("n", "1000"),
                    ]),
                Some((music_u, csrf)),
                "daily",
            )
            .await?;
        check_code(&data)?;
        let rows = data["data"]["dailySongs"]
            .as_array()
            .or_else(|| data["data"]["recommend"].as_array())
            .or_else(|| data["recommend"].as_array())
            .or_else(|| data["dailySongs"].as_array())
            .ok_or(NeteaseError::Protocol)?;
        Ok(rows.iter().filter_map(song_from).take(500).collect())
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        cookies: Option<(&str, &str)>,
        stage: &'static str,
    ) -> Result<(Value, Vec<String>), NeteaseError> {
        let mut request = request
            .header("Accept", "application/json")
            .header("Referer", "https://music.163.com/");
        if let Some((music_u, csrf)) = cookies {
            request = request.header("Cookie", cookie_header(music_u, csrf));
        }
        let response = request.send().await?;
        let status = response.status();
        let headers = response.headers().clone();
        if status.as_u16() == 429 {
            eprintln!("[netease] stage={stage} status=429");
            return Err(NeteaseError::RateLimited {
                retry_at: retry_at(&headers),
            });
        }
        if status.as_u16() == 403 {
            eprintln!("[netease] stage={stage} status=403");
            return Err(NeteaseError::RiskBlocked);
        }
        let data = limited_json(response).await?;
        let code = data["code"].as_i64().unwrap_or(0);
        if !status.is_success() {
            // Status and business code are safe to log; the body may contain
            // account data, so it is never printed.
            eprintln!(
                "[netease] stage={stage} status={} code={}",
                status.as_u16(),
                code
            );
            return Err(match status.as_u16() {
                401 => NeteaseError::AuthRequired,
                500..=599 => NeteaseError::Unavailable,
                _ => map_code(&data),
            });
        }
        if code != 200 && stage != "qr-poll" {
            // An unexpected business code usually means the endpoint changed
            // or the account hit a gate; the caller maps it to a user error.
            eprintln!("[netease] stage={stage} status=200 code={code}");
        }
        Ok((data, header_cookies(&headers)))
    }
}

fn check_code(data: &Value) -> Result<(), NeteaseError> {
    match data["code"].as_i64() {
        Some(200) => Ok(()),
        Some(301 | -101) => Err(NeteaseError::AuthRequired),
        Some(-460) => Err(NeteaseError::RiskBlocked),
        // 8821 is the account-safety gate the login endpoints return instead of
        // a protocol failure; it needs a user action, not a retry.
        Some(8821) => Err(NeteaseError::VerificationRequired),
        Some(400) => Err(NeteaseError::Protocol),
        _ => Ok(()),
    }
}

fn map_code(data: &Value) -> NeteaseError {
    match data["code"].as_i64() {
        Some(301 | -101) => NeteaseError::AuthRequired,
        Some(-460) => NeteaseError::RiskBlocked,
        Some(8821) => NeteaseError::VerificationRequired,
        Some(code) if code >= 500 => NeteaseError::Unavailable,
        _ => NeteaseError::Protocol,
    }
}

async fn limited_json(response: Response) -> Result<Value, NeteaseError> {
    if response.content_length().unwrap_or(0) > MAX_BODY as u64 {
        return Err(NeteaseError::Protocol);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > MAX_BODY {
            return Err(NeteaseError::Protocol);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| NeteaseError::Protocol)
}

fn cookie_header(music_u: &str, csrf: &str) -> String {
    if csrf.is_empty() {
        format!("MUSIC_U={music_u}")
    } else {
        format!("MUSIC_U={music_u}; __csrf={csrf}")
    }
}

fn header_cookies(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_owned)
        .collect()
}

fn header_cookie(cookies: &[String], name: &str) -> Option<String> {
    cookies.iter().find_map(|cookie| cookie_value(cookie, name))
}

fn cookie_from(data: &Value, name: &str) -> Option<String> {
    let cookie = data["cookie"].as_str()?;
    cookie
        .split(';')
        .find_map(|part| cookie_value(part.trim(), name))
}

fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    let (key, value) = cookie.split_once('=')?;
    // A Set-Cookie header carries attributes after the value (`; Path=/;
    // HttpOnly`). Only the first segment belongs to the cookie itself.
    let value = value.split(';').next().unwrap_or_default().trim();
    (key.trim() == name && !value.is_empty()).then(|| value.to_owned())
}

fn retry_at(headers: &HeaderMap) -> Option<u64> {
    let seconds = headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(now_millis().saturating_add(seconds.saturating_mul(1000)))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

fn song_from(value: &Value) -> Option<NeteaseSong> {
    let id = value["id"]
        .as_i64()
        .map(|id| id.to_string())
        .or_else(|| value["id"].as_str().map(str::to_owned))
        .filter(|id| !id.is_empty())?;
    let title = value["name"]
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())?
        .to_owned();
    let artists = value["ar"]
        .as_array()
        .or_else(|| value["artists"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|artist| artist["name"].as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect();
    let album = if value["al"].is_object() {
        &value["al"]
    } else {
        &value["album"]
    };
    Some(NeteaseSong {
        id,
        title,
        artists,
        album: album["name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
        duration_seconds: value["dt"]
            .as_f64()
            .or_else(|| value["duration"].as_f64())
            .map(|milliseconds| milliseconds / 1000.0)
            .filter(|seconds| *seconds > 0.0),
        cover_url: album["picUrl"]
            .as_str()
            .map(|url| url.replacen("http://", "https://", 1))
            .filter(|url| !url.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct ServerState {
        polls: Arc<AtomicUsize>,
    }

    async fn start_server() -> (String, ServerState, tokio::task::JoinHandle<()>) {
        let state = ServerState {
            polls: Arc::new(AtomicUsize::new(0)),
        };
        let app = Router::new()
            .route(
                "/api/login/qrcode/unikey",
                post(|| async { axum::Json(serde_json::json!({"code": 200, "unikey": "KEY"})) }),
            )
            .route(
                "/api/login/qrcode/client/login",
                post(|State(state): State<ServerState>| async move {
                    let count = state.polls.fetch_add(1, Ordering::SeqCst);
                    if count == 0 {
                        axum::Json(serde_json::json!({"code": 801})).into_response()
                    } else {
                        (
                            StatusCode::OK,
                            [
                                ("set-cookie", "MUSIC_U=music-u; Path=/; HttpOnly"),
                                ("set-cookie", "__csrf=csrf-token; Path=/"),
                            ],
                            axum::Json(serde_json::json!({"code": 803, "cookie": "MUSIC_U=music-u; __csrf=csrf-token"})),
                        )
                            .into_response()
                    }
                }),
            )
            .route(
                "/api/nuser/account/get",
                get(|headers: HeaderMap| async move {
                    let cookie = headers
                        .get("cookie")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default();
                    if !cookie.contains("MUSIC_U=music-u") {
                        return (
                            StatusCode::UNAUTHORIZED,
                            axum::Json(serde_json::json!({"code": 301})),
                        )
                            .into_response();
                    }
                    axum::Json(serde_json::json!({
                        "code": 200,
                        "profile": {"userId": 42, "nickname": "小明"}
                    }))
                    .into_response()
                }),
            )
            .route(
                "/api/v3/discovery/recommend/songs",
                post(|headers: HeaderMap| async move {
                    if !headers
                        .get("cookie")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .contains("__csrf=csrf-token")
                    {
                        return (
                            StatusCode::UNAUTHORIZED,
                            axum::Json(serde_json::json!({"code": 301})),
                        )
                            .into_response();
                    }
                    axum::Json(serde_json::json!({
                        "code": 200,
                        "data": {"dailySongs": [
                            {"id": 1, "name": "第一首", "ar": [{"name": "甲"}, {"name": "乙"}],
                             "al": {"name": "专辑", "picUrl": "http://p1.music.126.net/a.jpg"}, "dt": 185000},
                            {"id": 2, "name": "第二首", "artists": [{"name": "丙"}],
                             "album": {"name": "", "picUrl": ""}, "duration": 240000}
                        ]}
                    }))
                    .into_response()
                }),
            )
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), state, server)
    }

    #[tokio::test]
    async fn qr_login_extracts_cookies_and_profile() {
        let (origin, state, server) = start_server().await;
        let provider = NeteaseProvider::with_origin(&origin).unwrap();
        let (attempt, url) = provider.generate_qr().await.unwrap();
        assert!(url.contains("codekey=KEY"));
        assert!(matches!(
            provider.poll_qr(&attempt).await.unwrap(),
            QrPoll::Waiting
        ));
        let QrPoll::Authorized {
            music_u,
            csrf,
            profile,
        } = provider.poll_qr(&attempt).await.unwrap()
        else {
            panic!("expected authorization");
        };
        assert_eq!(music_u, "music-u");
        assert_eq!(csrf, "csrf-token");
        assert_eq!(profile.user_id, "42");
        assert_eq!(profile.nickname, "小明");
        assert_eq!(state.polls.load(Ordering::SeqCst), 2);
        assert!(matches!(
            provider.poll_qr(&attempt).await,
            Err(NeteaseError::QrUnknown)
        ));
        let songs = provider.daily_songs(&music_u, &csrf).await.unwrap();
        assert_eq!(songs.len(), 2);
        assert_eq!(songs[0].title, "第一首");
        assert_eq!(songs[0].artists, vec!["甲", "乙"]);
        assert_eq!(songs[0].album.as_deref(), Some("专辑"));
        assert_eq!(songs[0].duration_seconds, Some(185.0));
        assert_eq!(
            songs[0].cover_url.as_deref(),
            Some("https://p1.music.126.net/a.jpg")
        );
        assert_eq!(songs[1].duration_seconds, Some(240.0));
        assert_eq!(songs[1].album, None);
        server.abort();
    }

    #[tokio::test]
    async fn an_unknown_attempt_does_not_call_the_upstream() {
        let provider = NeteaseProvider::with_origin("http://127.0.0.1:1").unwrap();
        assert!(matches!(
            provider.poll_qr("missing").await,
            Err(NeteaseError::QrUnknown)
        ));
    }

    #[test]
    fn cookie_values_are_parsed_from_body_and_set_cookie() {
        assert_eq!(
            cookie_from(
                &serde_json::json!({"cookie": "MUSIC_U=u; __csrf=c"}),
                "MUSIC_U"
            )
            .as_deref(),
            Some("u")
        );
        let headers = vec!["MUSIC_U=u; Path=/; HttpOnly".to_owned()];
        assert_eq!(header_cookie(&headers, "MUSIC_U").as_deref(), Some("u"));
        assert_eq!(header_cookie(&headers, "__csrf"), None);
    }

    #[test]
    fn song_parsing_ignores_incomplete_rows_and_keeps_artists() {
        assert!(song_from(&serde_json::json!({"id": 1})).is_none());
        assert!(song_from(&serde_json::json!({"id": 1, "name": " "})).is_none());
        let song = song_from(&serde_json::json!({
            "id": "9", "name": "歌", "artists": [{"name": "甲"}],
            "album": {"name": "专辑", "picUrl": "http://x/y.jpg"}, "duration": 1000
        }))
        .unwrap();
        assert_eq!(song.id, "9");
        assert_eq!(song.artists, vec!["甲"]);
        assert_eq!(song.cover_url.as_deref(), Some("https://x/y.jpg"));
        assert_eq!(song.duration_seconds, Some(1.0));
    }

    #[tokio::test]
    async fn a_safety_verification_gate_is_not_reported_as_an_outage() {
        let app = Router::new()
            .route(
                "/api/login/qrcode/unikey",
                post(|| async { axum::Json(serde_json::json!({"code": 200, "unikey": "KEY"})) }),
            )
            .route(
                "/api/login/qrcode/client/login",
                post(|| async {
                    axum::Json(serde_json::json!({"code": 8821, "message": "需要安全验证"}))
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = NeteaseProvider::with_origin(&format!("http://{address}")).unwrap();
        let (attempt, _) = provider.generate_qr().await.unwrap();
        // 8821 arrives over HTTP 200 and must reach the user as a verification
        // gate instead of a retryable "service unavailable" outage.
        assert!(matches!(
            provider.poll_qr(&attempt).await,
            Err(NeteaseError::VerificationRequired)
        ));
        server.abort();
    }

    #[test]
    fn business_codes_map_to_actionable_errors() {
        assert!(matches!(
            map_code(&serde_json::json!({"code": 301})),
            NeteaseError::AuthRequired
        ));
        assert!(matches!(
            map_code(&serde_json::json!({"code": -101})),
            NeteaseError::AuthRequired
        ));
        assert!(matches!(
            map_code(&serde_json::json!({"code": -460})),
            NeteaseError::RiskBlocked
        ));
        assert!(matches!(
            map_code(&serde_json::json!({"code": 8821})),
            NeteaseError::VerificationRequired
        ));
        assert!(matches!(
            map_code(&serde_json::json!({"code": 502})),
            NeteaseError::Unavailable
        ));
        assert!(matches!(
            map_code(&serde_json::json!({"code": 400})),
            NeteaseError::Protocol
        ));
        assert!(matches!(
            check_code(&serde_json::json!({"code": 8821})),
            Err(NeteaseError::VerificationRequired)
        ));
    }

    #[tokio::test]
    #[ignore = "requires live NetEase network access"]
    async fn live_qr_login_reaches_the_waiting_state() {
        let provider = NeteaseProvider::new().unwrap();
        let (attempt, url) = provider.generate_qr().await.unwrap();
        assert!(url.contains("codekey="));
        assert!(matches!(
            provider.poll_qr(&attempt).await.unwrap(),
            QrPoll::Waiting | QrPoll::Scanned
        ));
        provider.cancel_qr(&attempt).await;
    }

    #[tokio::test]
    #[ignore = "requires BILIMUSIC_NETEASE_MUSIC_U and BILIMUSIC_NETEASE_CSRF from a disposable account"]
    async fn live_daily_recommendation_returns_songs() {
        let music_u = std::env::var("BILIMUSIC_NETEASE_MUSIC_U")
            .expect("set BILIMUSIC_NETEASE_MUSIC_U to run this live check");
        let csrf = std::env::var("BILIMUSIC_NETEASE_CSRF").unwrap_or_default();
        let provider = NeteaseProvider::new().unwrap();
        let profile = provider.profile(&music_u, &csrf).await.unwrap();
        assert!(!profile.nickname.trim().is_empty());
        let songs = provider.daily_songs(&music_u, &csrf).await.unwrap();
        assert!(!songs.is_empty());
        assert!(
            songs
                .iter()
                .all(|song| !song.id.is_empty() && !song.title.trim().is_empty())
        );
    }
}
