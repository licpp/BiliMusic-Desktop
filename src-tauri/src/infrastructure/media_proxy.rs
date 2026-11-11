use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, Response, StatusCode, header},
    routing::get,
};
use futures_util::StreamExt;
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
const PREFIX_LIMIT: usize = 256 * 1024;
const MEDIA_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

#[derive(Clone)]
struct MediaEntry {
    upstream_urls: Vec<String>,
    content_type: String,
    expires_at: Instant,
    local_path: Option<std::path::PathBuf>,
    prefix: Arc<RwLock<(Vec<u8>, u64)>>,
}

#[derive(Clone)]
struct ProxyState {
    access_token: String,
    client: Arc<RwLock<Client>>,
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
            client: Arc::new(RwLock::new(Self::build_client()?)),
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

    fn build_client() -> Result<Client, reqwest::Error> {
        Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
    }

    pub async fn refresh_connections(
        &self,
    ) -> Result<(), super::providers::bilibili::ProviderError> {
        *self.state.client.write().await = Self::build_client()?;
        Ok(())
    }

    pub async fn register_stream(
        &self,
        upstream_url: String,
        backup_urls: Vec<String>,
        content_type: String,
    ) -> String {
        let media_id = Uuid::new_v4().simple().to_string();
        let mut upstream_urls = vec![upstream_url];
        for backup in backup_urls {
            if !upstream_urls.contains(&backup) {
                upstream_urls.push(backup);
            }
        }
        let mut entries = self.state.entries.write().await;
        entries.retain(|_, entry| entry.expires_at > Instant::now());
        if let Some((id, _)) = entries.iter().find(|(_, entry)| {
            entry.local_path.is_none()
                && entry.content_type == content_type
                && entry
                    .upstream_urls
                    .iter()
                    .any(|url| url == &upstream_urls[0])
        }) {
            return format!("{}/{}/{}", self.base_url, self.state.access_token, id);
        }
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
                upstream_urls,
                content_type,
                expires_at: Instant::now() + ENTRY_LIFETIME,
                local_path: None,
                prefix: Arc::new(RwLock::new((Vec::new(), 0))),
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
                upstream_urls: vec![],
                content_type: "audio/mp4".into(),
                expires_at: Instant::now() + Duration::from_secs(24 * 3600),
                local_path: Some(path),
                prefix: Arc::new(RwLock::new((Vec::new(), 0))),
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

    // Only answer fully cached ranges; large or open-ended requests still stream.
    if let Some(range) = request_headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        let cache = entry.prefix.read().await;
        if let Some((start, end)) = byte_range(Some(range), cache.1) {
            if end < cache.0.len() as u64 {
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, &entry.content_type)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{}", cache.1),
                    )
                    .header(header::CONTENT_LENGTH, end - start + 1)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Body::from(cache.0[start as usize..=end as usize].to_vec()))
                    .unwrap();
            }
        }
    }
    let client = state.client.read().await.clone();
    let range = request_headers.get(header::RANGE);
    let Some((upstream, selected, prefix)) =
        fetch_playback_range(&client, &entry.upstream_urls, range).await
    else {
        return status_response(StatusCode::BAD_GATEWAY);
    };
    if selected > 0 {
        if let Some(stored) = state.entries.write().await.get_mut(&media_id) {
            if let Some(position) = stored
                .upstream_urls
                .iter()
                .position(|url| url == &entry.upstream_urls[selected])
            {
                stored.upstream_urls.swap(0, position);
            }
        }
    }
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            response = response.header(name, value);
        }
    }
    let content_type = entry.content_type.clone();
    let span = response_span(upstream.headers());
    let body = resumable_media(
        upstream,
        prefix,
        client,
        entry,
        selected,
        span,
        Duration::from_secs(6),
    );
    response
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| status_response(StatusCode::INTERNAL_SERVER_ERROR))
}

fn response_span(headers: &HeaderMap) -> Option<(u64, u64, u64)> {
    let range = headers
        .get(header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .strip_prefix("bytes ")?;
    let (span, total) = range.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let (start, end, total) = (
        start.parse::<u64>().ok()?,
        end.parse::<u64>().ok()?,
        total.parse::<u64>().ok()?,
    );
    (start <= end && end < total).then_some((start, end, total))
}

struct Transfer {
    response: reqwest::Response,
    pending: Option<axum::body::Bytes>,
    client: Client,
    entry: MediaEntry,
    span: Option<(u64, u64, u64)>,
    offset: u64,
    selected: usize,
    retries: u8,
    done: bool,
    idle: Duration,
}
fn resumable_media(
    response: reqwest::Response,
    prefix: axum::body::Bytes,
    client: Client,
    entry: MediaEntry,
    selected: usize,
    span: Option<(u64, u64, u64)>,
    idle: Duration,
) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>> {
    let transfer = Transfer {
        response,
        pending: Some(prefix),
        client,
        entry,
        span,
        offset: span.map(|v| v.0).unwrap_or(0),
        selected,
        retries: 0,
        done: false,
        idle,
    };
    futures_util::stream::unfold(transfer, |mut t| async move {
        if t.done {
            return None;
        }
        loop {
            let result = if let Some(chunk) = t.pending.take() {
                Ok(Ok(Some(chunk)))
            } else {
                tokio::time::timeout(t.idle, t.response.chunk()).await
            };
            if let Ok(Ok(Some(chunk))) = result {
                if let Some((_, end, total)) = t.span {
                    if chunk.len() as u64 > end + 1 - t.offset {
                        t.done = true;
                        return Some((Err(std::io::Error::other("media range overflow")), t));
                    }
                    let mut cache = t.entry.prefix.write().await;
                    if t.offset == cache.0.len() as u64 && cache.0.len() < PREFIX_LIMIT {
                        let count = chunk.len().min(PREFIX_LIMIT - cache.0.len());
                        cache.0.extend_from_slice(&chunk[..count]);
                        cache.1 = total;
                    }
                }
                t.offset += chunk.len() as u64;
                if t.span.is_some_and(|(_, end, _)| t.offset == end + 1) {
                    t.done = true;
                }
                return Some((Ok(chunk), t));
            }
            if matches!(result, Ok(Ok(None))) && t.span.is_none() {
                return None;
            }
            // Never splice different representations or an unvalidated full response.
            if let Some((_, end, total)) = t.span {
                if t.offset > end {
                    return None;
                }
                if t.retries < 2 {
                    t.retries += 1;
                    let urls: Vec<_> = t
                        .entry
                        .upstream_urls
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| *index != t.selected)
                        .map(|(_, url)| url.clone())
                        .collect();
                    let range =
                        HeaderValue::from_str(&format!("bytes={}-{end}", t.offset)).unwrap();
                    if let Some((next, index, prefix)) =
                        fetch_playback_range(&t.client, &urls, Some(&range)).await
                    {
                        if response_span(next.headers()) == Some((t.offset, end, total)) {
                            t.selected = t
                                .entry
                                .upstream_urls
                                .iter()
                                .position(|url| url == &urls[index])
                                .unwrap();
                            t.response = next;
                            t.pending = Some(prefix);
                            continue;
                        }
                    }
                }
            }
            t.done = true;
            return Some((Err(std::io::Error::other("media transfer interrupted")), t));
        }
    })
}

// An open connection can stop delivering after sleep or a network change.
// End the response so the player can rebuild from its position with a fresh source.
#[cfg(test)]
fn bounded_media_stream(
    response: reqwest::Response,
    idle: Duration,
) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>> {
    futures_util::stream::unfold(Some(response), move |response| async move {
        let mut response = response?;
        match tokio::time::timeout(idle, response.chunk()).await {
            Ok(Ok(Some(chunk))) => Some((Ok(chunk), Some(response))),
            Ok(Ok(None)) => None,
            Ok(Err(error)) => Some((Err(std::io::Error::other(error)), None)),
            Err(_) => Some((
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "media stream stopped delivering data",
                )),
                None,
            )),
        }
    })
}

async fn fetch_playback_range(
    client: &Client,
    urls: &[String],
    range: Option<&HeaderValue>,
) -> Option<(reqwest::Response, usize, axum::body::Bytes)> {
    let mut attempts = tokio::task::JoinSet::new();
    for (index, url) in urls.iter().take(3).enumerate() {
        let client = client.clone();
        let url = url.clone();
        let range = range.cloned();
        attempts.spawn(async move {
            // Give the preferred CDN a short head start, then hedge slow connections.
            tokio::time::sleep(Duration::from_millis(index as u64 * 140)).await;
            let mut request = client
                .get(url)
                .header(header::USER_AGENT, MEDIA_USER_AGENT)
                .header(header::REFERER, "https://www.bilibili.com/")
                .header(header::ACCEPT_ENCODING, "identity");
            if let Some(range) = &range {
                request = request.header(header::RANGE, range);
            }
            tokio::time::timeout(Duration::from_secs(8), async {
                let mut response = request.send().await.ok()?.error_for_status().ok()?;
                if range.is_some()
                    && (response.status() != StatusCode::PARTIAL_CONTENT
                        || !response.headers().contains_key(header::CONTENT_RANGE))
                {
                    return None;
                }
                // A tiny first packet is not evidence of a fast media route.
                // Race a useful startup block, or the entire short probe range.
                let mut prefix = response.chunk().await.ok()??.to_vec();
                while prefix.len() < 64 * 1024 {
                    match response.chunk().await.ok()? {
                        Some(chunk) => prefix.extend_from_slice(&chunk),
                        None => break,
                    }
                }
                Some((response, index, axum::body::Bytes::from(prefix)))
            })
            .await
            .ok()?
        });
    }
    while let Some(result) = attempts.join_next().await {
        if let Ok(Some(response)) = result {
            attempts.abort_all();
            return Some(response);
        }
    }
    None
}

pub async fn fetch_upstream(
    client: &Client,
    urls: &[String],
    range: Option<&HeaderValue>,
) -> Result<(reqwest::Response, usize), String> {
    let mut failure = "没有可用的媒体地址".to_string();
    for (index, url) in urls.iter().enumerate() {
        let mut request = client
            .get(url)
            .header(header::USER_AGENT, MEDIA_USER_AGENT)
            .header(header::REFERER, "https://www.bilibili.com/")
            .header(header::ACCEPT_ENCODING, "identity");
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        match request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
        {
            Ok(response) => return Ok((response, index)),
            Err(error) => {
                failure = if let Some(status) = error.status() {
                    format!("媒体服务器返回 {status}")
                } else {
                    "媒体服务器连接失败".into()
                };
            }
        }
    }
    Err(failure)
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
        .header(
            header::CONTENT_TYPE,
            crate::interface::local_audio::audio_mime(path).unwrap_or("audio/mp4"),
        )
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

    #[tokio::test]
    async fn interrupted_range_resumes_exactly_and_caches_prefix() {
        use futures_util::StreamExt;
        use axum::{
            Router,
            body::Body,
            http::{HeaderMap, Response},
            routing::get,
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let count = Arc::new(AtomicUsize::new(0));
        let requests = count.clone();
        let app = Router::new()
            .route(
                "/backup",
                get(move |headers: HeaderMap| {
                    let count = requests.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(headers["range"], "bytes=3-9");
                        Response::builder()
                            .status(206)
                            .header("Content-Range", "bytes 3-9/10")
                            .header("Content-Length", "7")
                            .body(Body::from("3456789"))
                            .unwrap()
                    }
                }),
            )
            .route(
                "/truncated",
                get(|| async {
                    Response::builder()
                        .status(206)
                        .header("Content-Range", "bytes 0-9/10")
                        .body(Body::from_stream(
                            futures_util::stream::once(async {
                                Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"012"))
                            })
                            .chain(futures_util::stream::pending()),
                        ))
                        .unwrap()
                }),
            );
        let app = app.route(
            "/wrong",
            get(|| async {
                Response::builder()
                    .status(206)
                    .header("Content-Range", "bytes 3-9/11")
                    .body(Body::from("BADBYTES"))
                    .unwrap()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::new();
        let mut response = client
            .get(format!("{base}/truncated"))
            .send()
            .await
            .unwrap();
        let prefix = response.chunk().await.unwrap().unwrap();
        let cache = Arc::new(tokio::sync::RwLock::new((Vec::new(), 0)));
        let entry = super::MediaEntry {
            upstream_urls: vec![format!("{base}/truncated"), format!("{base}/backup")],
            content_type: "audio/mp4".into(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(60),
            local_path: None,
            prefix: cache.clone(),
        };
        let stream = super::resumable_media(
            response,
            prefix,
            client.clone(),
            entry.clone(),
            0,
            Some((0, 9, 10)),
            std::time::Duration::from_millis(50),
        );
        let bytes = axum::body::to_bytes(Body::from_stream(stream), 1024)
            .await
            .unwrap();
        assert_eq!(bytes.as_ref(), b"0123456789");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(cache.read().await.0.as_slice(), b"0123456789");
        let mut broken = client
            .get(format!("{base}/truncated"))
            .send()
            .await
            .unwrap();
        let first = broken.chunk().await.unwrap().unwrap();
        let mut wrong = entry.clone();
        wrong.upstream_urls[1] = format!("{base}/wrong");
        wrong.prefix = Arc::new(tokio::sync::RwLock::new((Vec::new(), 0)));
        let stream = super::resumable_media(
            broken,
            first,
            client.clone(),
            wrong,
            0,
            Some((0, 9, 10)),
            std::time::Duration::from_millis(50),
        );
        assert!(
            axum::body::to_bytes(Body::from_stream(stream), 1024)
                .await
                .is_err()
        );
        // Serve a Safari-style repeat probe entirely from the cached prefix.
        let proxy = MediaProxy::start().await.unwrap();
        proxy
            .state
            .entries
            .write()
            .await
            .insert("cached".into(), entry);
        let url = format!("{}/{}/cached", proxy.base_url, proxy.state.access_token);
        let response = client
            .get(url)
            .header("Range", "bytes=1-2")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["Content-Range"], "bytes 1-2/10");
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"12");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let first = proxy
            .register_stream(format!("{base}/resource"), vec![], "audio/mp4".into())
            .await;
        let second = proxy
            .register_stream(format!("{base}/resource"), vec![], "audio/mp4".into())
            .await;
        assert_eq!(first, second);
        assert!(super::response_span(&HeaderMap::new()).is_none());
        server.abort();
    }

    #[tokio::test]
    async fn stalled_media_response_ends_instead_of_waiting_forever() {
        use futures_util::StreamExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/stall",
            axum::routing::get(|| async {
                axum::body::Body::from_stream(
                    futures_util::stream::once(async {
                        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"first"))
                    })
                    .chain(futures_util::stream::pending()),
                )
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut response = reqwest::get(format!("http://{address}/stall"))
            .await
            .unwrap();
        assert_eq!(response.chunk().await.unwrap().unwrap().as_ref(), b"first");
        let stream = super::bounded_media_stream(response, std::time::Duration::from_millis(50));
        tokio::pin!(stream);
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        assert!(stream.next().await.is_none());
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili CDN access"]
    async fn live_audio_proxy_supports_avplayer_range_requests() {
        use crate::infrastructure::providers::bilibili::BilibiliProvider;
        let provider = BilibiliProvider::new().unwrap();
        let detail = provider.video_parts("BV1GJ411x7h7").await.unwrap();
        let cid = detail.parts[0].cid;
        for refresh in [false, true] {
            if refresh {
                provider.invalidate_playback(&detail.bvid, cid).await;
            }
            let source = provider.playback_source(&detail.bvid, cid).await.unwrap();
            let proxy = MediaProxy::start().await.unwrap();
            let url = proxy
                .register_stream(source.audio_url, source.backup_urls, source.mime_type)
                .await;
            let response = reqwest::Client::new()
                .get(url)
                .header("Range", "bytes=0-4095")
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
            let bytes = response.bytes().await.unwrap();
            assert_eq!(bytes.len(), 4096);
            assert!(bytes.windows(4).any(|part| part == b"ftyp"));
        }
    }

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
    async fn media_proxy_supplies_headers_and_remembers_working_backup() {
        use axum::{
            Router,
            body::Body,
            http::{HeaderMap, Response, StatusCode},
            routing::get,
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let rejected = Arc::new(AtomicUsize::new(0));
        let counter = rejected.clone();
        let router = Router::new()
            .route(
                "/primary",
                get(move || {
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        StatusCode::FORBIDDEN
                    }
                }),
            )
            .route(
                "/backup",
                get(|headers: HeaderMap| async move {
                    assert_eq!(headers["user-agent"], super::MEDIA_USER_AGENT);
                    assert_eq!(headers["referer"], "https://www.bilibili.com/");
                    assert_eq!(headers["range"], "bytes=0-1");
                    Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header("content-type", "application/octet-stream")
                        .header("content-range", "bytes 0-1/20")
                        .header("content-length", "2")
                        .body(Body::from("ab"))
                        .unwrap()
                }),
            )
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    "slow primary"
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let proxy = MediaProxy::start().await.unwrap();
        let url = proxy
            .register_stream(
                format!("http://{address}/primary"),
                vec![format!("http://{address}/backup")],
                "audio/mp4".into(),
            )
            .await;
        for _ in 0..2 {
            let response = reqwest::Client::new()
                .get(&url)
                .header("Range", "bytes=0-1")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()["content-type"], "audio/mp4");
            assert_eq!(response.headers()["content-range"], "bytes 0-1/20");
            assert_eq!(response.text().await.unwrap(), "ab");
        }
        assert_eq!(rejected.load(Ordering::SeqCst), 1);
        for content_type in ["audio/mp4", "video/mp4"] {
            let url = proxy
                .register_stream(
                    format!("http://{address}/slow"),
                    vec![format!("http://{address}/backup")],
                    content_type.into(),
                )
                .await;
            let started = std::time::Instant::now();
            let response = reqwest::Client::new()
                .get(url)
                .header("Range", "bytes=0-1")
                .send()
                .await
                .unwrap();
            assert_eq!(response.headers()["content-type"], content_type);
            // The first chunk consumed during the race must still reach the player.
            assert_eq!(response.text().await.unwrap(), "ab");
            assert!(started.elapsed() < std::time::Duration::from_millis(1500));
        }
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_proxy_forwards_range_requests() {
        let provider = BilibiliProvider::new().expect("provider");
        let bvid = std::env::var("RESONANCE_TEST_BVID").unwrap_or_else(|_| "BV1GJ411x7h7".into());
        let detail = provider.video_parts(&bvid).await.expect("detail");
        let part = detail.parts.first().expect("part");
        let (url, backups, mime, codecs) =
            if std::env::var("RESONANCE_MEDIA_KIND").as_deref() == Ok("video") {
                let source = provider
                    .video_source(&detail.bvid, part.cid)
                    .await
                    .expect("video source");
                (
                    source.video_url,
                    source.backup_urls,
                    source.mime_type,
                    source.codecs,
                )
            } else {
                let source = provider
                    .playback_source(&detail.bvid, part.cid)
                    .await
                    .expect("audio source");
                (
                    source.audio_url,
                    source.backup_urls,
                    source.mime_type,
                    source.codecs,
                )
            };
        let proxy = MediaProxy::start().await.expect("proxy");
        eprintln!("media type={mime} codecs={codecs}");
        let local_url = proxy.register_stream(url, backups, mime).await;
        for range in ["bytes=0-1", "bytes=0-1023", "bytes=1024-2047"] {
            let response = reqwest::Client::new()
                .get(&local_url)
                .header("Range", range)
                .send()
                .await
                .expect("range response");
            assert!(
                response.status().is_success(),
                "proxy status was {}",
                response.status()
            );
            eprintln!(
                "range={range} status={} type={:?} content-range={:?}",
                response.status(),
                response.headers().get("content-type"),
                response.headers().get("content-range")
            );
            let body = response.bytes().await.expect("media bytes");
            assert!(!body.is_empty());
        }
        if let Ok(probe_file) = std::env::var("RESONANCE_MEDIA_PROBE_FILE") {
            let payload = if std::env::var("RESONANCE_MEDIA_KIND").as_deref() == Ok("video") {
                serde_json::json!({"videoUrl":local_url}).to_string()
            } else {
                local_url.clone()
            };
            tokio::fs::write(probe_file, payload)
                .await
                .expect("probe URL file");
            eprintln!("browser media probe ready for 60 seconds");
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    }
}
