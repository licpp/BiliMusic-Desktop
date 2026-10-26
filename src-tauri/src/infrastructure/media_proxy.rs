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
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    net::TcpListener,
    sync::RwLock,
};
use uuid::Uuid;

const ENTRY_LIFETIME: Duration = Duration::from_secs(6 * 3600);
const MAX_ENTRIES: usize = 24;

#[derive(Clone)]
struct MediaEntry {
    upstream_url: String,
    expires_at: Instant,
    local_path: Option<std::path::PathBuf>,
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
                local_path: None,
            },
        );
        format!("{}/{}/{}", self.base_url, self.state.access_token, media_id)
    }

    pub async fn register_local(&self, path: std::path::PathBuf) -> String {
        let id = Uuid::new_v4().simple().to_string();
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
            id.clone(),
            MediaEntry {
                upstream_url: String::new(),
                expires_at: Instant::now() + Duration::from_secs(24 * 3600),
                local_path: Some(path),
            },
        );
        format!("{}/{}/{}", self.base_url, self.state.access_token, id)
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
    if let Some(path) = entry.local_path {
        return serve_local(&path, &request_headers).await;
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

async fn serve_local(path: &std::path::Path, headers: &HeaderMap) -> Response<Body> {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return status_response(StatusCode::NOT_FOUND);
    };
    let Ok(metadata) = file.metadata().await else {
        return status_response(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let size = metadata.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let Some((start, end)) = byte_range(range, size) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Body::empty())
            .unwrap();
    };
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return status_response(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let length = end - start + 1;
    let stream = tokio_util::io::ReaderStream::new(file.take(length));
    let mut response = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, "audio/mp4")
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if range.is_some() {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response.body(Body::from_stream(stream)).unwrap()
}

fn byte_range(range: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let Some(range) = range else {
        return Some((0, size - 1));
    };
    let (start, end) = range.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        return (suffix > 0).then_some((size.saturating_sub(suffix), size - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end && start < size).then_some((start, end))
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

    #[test]
    fn local_audio_ranges_support_seeking_and_reject_invalid_offsets() {
        assert_eq!(super::byte_range(None, 100), Some((0, 99)));
        assert_eq!(super::byte_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(super::byte_range(Some("bytes=90-"), 100), Some((90, 99)));
        assert_eq!(super::byte_range(Some("bytes=-20"), 100), Some((80, 99)));
        assert_eq!(super::byte_range(Some("bytes=100-"), 100), None);
        assert_eq!(super::byte_range(Some("bytes=3-2"), 100), None);
        assert_eq!(super::byte_range(Some("bytes=0-2,5-8"), 100), None);
    }

    #[tokio::test]
    async fn local_audio_responds_with_exact_requested_bytes() {
        let path =
            std::env::temp_dir().join(format!("resonance-range-{}.m4a", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(axum::http::header::RANGE, "bytes=3-6".parse().unwrap());
        let response = super::serve_local(&path, &headers).await;
        assert_eq!(response.status(), axum::http::StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_RANGE],
            "bytes 3-6/10"
        );
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .as_ref(),
            b"3456"
        );
        tokio::fs::remove_file(&path).await.unwrap();
    }

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
