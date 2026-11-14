//! Per-attempt payload estimates. Never stores URLs, credentials, headers or content.
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub requests: u64,
    pub uploaded_bytes: u64,
    pub downloaded_bytes: u64,
    pub cache_hits: u64,
    pub failed_requests: u64,
    pub elapsed_ms: u64,
    pub retry_after_ms: u64,
    pub unauthorized: bool,
}
tokio::task_local! { static USAGE: Arc<Mutex<Usage>>; }
pub async fn capture<T>(future: impl std::future::Future<Output = T>) -> (T, Usage) {
    let usage = Arc::new(Mutex::new(Usage::default()));
    let result = USAGE.scope(usage.clone(), future).await;
    let report = usage.lock().unwrap().clone();
    (result, report)
}
fn update(f: impl FnOnce(&mut Usage)) {
    let _ = USAGE.try_with(|u| {
        if let Ok(mut u) = u.lock() {
            f(&mut u);
        }
    });
}
pub fn downloaded(n: usize) {
    update(|u| u.downloaded_bytes = u.downloaded_bytes.saturating_add(n as u64));
}
pub fn cache_hit() {
    update(|u| u.cache_hits += 1);
}
pub fn bridge_started(n: usize) {
    update(|u| {
        u.requests += 1;
        u.uploaded_bytes = u.uploaded_bytes.saturating_add(n as u64);
    });
}
pub fn bridge_finished(status: Option<u16>) {
    update(|u| match status {
        Some(401 | 403) => u.unauthorized = true,
        Some(429) => u.retry_after_ms = u.retry_after_ms.max(60_000),
        None => u.failed_requests += 1,
        _ => {}
    });
}
pub async fn send(builder: reqwest::RequestBuilder) -> Result<reqwest::Response, reqwest::Error> {
    let (client, request) = builder.build_split();
    let request = request?;
    bridge_started(
        request
            .body()
            .and_then(|b| b.as_bytes())
            .map_or(0, |b| b.len()),
    );
    let start = std::time::Instant::now();
    let result = client.execute(request).await;
    update(|u| {
        u.elapsed_ms = u
            .elapsed_ms
            .saturating_add(start.elapsed().as_millis().min(u64::MAX as u128) as u64);
        match &result {
            Err(_) => u.failed_requests += 1,
            Ok(r) => {
                let status = r.status().as_u16();
                if status == 304 {
                    u.cache_hits += 1;
                }
                if status >= 400 {
                    u.failed_requests += 1;
                }
                u.unauthorized |= matches!(status, 401 | 403);
                if status == 429 || status == 503 {
                    let delay = r
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| {
                            s.parse::<u64>()
                                .ok()
                                .map(std::time::Duration::from_secs)
                                .or_else(|| {
                                    httpdate::parse_http_date(s).ok().map(|t| {
                                        t.duration_since(std::time::SystemTime::now())
                                            .unwrap_or_default()
                                    })
                                })
                        })
                        .map(|d| d.as_millis().min(86_400_000) as u64);
                    if let Some(delay) = delay.or((status == 429).then_some(60_000)) {
                        u.retry_after_ms = u.retry_after_ms.max(delay);
                    }
                }
            }
        }
    });
    result
}
pub fn persist(
    c: &rusqlite::Connection,
    target: &str,
    domain: &str,
    usage: &Usage,
) -> Result<(), String> {
    c.execute("INSERT INTO sync_traffic(target,day,domain,requests,uploaded,downloaded,cache_hits,failed,elapsed_ms) VALUES(?1,date('now'),?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(target,day,domain) DO UPDATE SET requests=requests+excluded.requests,uploaded=uploaded+excluded.uploaded,downloaded=downloaded+excluded.downloaded,cache_hits=cache_hits+excluded.cache_hits,failed=failed+excluded.failed,elapsed_ms=elapsed_ms+excluded.elapsed_ms",
        rusqlite::params![target,domain,usage.requests,usage.uploaded_bytes,usage.downloaded_bytes,usage.cache_hits,usage.failed_requests,usage.elapsed_ms]).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn failed_partial_attempts_and_retries_remain_counted() {
        let (_, usage) = capture(async {
            bridge_started(100);
            downloaded(7);
            bridge_finished(None);
            bridge_started(100);
            downloaded(10);
            bridge_finished(Some(201));
        })
        .await;
        assert_eq!(usage.requests, 2);
        assert_eq!(usage.uploaded_bytes, 200);
        assert_eq!(usage.downloaded_bytes, 17);
        assert_eq!(usage.failed_requests, 1);
    }
    #[test]
    fn accounting_is_target_scoped_and_additive() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        super::super::storage::init(&c).unwrap();
        let usage = Usage {
            requests: 2,
            downloaded_bytes: 17,
            ..Usage::default()
        };
        persist(&c, "a", "library", &usage).unwrap();
        persist(&c, "a", "library", &usage).unwrap();
        persist(&c, "b", "statistics", &usage).unwrap();
        assert_eq!(
            c.query_row(
                "SELECT downloaded FROM sync_traffic WHERE target='a'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            34
        );
        assert_eq!(
            c.query_row(
                "SELECT requests FROM sync_traffic WHERE target='b'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            2
        );
    }
}
