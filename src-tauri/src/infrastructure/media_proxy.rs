use super::playback_cache::{CHUNK_SIZE, PlaybackCache, Variant};
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
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    net::TcpListener,
    sync::{Mutex, RwLock},
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
    cached: Option<Arc<CachedAudio>>,
}

#[derive(Clone)]
struct ProxyState {
    access_token: String,
    client: Arc<RwLock<Client>>,
    entries: Arc<RwLock<HashMap<String, MediaEntry>>>,
    cache: Option<Arc<PlaybackCache>>,
    app: Option<tauri::AppHandle>,
}

struct ProxyServer {
    base_url: String,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
pub struct MediaProxy {
    server: Mutex<ProxyServer>,
    health_client: Client,
    background_idle: AtomicBool,
    state: ProxyState,
}

impl MediaProxy {
    pub async fn start() -> Result<Self, Box<dyn std::error::Error>> {
        Self::start_inner(None, None).await
    }
    pub async fn start_cached(app: tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let cache = app
            .path()
            .app_cache_dir()
            .ok()
            .zip(app.path().app_config_dir().ok())
            .and_then(|(root, config)| {
                PlaybackCache::open(root.join("playback-v1"), config.join("playback-cache.json"))
                    .ok()
            })
            .map(Arc::new);
        Self::start_inner(cache, Some(app)).await
    }
    async fn start_inner(
        cache: Option<Arc<PlaybackCache>>,
        app: Option<tauri::AppHandle>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let state = ProxyState {
            access_token: Uuid::new_v4().simple().to_string(),
            client: Arc::new(RwLock::new(Self::build_client()?)),
            entries: Arc::new(RwLock::new(HashMap::new())),
            cache,
            app,
        };
        let server = Self::serve(listener, state.clone());
        Ok(Self {
            server: Mutex::new(ProxyServer {
                base_url: format!("http://{address}"),
                task: Some(server),
            }),
            health_client: Client::builder()
                .no_proxy()
                .pool_max_idle_per_host(0)
                .timeout(Duration::from_millis(700))
                .build()?,
            background_idle: AtomicBool::new(false),
            state,
        })
    }
    fn serve(listener: TcpListener, state: ProxyState) -> tauri::async_runtime::JoinHandle<()> {
        let router = Router::new()
            .route("/_health/{token}", get(proxy_health))
            .route("/{token}/{media_id}", get(proxy_media))
            .with_state(state);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                eprintln!("media proxy stopped: {error}");
            }
        })
    }
    // iOS may defunct a listening socket while paused/suspended without terminating
    // axum's accept task. Refreshing the CDN client cannot repair that listener.
    pub async fn ensure_running(&self) -> std::io::Result<()> {
        self.background_idle.store(false, Ordering::SeqCst);
        let mut server = self.server.lock().await;
        let healthy = if server.task.is_some() {
            self.health_client
                .get(format!(
                    "{}/_health/{}",
                    server.base_url, self.state.access_token
                ))
                .send()
                .await
                .is_ok_and(|response| response.status() == StatusCode::NO_CONTENT)
        } else {
            false
        };
        if healthy {
            return Ok(());
        }
        // Bind first to a new ephemeral port. Old URLs stay invalid; newly resolved
        // audio/video URLs use the replacement, with entries and cache intact.
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        if let Some(task) = server.task.take() {
            task.abort();
        }
        server.base_url = format!("http://{address}");
        server.task = Some(Self::serve(listener, self.state.clone()));
        *self.state.client.write().await = Self::build_client().map_err(std::io::Error::other)?;
        eprintln!(
            "BiliMusic local media listener rebuilt on port {}",
            address.port()
        );
        if let Some(app) = &self.state.app {
            let _ = app.emit("media-proxy-restarted", ());
        }
        Ok(())
    }
    pub fn set_background_idle(&self, idle: bool) {
        self.background_idle.store(idle, Ordering::SeqCst);
    }
    pub async fn park_if_idle(&self) {
        let mut server = self.server.lock().await;
        // A queued background callback must not close a listener just revived by play.
        if !self.background_idle.load(Ordering::SeqCst) {
            return;
        }
        if let Some(task) = server.task.take() {
            task.abort();
        }
    }
    async fn local_url(&self, id: &str) -> String {
        let server = self.server.lock().await;
        format!("{}/{}/{}", server.base_url, self.state.access_token, id)
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
            return self.local_url(id).await;
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
                cached: None,
            },
        );
        self.local_url(&media_id).await
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
                cached: None,
            },
        );
        self.local_url(&id).await
    }
    pub fn cache(&self) -> Result<&Arc<PlaybackCache>, String> {
        self.state
            .cache
            .as_ref()
            .ok_or_else(|| "播放缓存暂不可用".into())
    }
    pub async fn cached_audio(&self, track_id: &str, quality: u32) -> Option<String> {
        let cache = self.state.cache.as_ref()?;
        let variant = cache.find(track_id, quality)?;
        Some(self.register_cached(variant, vec![]).await)
    }
    pub async fn register_audio(
        &self,
        track_id: &str,
        bvid: &str,
        cid: i64,
        quality: u32,
        source: super::providers::bilibili::PlaybackSource,
    ) -> String {
        if self
            .state
            .cache
            .as_ref()
            .is_some_and(|cache| cache.enabled())
        {
            let mut variant = Variant::new(track_id, bvid, cid, quality, &source);
            if let Some(found) = self
                .state
                .cache
                .as_ref()
                .and_then(|c| c.find(track_id, quality))
                .filter(|v| v.key == variant.key)
            {
                variant.total = found.total
            }
            let urls = std::iter::once(source.audio_url)
                .chain(source.backup_urls)
                .collect();
            self.register_cached(variant, urls).await
        } else {
            self.register_stream(source.audio_url, source.backup_urls, source.mime_type)
                .await
        }
    }
    async fn register_cached(&self, mut variant: Variant, urls: Vec<String>) -> String {
        let cache = self.state.cache.as_ref().unwrap().clone();
        variant.total = cache.total(&variant.key).unwrap_or(variant.total);
        let audio = CachedAudio {
            total: std::sync::atomic::AtomicU64::new(variant.total),
            variant,
            generation: cache.generation.load(std::sync::atomic::Ordering::Acquire),
            cache,
            urls: tokio::sync::Mutex::new(urls),
            locks: tokio::sync::Mutex::new(HashMap::new()),
        };
        let id = Uuid::new_v4().simple().to_string();
        let mut entries = self.state.entries.write().await;
        entries.retain(|_, v| v.expires_at > Instant::now());
        if entries.len() >= MAX_ENTRIES {
            if let Some(key) = entries
                .iter()
                .min_by_key(|(_, v)| v.expires_at)
                .map(|(k, _)| k.clone())
            {
                entries.remove(&key);
            }
        }
        entries.insert(
            id.clone(),
            MediaEntry {
                upstream_urls: vec![],
                content_type: audio.variant.mime.clone(),
                expires_at: Instant::now() + Duration::from_secs(24 * 3600),
                local_path: None,
                prefix: Arc::new(RwLock::new((vec![], 0))),
                cached: Some(Arc::new(audio)),
            },
        );
        self.local_url(&id).await
    }
}

impl Drop for MediaProxy {
    fn drop(&mut self) {
        if let Some(task) = self.server.get_mut().task.take() {
            task.abort();
        }
    }
}

async fn proxy_health(State(state): State<ProxyState>, Path(token): Path<String>) -> StatusCode {
    if token == state.access_token {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

struct CachedAudio {
    variant: Variant,
    total: std::sync::atomic::AtomicU64,
    cache: Arc<PlaybackCache>,
    generation: u64,
    urls: tokio::sync::Mutex<Vec<String>>,
    locks: tokio::sync::Mutex<HashMap<u64, std::sync::Weak<tokio::sync::Mutex<()>>>>,
}
impl CachedAudio {
    async fn block(&self, state: &ProxyState, index: u64) -> Result<Vec<u8>, std::io::Error> {
        if let Some(bytes) = self.cache.read(&self.variant.key, index) {
            return Ok(bytes);
        }
        let gate = {
            let mut locks = self.locks.lock().await;
            locks.retain(|_, v| v.strong_count() > 0);
            let gate = locks
                .get(&index)
                .and_then(|v| v.upgrade())
                .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
            locks.insert(index, Arc::downgrade(&gate));
            gate
        };
        let _guard = gate.lock().await;
        if let Some(bytes) = self.cache.read(&self.variant.key, index) {
            return Ok(bytes);
        }
        let urls = {
            let mut urls = self.urls.lock().await;
            if urls.is_empty() {
                let app = state
                    .app
                    .as_ref()
                    .ok_or_else(|| std::io::Error::other("当前片段尚未缓存，请联网后播放"))?;
                let provider = app.state::<super::providers::bilibili::BilibiliProvider>();
                let source = provider
                    .playback_source_with_quality(
                        &self.variant.bvid,
                        self.variant.cid,
                        self.variant.quality,
                    )
                    .await
                    .map_err(|_| std::io::Error::other("当前片段尚未缓存，请联网后播放"))?;
                let variant = Variant::new(
                    &self.variant.track_id,
                    &self.variant.bvid,
                    self.variant.cid,
                    self.variant.quality,
                    &source,
                );
                if variant.fingerprint != self.variant.fingerprint {
                    self.cache.invalidate(&self.variant.key);
                    return Err(std::io::Error::other("音源已更新，请重新播放"));
                }
                *urls = std::iter::once(source.audio_url)
                    .chain(source.backup_urls)
                    .collect();
            }
            urls.clone()
        };
        let total = self.total.load(std::sync::atomic::Ordering::Acquire);
        let start = index
            .checked_mul(CHUNK_SIZE)
            .ok_or_else(|| std::io::Error::other("无效的缓存片段"))?;
        let end = if total > 0 {
            (start + CHUNK_SIZE - 1).min(total - 1)
        } else {
            start + CHUNK_SIZE - 1
        };
        if start > end {
            return Err(std::io::Error::other("缓存片段超出音频范围"));
        }
        let range = HeaderValue::from_str(&format!("bytes={start}-{end}")).unwrap();
        let client = state.client.read().await.clone();
        let (response, selected, prefix) = fetch_playback_range(&client, &urls, Some(&range))
            .await
            .ok_or_else(|| std::io::Error::other("当前片段尚未缓存，请联网后播放"))?;
        let span = response_span(response.headers())
            .ok_or_else(|| std::io::Error::other("音频服务器未返回有效片段"))?;
        if span.0 != start
            || span.1 != (start + CHUNK_SIZE - 1).min(span.2 - 1)
            || (total > 0 && total != span.2)
        {
            self.cache.invalidate(&self.variant.key);
            return Err(std::io::Error::other("音频片段发生变化，请重新播放"));
        }
        self.total
            .store(span.2, std::sync::atomic::Ordering::Release);
        let entry = MediaEntry {
            upstream_urls: urls,
            content_type: self.variant.mime.clone(),
            expires_at: Instant::now() + ENTRY_LIFETIME,
            local_path: None,
            prefix: Arc::new(RwLock::new((vec![], 0))),
            cached: None,
        };
        let body = Body::from_stream(resumable_media(
            response,
            prefix,
            client,
            entry,
            selected,
            Some(span),
            Duration::from_secs(6),
        ));
        let bytes = axum::body::to_bytes(body, CHUNK_SIZE as usize)
            .await
            .map_err(|_| std::io::Error::other("音频片段下载中断，可重新播放继续"))?;
        if bytes.len() as u64 != span.1 - span.0 + 1 {
            return Err(std::io::Error::other("音频片段尚未完整缓存"));
        }
        // Full chunks are atomic; failed/cleared cache writes never interrupt audio playback.
        let _ = self
            .cache
            .write(&self.variant, span.2, index, &bytes, self.generation);
        Ok(bytes.to_vec())
    }
}

async fn serve_cached_audio(
    state: &ProxyState,
    audio: Arc<CachedAudio>,
    headers: &HeaderMap,
) -> Response<Body> {
    if audio.total.load(std::sync::atomic::Ordering::Acquire) == 0
        && audio.block(state, 0).await.is_err()
    {
        return status_response(StatusCode::BAD_GATEWAY);
    }
    let total = audio.total.load(std::sync::atomic::Ordering::Acquire);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let Some((start, end)) = byte_range(range, total) else {
        return Response::builder()
            .status(416)
            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
            .body(Body::empty())
            .unwrap();
    };
    // AVFoundation rejects shortened ranges, even with a valid smaller Content-Range.
    // Honor the requested range; body backpressure still fetches each chunk on demand.
    let first = match audio.block(state, start / CHUNK_SIZE).await {
        Ok(bytes) => bytes,
        Err(_) => return status_response(StatusCode::GATEWAY_TIMEOUT),
    };
    let mime = audio.variant.mime.clone();
    let state = state.clone();
    let body = futures_util::stream::unfold(
        (start, Some(first), audio, state),
        move |(cursor, pending, audio, state)| async move {
            if cursor > end {
                return None;
            }
            let bytes = match pending {
                Some(bytes) => Ok(bytes),
                None => audio.block(&state, cursor / CHUNK_SIZE).await,
            };
            match bytes {
                Ok(bytes) => {
                    let offset = (cursor % CHUNK_SIZE) as usize;
                    let count =
                        (end - cursor + 1).min(bytes.len().saturating_sub(offset) as u64) as usize;
                    if count == 0 {
                        return Some((
                            Err(std::io::Error::other("缓存片段不完整")),
                            (end + 1, None, audio, state),
                        ));
                    }
                    let chunk = axum::body::Bytes::copy_from_slice(&bytes[offset..offset + count]);
                    Some((Ok(chunk), (cursor + count as u64, None, audio, state)))
                }
                Err(error) => Some((Err(error), (end + 1, None, audio, state))),
            }
        },
    );
    let mut response = Response::builder()
        .status(if range.is_some() { 206 } else { 200 })
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, end - start + 1)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if range.is_some() {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    response.body(Body::from_stream(body)).unwrap()
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
        let mut entries = state.entries.write().await;
        // An active long audiobook must not lose its local route after 24 hours.
        if let Some(entry) = entries.get_mut(&media_id).filter(|v| v.cached.is_some()) {
            entry.expires_at = Instant::now() + Duration::from_secs(24 * 3600);
        }
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
    if let Some(audio) = &entry.cached {
        return serve_cached_audio(&state, audio.clone(), &request_headers).await;
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
    async fn dead_listener_is_rebuilt_once_without_losing_registered_audio() {
        let proxy = MediaProxy::start().await.unwrap();
        let path =
            std::env::temp_dir().join(format!("bilimusic-listener-{}.m4a", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"0123456789").await.unwrap();
        let old = proxy.register_local(path.clone()).await;
        let id = old.rsplit('/').next().unwrap().to_owned();
        let client = reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        assert_eq!(
            client
                .get(&old)
                .header("Range", "bytes=2-4")
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap()
                .as_ref(),
            b"234"
        );
        // Like iOS defuncting: state still owns a task/URL, but new connections fail.
        proxy.server.lock().await.task.as_ref().unwrap().abort();
        assert!(client.get(&old).send().await.is_err());
        let results = futures_util::future::join_all((0..8).map(|_| proxy.ensure_running())).await;
        assert!(results.into_iter().all(|result| result.is_ok()));
        let repaired = proxy.local_url(&id).await;
        assert_ne!(old, repaired);
        proxy.ensure_running().await.unwrap();
        assert_eq!(repaired, proxy.local_url(&id).await);
        assert_eq!(
            client
                .get(&repaired)
                .header("Range", "bytes=4-7")
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap()
                .as_ref(),
            b"4567"
        );
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn paused_background_parks_listener_but_stale_callback_cannot_close_new_playback() {
        let proxy = MediaProxy::start().await.unwrap();
        let initial = proxy.local_url("entry").await;
        proxy.set_background_idle(true);
        proxy.park_if_idle().await;
        assert!(proxy.server.lock().await.task.is_none());
        proxy.ensure_running().await.unwrap();
        let restored = proxy.local_url("entry").await;
        assert_ne!(initial, restored);
        // An already queued background handler arrives after the explicit play request.
        proxy.park_if_idle().await;
        assert!(proxy.server.lock().await.task.is_some());
        proxy.ensure_running().await.unwrap();
        assert_eq!(restored, proxy.local_url("entry").await);
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_cached_audio_probe() {
        let provider = crate::infrastructure::providers::bilibili::BilibiliProvider::new().unwrap();
        let detail = provider.video_parts("BV1GJ411x7h7").await.unwrap();
        let part = &detail.parts[0];
        let source = provider
            .playback_source(&detail.bvid, part.cid)
            .await
            .unwrap();
        let root = std::env::temp_dir().join(format!("bili-live-cache-{}", uuid::Uuid::new_v4()));
        let cache = std::sync::Arc::new(
            super::PlaybackCache::open(root.join("media"), root.join("config.json")).unwrap(),
        );
        let proxy = MediaProxy::start_inner(Some(cache), None).await.unwrap();
        let url = proxy
            .register_audio("probe", &detail.bvid, part.cid, 0, source)
            .await;
        let audio = proxy
            .state
            .entries
            .read()
            .await
            .values()
            .next()
            .unwrap()
            .cached
            .clone()
            .unwrap();
        audio
            .block(&proxy.state, 0)
            .await
            .expect("initial cache block");
        let client = reqwest::Client::new();
        for range in ["bytes=0-1", "bytes=-32", "bytes=0-"] {
            let response = client
                .get(&url)
                .header("Range", range)
                .send()
                .await
                .unwrap();
            eprintln!(
                "PROBE {range}: {} {:?}",
                response.status(),
                response.headers()
            );
            assert_eq!(response.status(), 206);
            assert!(!response.bytes().await.unwrap().is_empty());
        }
        if let Ok(probe) = std::env::var("BILIMUSIC_AV_PROBE") {
            let result = tokio::task::spawn_blocking(move || {
                std::process::Command::new(probe).arg(url).output().unwrap()
            })
            .await
            .unwrap();
            eprintln!(
                "AVFOUNDATION: {} {}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(result.status.success());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn persistent_chunks_support_ranges_offline_restart_and_coalesced_requests() {
        use super::{CHUNK_SIZE, PlaybackCache};
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
        let root =
            std::env::temp_dir().join(format!("bilimusic-proxy-cache-{}", uuid::Uuid::new_v4()));
        let cache =
            Arc::new(PlaybackCache::open(root.join("media"), root.join("config.json")).unwrap());
        let payload = Arc::new(
            (0..CHUNK_SIZE as usize * 10 + 23)
                .map(|i| (i % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let hits = Arc::new(AtomicUsize::new(0));
        let router = Router::new().route(
            "/audio.m4s",
            get({
                let payload = payload.clone();
                let hits = hits.clone();
                move |headers: HeaderMap| {
                    let payload = payload.clone();
                    let hits = hits.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        let range = headers.get("range").unwrap().to_str().unwrap();
                        let (start, end) =
                            super::byte_range(Some(range), payload.len() as u64).unwrap();
                        Response::builder()
                            .status(206)
                            .header(
                                "content-range",
                                format!("bytes {start}-{end}/{}", payload.len()),
                            )
                            .header("content-type", "audio/mp4")
                            .body(Body::from(payload[start as usize..=end as usize].to_vec()))
                            .unwrap()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let proxy = MediaProxy::start_inner(Some(cache.clone()), None)
            .await
            .unwrap();
        let url = proxy
            .register_audio(
                "test:42",
                "BVtest",
                42,
                0,
                crate::infrastructure::providers::bilibili::PlaybackSource {
                    audio_url: format!("http://{address}/audio.m4s?secret=not-persisted"),
                    backup_urls: vec![],
                    mime_type: "audio/mp4".into(),
                    codecs: "mp4a.40.2".into(),
                    bandwidth: 128000,
                },
            )
            .await;
        let client = reqwest::Client::new();
        let read_start = || async {
            let response = client
                .get(&url)
                .header("range", "bytes=0-31")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 206);
            response.bytes().await.unwrap()
        };
        let (a, b, c) = tokio::join!(read_start(), read_start(), read_start());
        assert_eq!(&a[..], &payload[..32]);
        assert_eq!(a, b);
        assert_eq!(b, c);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "same block is fetched once");
        assert_eq!(
            cache.status().unwrap().used_bytes,
            CHUNK_SIZE,
            "a probe never downloads the whole file"
        );
        let response = client
            .get(&url)
            .header(
                "range",
                format!("bytes={}-{}", CHUNK_SIZE - 17, CHUNK_SIZE + 31),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(
            &response.bytes().await.unwrap()[..],
            &payload[CHUNK_SIZE as usize - 17..CHUNK_SIZE as usize + 32]
        );
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let response = client
            .get(&url)
            .header("range", "bytes=-23")
            .send()
            .await
            .unwrap();
        assert_eq!(
            &response.bytes().await.unwrap()[..],
            &payload[payload.len() - 23..]
        );
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        upstream.abort();
        let _ = upstream.await;
        // Open a new index/route with no provider and no upstream URLs, as after an offline restart.
        let reopened =
            Arc::new(PlaybackCache::open(root.join("media"), root.join("config.json")).unwrap());
        let proxy = MediaProxy::start_inner(Some(reopened.clone()), None)
            .await
            .unwrap();
        let offline = proxy.cached_audio("test:42", 0).await.unwrap();
        for range in ["bytes=0-31", "bytes=-23"] {
            let response = client
                .get(&offline)
                .header("range", range)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 206);
            assert!(!response.bytes().await.unwrap().is_empty());
        }
        let response = client
            .get(&offline)
            .header(
                "range",
                format!("bytes={}-{}", CHUNK_SIZE * 2, CHUNK_SIZE * 2 + 31),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            504,
            "missing offline data must fail, never fabricate silence"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        let response = client
            .get(&offline)
            .header("range", "bytes=0-")
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.headers()["content-range"],
            format!("bytes 0-{}/{}", payload.len() - 1, payload.len())
        );
        drop(response);
        assert_eq!(reopened.clear().unwrap().used_bytes, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn interrupted_range_resumes_exactly_and_caches_prefix() {
        use axum::{
            Router,
            body::Body,
            http::{HeaderMap, Response},
            routing::get,
        };
        use futures_util::StreamExt;
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
            cached: None,
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
        let url = proxy.local_url("cached").await;
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
