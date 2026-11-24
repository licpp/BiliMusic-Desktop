use super::ProviderError;
use reqwest::{
    StatusCode, Url,
    header::{HeaderMap, RETRY_AFTER},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, SemaphorePermit};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Stage {
    Search,
    Favorites,
    Catalog,
    Comments,
    Playback,
    Account,
}

impl Stage {
    pub(super) fn for_url(url: &Url) -> Self {
        let path = url.path();
        if matches!(url.host_str(), Some("s.search.bilibili.com")) || path.contains("/search") {
            Self::Search
        } else if path.starts_with("/x/v3/fav/") || path.starts_with("/x/relation/") {
            Self::Favorites
        } else if path.starts_with("/x/v2/reply") || path.starts_with("/x/emote/") {
            Self::Comments
        } else if path.contains("/playurl") || path.starts_with("/x/player/wbi/") {
            Self::Playback
        } else if path == "/x/web-interface/nav" || path.starts_with("/x/passport-login/") {
            Self::Account
        } else {
            Self::Catalog
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Favorites => "favorites",
            Self::Catalog => "catalog",
            Self::Comments => "comments",
            Self::Playback => "playback",
            Self::Account => "account",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Priority {
    Foreground,
    Background,
    Resume,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Scope {
    stage: Stage,
    // An absent account is a rate limit of unknown scope. Verification applies
    // to one signed-in account (or UID 0 for the visitor).
    account: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Restriction {
    scope: Scope,
    pub(crate) retry_at: Option<u64>,
    pub(crate) http_status: Option<u16>,
    pub(crate) upstream_code: Option<i64>,
    failures: usize,
}

impl Restriction {
    pub(crate) fn stage(self) -> Stage {
        self.scope.stage
    }

    pub(crate) fn error(self) -> ProviderError {
        if self.scope.account.is_some() {
            ProviderError::VerificationRequired(self)
        } else {
            ProviderError::RateLimited(self)
        }
    }
}

#[derive(Debug)]
struct Hold {
    restriction: Restriction,
    revision: u64,
    until: Option<Instant>,
    probing: bool,
}

impl Hold {
    fn new(restriction: Restriction, revision: u64, delay: Option<Duration>) -> Self {
        Self {
            restriction,
            revision,
            until: delay.and_then(|delay| Instant::now().checked_add(delay)),
            probing: false,
        }
    }

    fn cooling_down(&self) -> bool {
        self.until.is_some_and(|until| Instant::now() < until)
            || self
                .restriction
                .retry_at
                .is_some_and(|until| wall() < until)
    }
}

#[derive(Default)]
struct State {
    revision: u64,
    holds: Vec<Hold>,
}

pub(super) struct Policy {
    state: Mutex<State>,
    persisted: Option<PathBuf>,
    background: Semaphore,
    last_paced: AsyncMutex<Option<Instant>>,
}

static POLICY: OnceLock<Arc<Policy>> = OnceLock::new();

pub(super) fn shared() -> Arc<Policy> {
    POLICY.get_or_init(|| Arc::new(Policy::new(None))).clone()
}

pub(crate) fn initialize(directory: &Path) {
    let _ = POLICY.get_or_init(|| {
        Arc::new(Policy::new(Some(
            directory.join("bilibili-request-holds.json"),
        )))
    });
}

const PACE: Duration = Duration::from_millis(500);
const FALLBACK_SECONDS: [u64; 3] = [120, 300, 600];

fn wall() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

pub(super) fn delay_from_header(headers: &HeaderMap, now: SystemTime) -> Option<Duration> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let time = httpdate::parse_http_date(value).ok()?;
    Some(time.duration_since(now).unwrap_or_default())
}

pub(super) fn is_rate_code(stage: Stage, code: i64) -> bool {
    matches!(code, -352 | -509 | -799)
        || (code == -412 && matches!(stage, Stage::Search | Stage::Favorites | Stage::Catalog))
}

impl Policy {
    pub(super) fn new(persisted: Option<PathBuf>) -> Self {
        let mut state = State::default();
        if let Some(restrictions) = persisted
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<Restriction>>(&bytes).ok())
        {
            let now = wall();
            for restriction in restrictions {
                state.revision += 1;
                let delay = restriction
                    .retry_at
                    .map(|at| Duration::from_millis(at.saturating_sub(now)));
                state
                    .holds
                    .push(Hold::new(restriction, state.revision, delay));
            }
        }
        Self {
            state: Mutex::new(state),
            persisted,
            background: Semaphore::new(1),
            last_paced: AsyncMutex::new(None),
        }
    }

    fn save(&self, state: &State) {
        if let Some(path) = &self.persisted {
            let restrictions: Vec<_> = state.holds.iter().map(|hold| hold.restriction).collect();
            if let Ok(bytes) = serde_json::to_vec(&restrictions) {
                let temporary = path.with_extension("tmp");
                if std::fs::write(&temporary, bytes).is_ok() {
                    let _ = std::fs::rename(temporary, path);
                }
            }
        }
    }

    fn check(
        state: &State,
        stage: Stage,
        account: u64,
        priority: Priority,
        read: bool,
        probes: &[(Scope, u64)],
    ) -> Result<(), ProviderError> {
        for hold in &state.holds {
            let scope = hold.restriction.scope;
            if probes.contains(&(scope, hold.revision)) {
                continue;
            }
            let own = scope.stage == stage && scope.account.is_none_or(|uid| uid == account);
            if own
                && (hold.cooling_down()
                    || hold.probing
                    || priority == Priority::Background
                    || !read)
                || (priority != Priority::Foreground
                    && stage != Stage::Account
                    && scope.account.is_none()
                    && hold.cooling_down())
            {
                return Err(hold.restriction.error());
            }
        }
        Ok(())
    }

    pub(super) fn check_read(
        &self,
        stage: Stage,
        account: u64,
        priority: Priority,
    ) -> Result<(), ProviderError> {
        Self::check(
            &self.state.lock().expect("Bilibili request policy"),
            stage,
            account,
            priority,
            true,
            &[],
        )
    }

    pub(super) async fn acquire(
        &self,
        stage: Stage,
        account: u64,
        priority: Priority,
        read: bool,
    ) -> Result<Lease<'_>, ProviderError> {
        Self::check(
            &self.state.lock().expect("Bilibili request policy"),
            stage,
            account,
            priority,
            read,
            &[],
        )?;
        let background_request = priority != Priority::Foreground && stage != Stage::Account;
        let background = if background_request {
            Some(
                self.background
                    .acquire()
                    .await
                    .expect("background semaphore remains open"),
            )
        } else {
            None
        };
        let mut paced = if read && (background_request || stage == Stage::Favorites) {
            Some(self.last_paced.lock().await)
        } else {
            None
        };
        if let Some(at) = paced.as_ref().and_then(|last| **last) {
            tokio::time::sleep(PACE.saturating_sub(at.elapsed())).await;
        }
        let mut state = self.state.lock().expect("Bilibili request policy");
        Self::check(&state, stage, account, priority, read, &[])?;
        if let Some(last) = paced.as_mut() {
            **last = Some(Instant::now());
        }
        let mut probes = Vec::new();
        for hold in &mut state.holds {
            let scope = hold.restriction.scope;
            if scope.stage == stage && scope.account.is_none_or(|uid| uid == account) {
                hold.probing = true;
                probes.push((scope, hold.revision));
            }
        }
        Ok(Lease {
            policy: self,
            stage,
            account,
            priority,
            read,
            probes,
            _background: background,
        })
    }
}

pub(super) struct Lease<'a> {
    policy: &'a Policy,
    stage: Stage,
    account: u64,
    priority: Priority,
    read: bool,
    probes: Vec<(Scope, u64)>,
    _background: Option<SemaphorePermit<'a>>,
}

impl Lease<'_> {
    pub(super) fn stage(&self) -> Stage {
        self.stage
    }

    pub(super) fn is_probe(&self) -> bool {
        !self.probes.is_empty()
    }

    pub(super) fn validate(&self) -> Result<(), ProviderError> {
        Policy::check(
            &self.policy.state.lock().expect("Bilibili request policy"),
            self.stage,
            self.account,
            self.priority,
            self.read,
            &self.probes,
        )
    }

    pub(super) fn http_restriction(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
    ) -> Option<ProviderError> {
        let delay = delay_from_header(headers, SystemTime::now());
        if matches!(status.as_u16(), 412 | 429)
            || (status == StatusCode::SERVICE_UNAVAILABLE && delay.is_some())
        {
            return Some(self.restrict(false, Some(status.as_u16()), None, delay));
        }
        None
    }

    pub(super) fn restrict(
        &self,
        verification: bool,
        http_status: Option<u16>,
        upstream_code: Option<i64>,
        delay: Option<Duration>,
    ) -> ProviderError {
        let scope = Scope {
            stage: self.stage,
            account: verification.then_some(self.account),
        };
        let mut state = self.policy.state.lock().expect("Bilibili request policy");
        let old = state
            .holds
            .iter()
            .position(|hold| hold.restriction.scope == scope)
            .map(|index| state.holds.remove(index));
        let failures = old
            .as_ref()
            .map_or(0, |hold| {
                hold.restriction
                    .failures
                    .saturating_add(usize::from(!hold.cooling_down()))
            })
            .min(FALLBACK_SECONDS.len() - 1);
        let retry_at = if verification {
            None
        } else {
            let now = wall();
            let delay = delay
                .unwrap_or(Duration::from_secs(FALLBACK_SECONDS[failures]))
                .as_millis()
                .min(u64::MAX as u128) as u64;
            let old_at = old
                .as_ref()
                .and_then(|hold| hold.restriction.retry_at)
                .unwrap_or(0);
            Some(now.saturating_add(delay).max(old_at))
        };
        state.revision += 1;
        let restriction = Restriction {
            scope,
            retry_at,
            http_status,
            upstream_code,
            failures,
        };
        let revision = state.revision;
        state.holds.push(Hold::new(
            restriction,
            revision,
            retry_at.map(|at| Duration::from_millis(at.saturating_sub(wall()))),
        ));
        self.policy.save(&state);
        restriction.error()
    }

    pub(super) fn extend_failed_probe(&self) -> Option<ProviderError> {
        if self.probes.is_empty() {
            return None;
        }
        let mut state = self.policy.state.lock().expect("Bilibili request policy");
        let hold = state.holds.iter_mut().find(|hold| {
            hold.restriction.retry_at.is_some()
                && self
                    .probes
                    .contains(&(hold.restriction.scope, hold.revision))
        })?;
        let failures = (hold.restriction.failures + 1).min(FALLBACK_SECONDS.len() - 1);
        let seconds = FALLBACK_SECONDS[failures];
        hold.restriction.failures = failures;
        hold.restriction.retry_at = Some(wall().saturating_add(seconds * 1000));
        hold.until = Instant::now().checked_add(Duration::from_secs(seconds));
        let error = hold.restriction.error();
        self.policy.save(&state);
        Some(error)
    }

    pub(super) fn succeeded(&self) {
        if self.probes.is_empty() {
            return;
        }
        let mut state = self.policy.state.lock().expect("Bilibili request policy");
        let size = state.holds.len();
        state.holds.retain(|hold| {
            !self
                .probes
                .contains(&(hold.restriction.scope, hold.revision))
        });
        if state.holds.len() != size {
            self.policy.save(&state);
        }
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if !self.probes.is_empty() {
            let mut state = self.policy.state.lock().expect("Bilibili request policy");
            for hold in &mut state.holds {
                if self
                    .probes
                    .contains(&(hold.restriction.scope, hold.revision))
                {
                    hold.probing = false;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    #[test]
    fn retry_after_accepts_delta_and_http_date() {
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("37"));
        assert_eq!(
            delay_from_header(&headers, now),
            Some(Duration::from_secs(37))
        );
        let later = httpdate::fmt_http_date(now + Duration::from_secs(42));
        headers.insert(RETRY_AFTER, HeaderValue::from_str(&later).unwrap());
        assert_eq!(
            delay_from_header(&headers, now),
            Some(Duration::from_secs(42))
        );
        headers.insert(RETRY_AFTER, HeaderValue::from_static("not a deadline"));
        assert_eq!(delay_from_header(&headers, now), None);
    }

    #[tokio::test]
    async fn limited_api_pauses_other_background_reads_and_is_loaded_after_reopen() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        let state = dir.join("holds.json");
        let policy = Policy::new(Some(state.clone()));
        let lease = policy
            .acquire(Stage::Favorites, 42, Priority::Foreground, true)
            .await
            .unwrap();
        let error = lease.restrict(false, Some(429), None, Some(Duration::from_secs(180)));
        let ProviderError::RateLimited(restriction) = error else {
            panic!("expected limit")
        };
        drop(lease);
        drop(policy);
        let policy = Policy::new(Some(state));
        assert!(matches!(
            policy.acquire(Stage::Favorites, 43, Priority::Foreground, true).await,
            Err(ProviderError::RateLimited(saved)) if saved.retry_at == restriction.retry_at
        ));
        assert!(matches!(
            policy
                .acquire(Stage::Catalog, 42, Priority::Background, true)
                .await,
            Err(ProviderError::RateLimited(_))
        ));
        assert!(
            policy
                .acquire(Stage::Playback, 42, Priority::Foreground, true)
                .await
                .is_ok()
        );
        assert!(
            policy
                .acquire(Stage::Account, 42, Priority::Background, true)
                .await
                .is_ok()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn only_one_needed_request_may_probe_and_old_success_does_not_clear_new_hold() {
        let policy = Policy::new(None);
        let previous = policy
            .acquire(Stage::Catalog, 42, Priority::Foreground, true)
            .await
            .unwrap();
        let reporting = policy
            .acquire(Stage::Catalog, 42, Priority::Foreground, true)
            .await
            .unwrap();
        reporting.restrict(false, Some(429), None, Some(Duration::ZERO));
        previous.succeeded();
        assert!(matches!(
            policy
                .acquire(Stage::Catalog, 42, Priority::Background, true)
                .await,
            Err(ProviderError::RateLimited(_))
        ));
        let probe = policy
            .acquire(Stage::Catalog, 42, Priority::Resume, true)
            .await
            .unwrap();
        assert!(probe.is_probe());
        assert!(matches!(
            policy
                .acquire(Stage::Catalog, 42, Priority::Foreground, true)
                .await,
            Err(ProviderError::RateLimited(_))
        ));
        reporting.restrict(false, Some(429), None, Some(Duration::from_secs(180)));
        probe.succeeded();
        assert!(matches!(
            policy
                .acquire(Stage::Catalog, 42, Priority::Foreground, true)
                .await,
            Err(ProviderError::RateLimited(_))
        ));
    }

    #[tokio::test]
    async fn successful_requested_probe_reopens_the_api() {
        let policy = Policy::new(None);
        let reporting = policy
            .acquire(Stage::Search, 42, Priority::Foreground, true)
            .await
            .unwrap();
        reporting.restrict(false, Some(429), None, Some(Duration::ZERO));
        let probe = policy
            .acquire(Stage::Search, 42, Priority::Foreground, true)
            .await
            .unwrap();
        probe.succeeded();
        drop(probe);
        assert!(
            policy
                .acquire(Stage::Search, 42, Priority::Background, true)
                .await
                .is_ok()
        );
    }
}
