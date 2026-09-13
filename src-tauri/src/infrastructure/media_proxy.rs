use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Response, StatusCode, header},
    routing::get,
};
use reqwest::Client;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::RwLock};
use uuid::Uuid;

const ENTRY_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_ENTRIES: usize = 24;

#[derive(Clone)]
struct MediaEntry {
    upstream_url: String,
    expires_at: Instant,
}

#[derive(Clone)]
struct ProxyState {
    access_token: String,
    client: Client,
    entries: Arc<RwLock<HashMap<String, MediaEntry>>>,
}

pub struct MediaProxy {
    base_url: String,
    state: ProxyState,
}

impl MediaProxy {
    pub async fn start() -> Result<Self, Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let state = ProxyState {
            access_token: Uuid::new_v4().simple().to_string(),
            client: Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .build()?,
            entries: Arc::new(RwLock::new(HashMap::new())),
        };
        let router = Router::new()
            .route("/{token}/{media_id}", get(proxy_media))
            .with_state(state.clone());
        tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("media proxy stopped: {error}");
            }
        });
        Ok(Self {
            base_url: format!("http://{address}"),
            state,
        })
    }

    pub async fn register(&self, upstream_url: String) -> String {
        let media_id = Uuid::new_v4().simple().to_string();
        let mut entries = self.state.entries.write().await;
        entries.retain(|_, entry| entry.expires_at > Instant::now());
        if entries.len() >= MAX_ENTRIES {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(id, _)| id.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            media_id.clone(),
            MediaEntry {
                upstream_url,
                expires_at: Instant::now() + ENTRY_LIFETIME,
            },
        );
        format!("{}/{}/{}", self.base_url, self.state.access_token, media_id)
    }
}

async fn proxy_media(
    State(state): State<ProxyState>,
    Path((token, media_id)): Path<(String, String)>,
    request_headers: HeaderMap,
) -> Response<Body> {
    if token != state.access_token {
        return status_response(StatusCode::NOT_FOUND);
    }
    let entry = {
        let entries = state.entries.read().await;
        entries.get(&media_id).cloned()
    };
    let Some(entry) = entry else {
        return status_response(StatusCode::GONE);
    };
    if entry.expires_at <= Instant::now() {
        return status_response(StatusCode::GONE);
    }

    let mut request = state
        .client
        .get(entry.upstream_url)
        .header(header::REFERER, "https://www.bilibili.com/");
    if let Some(range) = request_headers.get(header::RANGE) {
        request = request.header(header::RANGE, range);
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(_) => return status_response(StatusCode::BAD_GATEWAY),
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            response = response.header(name, value);
        }
    }
    response
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        )
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| status_response(StatusCode::INTERNAL_SERVER_ERROR))
}

fn status_response(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .expect("status response")
}

#[cfg(test)]
mod tests {
    use super::MediaProxy;
    use crate::infrastructure::providers::bilibili::BilibiliProvider;

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_proxy_forwards_range_requests() {
        let provider = BilibiliProvider::new().expect("provider");
        let detail = provider.video_parts("BV1GJ411x7h7").await.expect("detail");
        let part = detail.parts.first().expect("part");
        let source = provider
            .playback_source(&detail.bvid, part.cid)
            .await
            .expect("source");
        let proxy = MediaProxy::start().await.expect("proxy");
        let local_url = proxy.register(source.audio_url).await;
        let response = reqwest::Client::new()
            .get(local_url)
            .header("Range", "bytes=0-1023")
            .send()
            .await
            .expect("range response");
        assert!(
            response.status().is_success(),
            "proxy status was {}",
            response.status()
        );
        let body = response.bytes().await.expect("media bytes");
        assert!(!body.is_empty());
    }
}
