//! Local WebDAV admission, shared across BiliMusic profiles and DAV directories.
//! Only a hash of the server/login is stored; passwords and remote paths never are.
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

const WINDOW: u64 = 30 * 60 * 1000;
#[cfg(test)]
const TEST_WINDOW_CAPACITY: usize = 120;
// Smooth short bursts without turning first connection into a long artificial wait.
const PACE: u64 = 250;
static ROOT: OnceLock<PathBuf> = OnceLock::new();
tokio::task_local! { static OVERRIDE: Arc<Budget>; }

pub fn initialize(root: &Path) {
    let _ = ROOT.set(root.to_owned());
}
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    requests: Vec<u64>,
    limited_until: u64,
    strikes: u32,
    last_limit: u64,
    #[serde(default)]
    pace_ms: u64,
}
#[derive(Clone)]
pub struct Budget {
    file: PathBuf,
    key: String,
    #[cfg(test)]
    test_limit: Option<usize>,
    pace: u64,
}
impl Budget {
    fn new(root: &Path, identity: &str) -> Self {
        Self {
            file: root.join("sync-request-budget.sqlite3"),
            key: super::causal::hash(identity.as_bytes()),
            #[cfg(test)]
            test_limit: None,
            pace: PACE,
        }
    }
    #[cfg(test)]
    pub(super) fn testing(root: &Path, remaining: usize) -> Self {
        let mut b = Self::new(root, "synthetic-login");
        b.pace = 0;
        b.test_limit = Some(TEST_WINDOW_CAPACITY);
        let now = super::scheduler::wall();
        for _ in remaining..TEST_WINDOW_CAPACITY {
            b.reserve(now).unwrap().unwrap();
        }
        b
    }
    #[cfg(test)]
    pub(super) fn elapse_window(&self) {
        self.transaction(|s| {
            s.requests.clear();
            s.limited_until = 0;
        })
        .unwrap();
    }
    fn transaction<T>(&self, f: impl FnOnce(&mut Saved) -> T) -> Result<T, String> {
        let mut c = Connection::open(&self.file).map_err(|_| "无法打开同步请求预算")?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "同步请求预算正忙")?;
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS budget(identity TEXT PRIMARY KEY,json TEXT NOT NULL);",
        )
        .map_err(|_| "无法初始化同步请求预算")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "无法保护同步请求预算")?;
        }
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "同步请求预算正忙")?;
        use rusqlite::OptionalExtension;
        let json: Option<String> = tx
            .query_row(
                "SELECT json FROM budget WHERE identity=?1",
                [&self.key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "无法读取同步请求预算")?;
        let mut state = match json {
            Some(s) => serde_json::from_str(&s).map_err(|_| "同步请求预算损坏，已暂停请求")?,
            None => Saved::default(),
        };
        let result = f(&mut state);
        tx.execute("INSERT INTO budget VALUES(?1,?2) ON CONFLICT(identity) DO UPDATE SET json=excluded.json",params![self.key,serde_json::to_string(&state).map_err(|_| "无法编码同步请求预算")?]).map_err(|_| "无法保存同步请求预算")?;
        tx.commit().map_err(|_| "无法保存同步请求预算")?;
        Ok(result)
    }
    /// No permit is consumed for a denied or paced request. Reserve before sending,
    /// so cancellation/process death can overcount one request but never undercount it.
    fn reserve(&self, now: u64) -> Result<Result<(), (u64, bool)>, String> {
        self.transaction(|s| {
            s.requests.retain(|t| now.saturating_sub(*t) < WINDOW);
            if now < s.limited_until {
                return Err((s.limited_until - now, false));
            }
            #[cfg(test)]
            if self
                .test_limit
                .is_some_and(|limit| s.requests.len() >= limit)
            {
                return Err((
                    s.requests[0]
                        .saturating_add(WINDOW)
                        .saturating_sub(now)
                        .max(1000),
                    false,
                ));
            }
            // Server feedback controls pressure; there is no fixed per-install quota.
            // After each quiet five minutes reduce the learned interval toward normal.
            let quiet = now.saturating_sub(s.limited_until) / 300_000;
            let pace = self
                .pace
                .max(s.pace_ms.checked_shr(quiet.min(63) as u32).unwrap_or(0));
            if let Some(last) = s.requests.last() {
                let wait = last.saturating_add(pace).saturating_sub(now);
                if wait > 0 {
                    return Err((wait.min(pace), true));
                }
            }
            // Keep only the latest admission in production. Tests can inject a
            // finite window to exercise interruption at every protocol boundary.
            #[cfg(not(test))]
            s.requests.clear();
            s.requests.push(now);
            Ok(())
        })
    }
    pub async fn admit(&self) -> Result<(), String> {
        loop {
            match self.reserve(super::scheduler::wall())? {
                Ok(()) => return Ok(()),
                Err((delay, true)) => {
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await
                }
                Err((delay, false)) => {
                    super::traffic::deferred(delay);
                    return Err(format!(
                        "坚果云同步请求正在等待额度，约 {} 分钟后自动继续",
                        delay.div_ceil(60_000).max(1)
                    ));
                }
            }
        }
    }
    pub fn response(&self, status: u16, retry_after: Option<u64>) -> Result<(), String> {
        if !matches!(status, 429 | 503) {
            return Ok(());
        }
        // Positive jitter also applies to Retry-After: never resume before the
        // server's deadline, and avoid devices retrying in the same instant.
        let base = retry_after.unwrap_or(300_000);
        let jitter = uuid::Uuid::new_v4().as_u128() as u64 % (base / 10 + 1);
        let delay = self.cooldown(super::scheduler::wall(), retry_after, jitter)?;
        super::traffic::deferred(delay);
        Ok(())
    }
    fn cooldown(&self, now: u64, retry_after: Option<u64>, jitter: u64) -> Result<u64, String> {
        self.transaction(|s| {
            if now.saturating_sub(s.last_limit) > 2 * WINDOW {
                s.strikes = 0
            }
            s.strikes = s.strikes.saturating_add(1);
            s.last_limit = now;
            s.pace_ms = PACE.saturating_mul(1 << s.strikes.min(4)).min(4000);
            let fallback =
                (300_000u64.saturating_mul(1 << s.strikes.saturating_sub(1).min(3))).min(WINDOW);
            let delay = retry_after
                .unwrap_or(fallback)
                .max(60_000)
                .saturating_add(jitter)
                .min(86_400_000);
            s.limited_until = s.limited_until.max(now.saturating_add(delay));
            s.limited_until.saturating_sub(now)
        })
    }
}
fn login_identity(url: &str, username: &str) -> Result<Option<String>, String> {
    let parsed = url::Url::parse(url).map_err(|_| "同步服务器地址无效")?;
    if parsed.host_str() != Some("dav.jianguoyun.com") {
        return Ok(None);
    }
    Ok(Some(format!(
        "{}:{}",
        parsed.origin().ascii_serialization(),
        username.trim().to_lowercase()
    )))
}
pub fn for_login(url: &str, username: &str) -> Result<Option<Budget>, String> {
    if let Ok(b) = OVERRIDE.try_with(|b| b.as_ref().clone()) {
        return Ok(Some(b));
    }
    let Some(identity) = login_identity(url, username)? else {
        return Ok(None);
    };
    let root = ROOT.get().ok_or("同步请求预算尚未初始化")?;
    Ok(Some(Budget::new(root, &identity)))
}
pub fn for_request(request: &reqwest::Request) -> Result<Option<Budget>, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let username = request
        .headers()
        .get(reqwest::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|v| STANDARD.decode(v).ok())
        .and_then(|v| String::from_utf8(v).ok())
        .and_then(|v| v.split_once(':').map(|(u, _)| u.to_owned()))
        .unwrap_or_default();
    for_login(request.url().as_str(), &username)
}
#[cfg(test)]
pub async fn scoped<T>(budget: Arc<Budget>, future: impl std::future::Future<Output = T>) -> T {
    OVERRIDE.scope(budget, future).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(limit: usize) -> (PathBuf, Budget) {
        let root = std::env::temp_dir().join(format!("dav-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut b = Budget::new(&root, "synthetic-login");
        b.test_limit = Some(limit);
        b.pace = 0;
        (root, b)
    }
    #[test]
    fn sliding_window_restart_and_cooldown_are_persistent() {
        let (dir, b) = fixture(3);
        for n in 0..3 {
            assert!(b.reserve(n).unwrap().is_ok())
        }
        let reopened = Budget::new(&dir, "synthetic-login");
        let reopened = Budget {
            test_limit: Some(3),
            pace: 0,
            ..reopened
        };
        assert!(reopened.reserve(3).unwrap().is_err());
        assert!(reopened.reserve(WINDOW).unwrap().is_ok());
        assert_eq!(b.cooldown(WINDOW + 1, None, 0).unwrap(), 300_000);
        assert!(reopened.reserve(WINDOW + 2).unwrap().is_err());
        assert_eq!(b.cooldown(WINDOW + 3, None, 0).unwrap(), 600_000);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn independent_logins_do_not_share_limits_and_clock_rewind_is_conservative() {
        let (dir, b) = fixture(1);
        assert!(b.reserve(100).unwrap().is_ok());
        assert!(b.reserve(50).unwrap().is_err());
        let other = Budget::new(&dir, "another-login");
        assert!(other.reserve(100).unwrap().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn a_503_without_retry_after_stops_further_http_in_the_same_exchange() {
        let (dir, b) = fixture(120);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let router = axum::Router::new().fallback(move || {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { (axum::http::StatusCode::SERVICE_UNAVAILABLE, "limited") }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/dav", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        scoped(Arc::new(b), async {
            assert_eq!(
                super::super::traffic::send(reqwest::Client::new().get(&url))
                    .await
                    .unwrap()
                    .status()
                    .as_u16(),
                503
            );
            for _ in 0..10 {
                assert!(
                    super::super::traffic::send(reqwest::Client::new().get(&url))
                        .await
                        .is_err()
                )
            }
        })
        .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        server.abort();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_reservations_cannot_overspend_and_restart_keeps_denials() {
        let (dir, b) = fixture(11);
        let allowed = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..24)
                .map(|_| {
                    let b = &b;
                    scope.spawn(move || b.reserve(100).unwrap().is_ok())
                })
                .collect();
            workers
                .into_iter()
                .map(|w| usize::from(w.join().unwrap()))
                .sum::<usize>()
        });
        assert_eq!(allowed, 11);
        let reopened = Budget {
            test_limit: Some(11),
            pace: 0,
            ..Budget::new(&dir, "synthetic-login")
        };
        assert!(reopened.reserve(101).unwrap().is_err());
        assert!(reopened.reserve(WINDOW + 100).unwrap().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn production_has_no_fixed_window_cap_and_learns_from_server_pressure() {
        let (dir, _) = fixture(1);
        let b = Budget {
            pace: 0,
            ..Budget::new(&dir, "synthetic-login")
        };
        // More than the former 120 requests are allowed without server feedback.
        for n in 0..700 {
            assert!(b.reserve(n).unwrap().is_ok());
        }
        assert_eq!(b.cooldown(1000, Some(60_000), 0).unwrap(), 60_000);
        assert_eq!(b.reserve(60_999).unwrap(), Err((1, false)));
        assert!(b.reserve(61_000).unwrap().is_ok());
        assert_eq!(b.reserve(61_001).unwrap(), Err((499, true)));
        let reopened = Budget::new(&dir, "synthetic-login");
        assert_eq!(reopened.reserve(61_002).unwrap(), Err((498, true)));
        // Healthy intervals gradually restore the normal 250 ms pacing.
        assert!(reopened.reserve(361_000).unwrap().is_ok());
        assert_eq!(reopened.reserve(361_001).unwrap(), Err((249, true)));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn retry_after_and_pacing_never_spend_a_denied_permit() {
        let (dir, mut b) = fixture(2);
        b.pace = 1500;
        assert!(b.reserve(100).unwrap().is_ok());
        assert_eq!(b.reserve(101).unwrap(), Err((1499, true)));
        assert!(b.reserve(1600).unwrap().is_ok());
        assert_eq!(b.cooldown(2000, Some(900_000), 3000).unwrap(), 903_000);
        assert!(b.reserve(904_999).unwrap().is_err());
        assert!(b.reserve(WINDOW + 1600).unwrap().is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn quota_identity_follows_dav_login_instead_of_profiles_or_paths() {
        let a = login_identity("https://dav.jianguoyun.com/dav/one/", "Email@Example.com").unwrap();
        let b = login_identity(
            "https://dav.jianguoyun.com/dav/another/42/",
            " email@example.com ",
        )
        .unwrap();
        assert_eq!(a, b);
        assert_ne!(
            a,
            login_identity("https://dav.jianguoyun.com/dav/one/", "other@example.com").unwrap()
        );
        assert!(
            login_identity("https://example.com/dav/", "email@example.com")
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn failed_connection_consumes_one_permit_but_denied_retry_does_not_send() {
        let (dir, b) = fixture(1);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/dav/", listener.local_addr().unwrap());
        drop(listener);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (_, usage) = super::super::traffic::capture(scoped(Arc::new(b), async {
            let failed = super::super::traffic::send(client.get(&url))
                .await
                .unwrap_err();
            assert!(failed.is_connect());
            let denied = super::super::traffic::send(client.get(&url))
                .await
                .unwrap_err();
            assert!(matches!(
                denied,
                super::super::traffic::RequestError::Deferred(_)
            ));
        }))
        .await;
        assert_eq!(usage.requests, 1);
        assert_eq!(usage.failed_requests, 1);
        assert!(usage.retry_after_ms > 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
