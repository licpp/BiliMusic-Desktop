#[path = "bilibili_audio.rs"]
mod audio;
#[path = "bilibili_creators.rs"]
mod creators;
#[cfg(test)]
pub(crate) use audio::prefer_progressive_startup;
use audio::*;
#[path = "bilibili_extras.rs"]
mod extras;
pub use extras::*;
use reqwest::{
    Client, Url,
    cookie::{CookieStore, Jar},
    header::{
        ACCEPT, ACCEPT_LANGUAGE, COOKIE, HeaderMap, HeaderValue, ORIGIN, REFERER, SET_COOKIE,
    },
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::sync::{Mutex, RwLock, Semaphore};

const API_ORIGIN: &str = "https://api.bilibili.com";
const WEB_ORIGIN: &str = "https://www.bilibili.com/";
static FAVORITE_READ: Mutex<Option<Instant>> = Mutex::const_new(None);

pub(crate) fn valid_bvid(value: &str) -> bool {
    (10..=16).contains(&value.len())
        && value.starts_with("BV")
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn normalize_bvid(value: &str) -> Option<String> {
    let prefix = value.get(..2)?;
    if !prefix.eq_ignore_ascii_case("BV") {
        return None;
    }
    let bvid = format!("BV{}", &value[2..]);
    valid_bvid(&bvid).then_some(bvid)
}

fn video_link(input: &str) -> Option<Url> {
    let url = Url::parse(input)
        .or_else(|_| Url::parse(&format!("https://{input}")))
        .ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    match url.host_str()? {
        "b23.tv" if url.path().len() > 1 => Some(url),
        "www.bilibili.com" | "m.bilibili.com" | "bilibili.com" if bvid_from_url(&url).is_some() => {
            Some(url)
        }
        _ => None,
    }
}

fn bvid_from_url(url: &Url) -> Option<String> {
    let mut path = url.path_segments()?;
    if path.next()? != "video" {
        return None;
    }
    let bvid = normalize_bvid(path.next()?)?;
    path.all(str::is_empty).then_some(bvid)
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("网络请求失败: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Bilibili 接口返回错误 {code}: {message}")]
    Api { code: i64, message: String },
    #[error("没有找到可播放的音频流")]
    NoAudio,
    #[error("没有找到兼容的视频流")]
    NoVideo,
    #[error("{0}")]
    AccessRestricted(VideoAccess),
    #[error("B 站仅提供试看，请在 B 站视频页查看完整内容的观看条件")]
    PreviewOnly,
    #[error("弹幕数据解码失败: {0}")]
    DanmakuDecode(String),
    #[error("请先登录 Bilibili 账号")]
    NotAuthenticated,
    #[error("未找到视频，请复制完整的 B 站视频链接或 BV 号")]
    InvalidVideoLink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoAccess {
    Paid,
    ChargeExclusive,
    ChargeEarlyAccess,
}

impl std::fmt::Display for VideoAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Paid => "该视频为付费内容，当前账号无法播放完整版，请在 B 站视频页查看购买方式",
            Self::ChargeExclusive => {
                "该视频为充电专属，当前账号无法播放完整版，请在 B 站视频页查看充电方式"
            }
            Self::ChargeEarlyAccess => {
                "该视频为充电抢先看，当前账号无法播放完整版，可在 B 站查看充电方式或等待公开"
            }
        })
    }
}

impl ProviderError {
    pub(crate) fn retryable_read(&self) -> bool {
        match self {
            Self::Api { code, .. } => [-352, -412, -509, -799].contains(code),
            Self::Network(error) => {
                error.is_timeout()
                    || error.is_connect()
                    || error
                        .status()
                        .is_some_and(|s| matches!(s.as_u16(), 408 | 412 | 429 | 502 | 503 | 504))
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub items: Vec<SearchItem>,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub published_at: Option<u64>,
    pub bvid: String,
    pub title: String,
    pub uploader_name: String,
    pub uploader_id: i64,
    pub cover_url: String,
    pub duration_seconds: u64,
    pub play_count: u64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoParts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<VideoAccess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_count: Option<u64>,
    pub published_at: Option<u64>,
    pub bvid: String,
    pub aid: i64,
    pub title: String,
    pub cover_url: String,
    pub uploader_name: String,
    pub uploader_id: i64,
    pub parts: Vec<VideoPart>,
    pub season: Option<SeasonSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPart {
    pub cid: i64,
    pub page: u32,
    pub title: String,
    pub duration_seconds: u64,
    pub cover_url: String,
    pub first_frame_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
    pub quality_id: u32,
    pub audio_url: String,
    pub backup_urls: Vec<String>,
    pub mime_type: String,
    pub codecs: String,
    pub bandwidth: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSource {
    pub video_url: String,
    pub backup_urls: Vec<String>,
    pub mime_type: String,
    pub codecs: String,
    pub bandwidth: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmakuItem {
    pub time_seconds: f64,
    pub mode: u8,
    pub font_size: u16,
    pub color: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLogin {
    pub key: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginStatus {
    pub status: String,
    pub message: String,
    #[serde(skip_serializing)]
    pub cookie_header: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub logged_in: bool,
    pub user_id: Option<i64>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub level: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub senior_member: Option<bool>,
    pub vip_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vip_type: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vip_theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vip_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteFolder {
    pub id: i64,
    pub title: String,
    pub media_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteVideo {
    #[serde(default)]
    pub pubtime: Option<u64>,
    #[serde(default, rename = "id")]
    pub aid: i64,
    #[serde(default)]
    pub bvid: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub duration: u64,
    #[serde(default)]
    pub cnt_info: serde_json::Value,
    #[serde(default)]
    pub attr: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoritePage {
    #[serde(default)]
    pub medias: Option<Vec<FavoriteVideo>>,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Deserialize)]
struct FavoriteFoldersData {
    #[serde(default)]
    list: Option<Vec<FavoriteFolder>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedSeason {
    pub reference: String,
    pub title: String,
    pub cover_url: String,
    pub uploader_name: String,
    pub video_count: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedSeasonPage {
    pub items: Vec<SubscribedSeason>,
    pub next_page: Option<u32>,
}

#[derive(Deserialize)]
struct CollectedFoldersData {
    list: Option<Vec<serde_json::Value>>,
    has_more: bool,
}

impl CollectedFoldersData {
    fn into_season_page(self, page: u32) -> SubscribedSeasonPage {
        let rows = self.list.unwrap_or_default();
        let next_page = if self.has_more && !rows.is_empty() {
            page.checked_add(1)
        } else {
            None
        };
        let items = rows
            .into_iter()
            .filter_map(|row| {
                if row["type"].as_i64() != Some(21) {
                    return None;
                }
                let season_id = row["id"].as_i64().filter(|id| *id > 0)?;
                let uploader_id = row["upper"]["mid"]
                    .as_i64()
                    .filter(|id| *id > 0)
                    .or_else(|| row["mid"].as_i64().filter(|id| *id > 0))?;
                Some(SubscribedSeason {
                    reference: format!("season:{uploader_id}:{season_id}"),
                    title: row["title"].as_str().unwrap_or_default().to_owned(),
                    cover_url: normalize_url(row["cover"].as_str().unwrap_or_default()),
                    uploader_name: row["upper"]["name"].as_str().unwrap_or_default().to_owned(),
                    video_count: row["media_count"].as_u64(),
                })
            })
            .collect();
        SubscribedSeasonPage { items, next_page }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPage {
    pub items: Vec<CommentItem>,
    pub next: i64,
    pub is_end: bool,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentItem {
    pub id: i64,
    pub root_id: i64,
    pub parent_id: i64,
    pub user_id: i64,
    pub user_name: String,
    pub avatar_url: String,
    pub message: String,
    pub emotes: std::collections::HashMap<String, String>,
    pub created_at: i64,
    pub like_count: i64,
    pub liked: bool,
    pub reply_count: i64,
    pub replies: Vec<CommentItem>,
}

#[derive(Deserialize)]
struct Envelope<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

#[derive(Deserialize)]
struct QrGenerateData {
    url: String,
    qrcode_key: String,
}

#[derive(Deserialize)]
struct QrPollData {
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct NavData {
    #[serde(default, rename = "isLogin")]
    is_login: bool,
    #[serde(default)]
    mid: i64,
    #[serde(default)]
    uname: String,
    #[serde(default)]
    face: String,
    #[serde(default, rename = "level_info")]
    level: Option<NavLevel>,
    #[serde(default)]
    is_senior_member: Option<i64>,
    #[serde(default, rename = "vipStatus")]
    vip_status: Option<i64>,
    #[serde(default, rename = "vipType")]
    vip_type: Option<i64>,
    #[serde(default)]
    vip_label: Option<NavVipLabel>,
    #[serde(default)]
    vip: Option<NavVip>,
}

#[derive(Deserialize)]
struct NavLevel {
    current_level: Option<i64>,
}

#[derive(Deserialize, Default)]
struct NavVip {
    #[serde(default)]
    status: Option<i64>,
    #[serde(default, rename = "type")]
    kind: Option<i64>,
    #[serde(default)]
    label: Option<NavVipLabel>,
}

#[derive(Deserialize, Default)]
struct NavVipLabel {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    label_theme: Option<String>,
}

#[derive(Deserialize, Default)]
struct ReplyData {
    #[serde(default)]
    replies: Option<Vec<RawReply>>,
    #[serde(default)]
    page: ReplyPageMeta,
}

#[derive(Deserialize, Default)]
struct ReplyPageMeta {
    #[serde(default)]
    acount: i64,
    #[serde(default)]
    num: i64,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    count: i64,
}

#[derive(Deserialize)]
struct RawReply {
    rpid: i64,
    #[serde(default)]
    root: i64,
    #[serde(default)]
    parent: i64,
    #[serde(default, rename = "like")]
    like_count: i64,
    #[serde(default)]
    action: i64,
    #[serde(default)]
    ctime: i64,
    #[serde(default)]
    rcount: i64,
    member: ReplyMember,
    content: ReplyContent,
    #[serde(default)]
    replies: Option<Vec<RawReply>>,
}

#[derive(Deserialize)]
struct ReplyMember {
    #[serde(default)]
    mid: String,
    #[serde(default)]
    uname: String,
    #[serde(default)]
    avatar: String,
}
#[derive(Deserialize)]
struct ReplyContent {
    #[serde(default)]
    message: String,
    emote: Option<std::collections::HashMap<String, ReplyEmote>>,
}

#[derive(Deserialize)]
struct ReplyEmote {
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
struct SearchData {
    #[serde(default)]
    result: Vec<SearchVideo>,
    #[serde(default, rename = "numResults")]
    num_results: u64,
    #[serde(default)]
    page: u32,
    #[serde(default, rename = "pagesize")]
    page_size: u32,
}

#[derive(Deserialize)]
struct SearchVideo {
    #[serde(default)]
    pubdate: Option<u64>,
    #[serde(default)]
    bvid: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    mid: i64,
    #[serde(default)]
    pic: String,
    #[serde(default)]
    duration: String,
    #[serde(default)]
    play: u64,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct DetailData {
    #[serde(flatten)]
    access: AccessFlags,
    #[serde(default)]
    stat: Option<VideoStats>,
    #[serde(default)]
    pubdate: Option<u64>,
    bvid: String,
    aid: i64,
    title: String,
    pic: String,
    #[serde(default)]
    desc: String,
    #[serde(default)]
    duration: u64,
    owner: Owner,
    #[serde(default)]
    pages: Vec<PageData>,
    #[serde(default)]
    ugc_season: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct AccessFlags {
    rights: Option<VideoRights>,
    is_upower_exclusive: bool,
    is_upower_play: bool,
    is_upower_preview: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct VideoRights {
    pay: u32,
    ugc_pay: u32,
    arc_pay: u32,
    free_watch: u32,
}

impl AccessFlags {
    fn kind(&self, charge: Option<&ChargeInfo>) -> Option<VideoAccess> {
        if self.is_upower_exclusive {
            let early = charge
                .and_then(|info| info.show_info.as_ref())
                .and_then(|info| info.high_level.as_ref())
                .is_some_and(|level| level.title.contains("抢先看"));
            return Some(if early {
                VideoAccess::ChargeEarlyAccess
            } else {
                VideoAccess::ChargeExclusive
            });
        }
        let rights = self.rights.as_ref()?;
        (rights.free_watch == 0 && (rights.pay > 0 || rights.ugc_pay > 0 || rights.arc_pay > 0))
            .then_some(VideoAccess::Paid)
    }

    fn blocked_kind(&self, charge: Option<&ChargeInfo>) -> Option<VideoAccess> {
        self.kind(charge)
            .filter(|kind| *kind == VideoAccess::Paid || !self.is_upower_play)
    }
}

#[derive(Deserialize)]
struct ChargeInfo {
    show_info: Option<ChargeBanner>,
}

#[derive(Deserialize)]
struct ChargeBanner {
    high_level: Option<ChargeLevel>,
}

#[derive(Deserialize)]
struct ChargeLevel {
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
struct VideoStats {
    #[serde(default)]
    view: Option<u64>,
}

#[derive(Deserialize)]
struct Owner {
    mid: i64,
    name: String,
}

#[derive(Deserialize)]
pub(super) struct PageData {
    cid: i64,
    page: u32,
    part: String,
    duration: u64,
    #[serde(default)]
    first_frame: String,
}

#[derive(Deserialize)]
struct PlayData {
    dash: Option<DashData>,
    #[serde(default)]
    is_preview: serde_json::Value,
    #[serde(default)]
    volume: serde_json::Value,
}

impl PlayData {
    fn is_preview(&self) -> bool {
        self.is_preview.as_bool() == Some(true) || self.is_preview.as_u64() == Some(1)
    }

    fn has_audio(&self) -> bool {
        self.dash.as_ref().is_some_and(|dash| {
            !dash.audio.is_empty() || dash.flac.as_ref().is_some_and(|flac| flac.audio.is_some())
        })
    }

    fn into_dash(self, bvid: &str, cid: i64) -> Result<DashData, ProviderError> {
        let mut dash = self.dash.ok_or(ProviderError::NoAudio)?;
        dash.loudness =
            crate::domain::loudness::LoudnessDescriptor::from_volume(bvid, cid, &self.volume);
        Ok(dash)
    }
}

#[derive(Deserialize)]
struct DashData {
    #[serde(skip)]
    loudness: Option<crate::domain::loudness::LoudnessDescriptor>,
    #[serde(default)]
    flac: Option<FlacData>,
    #[serde(default)]
    audio: Vec<DashStream>,
    #[serde(default)]
    video: Vec<DashStream>,
}

#[derive(Deserialize)]
struct FlacData {
    audio: Option<DashStream>,
}

#[derive(Clone, Deserialize)]
struct DashStream {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    base_url: String,
    #[serde(default, rename = "baseUrl")]
    base_url_camel: String,
    #[serde(default)]
    backup_url: Vec<String>,
    #[serde(default, rename = "backupUrl")]
    backup_url_camel: Vec<String>,
    #[serde(default)]
    mime_type: String,
    #[serde(default, rename = "mimeType")]
    mime_type_camel: String,
    #[serde(default)]
    codecs: String,
    #[serde(default)]
    bandwidth: u64,
}

fn dash_cache_ttl(dash: &DashData) -> Duration {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    dash.audio
        .iter()
        .chain(dash.flac.as_ref().and_then(|flac| flac.audio.as_ref()))
        .chain(&dash.video)
        .flat_map(|stream| [&stream.base_url, &stream.base_url_camel])
        .filter_map(|raw| Url::parse(raw).ok())
        .filter_map(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "deadline")
                .and_then(|(_, value)| value.parse::<u64>().ok())
        })
        .map(|deadline| Duration::from_secs(deadline.saturating_sub(now + 30)))
        .min()
        .unwrap_or(DASH_TTL)
        .min(DASH_TTL)
}

type DashKey = (String, i64, bool);
type DashEntry = Arc<tokio::sync::OnceCell<(Instant, Arc<DashData>)>>;
const DASH_TTL: Duration = Duration::from_secs(180);
const DASH_CACHE_LIMIT: usize = 32;

pub struct BilibiliProvider {
    client: Client,
    cookies: Arc<Jar>,
    search_session: Mutex<bool>,
    session_cookie: RwLock<Option<String>>,
    dash_cache: RwLock<HashMap<DashKey, DashEntry>>,
    catalog_epoch: AtomicU64,
    seasons: RwLock<HashMap<(u64, i64, i64), (Instant, Season)>>,
    pages: RwLock<HashMap<(u64, String), PageEntry>>,
    page_slots: Semaphore,
}

impl BilibiliProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        let cookies = Arc::new(Jar::default());
        let client = Self::build_client(cookies.clone())?;
        Ok(Self {
            client,
            cookies,
            search_session: Mutex::new(false),
            session_cookie: RwLock::new(None),
            dash_cache: RwLock::new(HashMap::new()),
            catalog_epoch: AtomicU64::new(0),
            seasons: RwLock::new(HashMap::new()),
            pages: RwLock::new(HashMap::new()),
            page_slots: Semaphore::new(3),
        })
    }

    fn build_client(cookies: Arc<Jar>) -> Result<Client, reqwest::Error> {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/plain, */*"),
        );
        headers.insert(
            ACCEPT_LANGUAGE,
            HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"),
        );
        headers.insert(ORIGIN, HeaderValue::from_static("https://www.bilibili.com"));
        headers.insert(REFERER, HeaderValue::from_static(WEB_ORIGIN));
        Client::builder()
            .cookie_provider(cookies)
            .pool_idle_timeout(Duration::from_secs(30))
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
            .build()
    }

    pub async fn set_session_cookie(&self, cookie: Option<String>) {
        let mut cache = self.dash_cache.write().await;
        *self.session_cookie.write().await = cookie;
        cache.clear();
        self.catalog_epoch.fetch_add(1, Ordering::Relaxed);
        self.seasons.write().await.clear();
        self.pages.write().await.clear();
    }

    pub async fn qr_login_generate(&self) -> Result<QrLogin, ProviderError> {
        let data: QrGenerateData = self
            .get_data(
                Url::parse("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
                    .expect("static login URL"),
            )
            .await?;
        Ok(QrLogin {
            key: data.qrcode_key,
            url: data.url,
        })
    }

    pub async fn qr_login_poll(&self, key: &str) -> Result<QrLoginStatus, ProviderError> {
        let mut url = Url::parse("https://passport.bilibili.com/x/passport-login/web/qrcode/poll")
            .expect("static login URL");
        url.query_pairs_mut().append_pair("qrcode_key", key);
        let response = self.client.get(url).send().await?.error_for_status()?;
        let cookies = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .filter_map(|value| value.split(';').next())
            .collect::<Vec<_>>()
            .join("; ");
        let envelope: Envelope<QrPollData> = response.json().await?;
        if envelope.code != 0 {
            return Err(ProviderError::Api {
                code: envelope.code,
                message: envelope.message,
            });
        }
        let data = envelope.data.ok_or_else(|| ProviderError::Api {
            code: -1,
            message: "响应缺少 data".into(),
        })?;
        let status = match data.code {
            0 => "authenticated",
            86090 => "confirmed",
            86101 => "waiting",
            86038 => "expired",
            _ => "error",
        };
        let cookie_header = if data.code == 0 && !cookies.is_empty() {
            Some(cookies)
        } else {
            None
        };
        if let Some(cookie) = &cookie_header {
            self.set_session_cookie(Some(cookie.clone())).await;
        }
        Ok(QrLoginStatus {
            status: status.into(),
            message: data.message,
            cookie_header,
        })
    }

    pub async fn account_profile(&self) -> Result<AccountProfile, ProviderError> {
        if self.session_cookie.read().await.is_none() {
            return Ok(AccountProfile {
                logged_in: false,
                user_id: None,
                name: None,
                avatar_url: None,
                level: None,
                senior_member: None,
                vip_active: None,
                vip_type: None,
                vip_theme: None,
                vip_label: None,
            });
        }
        let data: NavData = self.get_data(self.api_url("/x/web-interface/nav")).await?;
        Ok(account_profile_from_nav(data))
    }

    pub async fn comments(&self, aid: i64, next: i64) -> Result<CommentPage, ProviderError> {
        let page_number = next.max(1);
        let mut url = self.api_url("/x/v2/reply");
        url.query_pairs_mut()
            .append_pair("type", "1")
            .append_pair("oid", &aid.to_string())
            .append_pair("pn", &page_number.to_string())
            .append_pair("sort", "2");
        let data: ReplyData = self.get_data(url).await?;
        let page_size = data.page.size.max(20);
        let page = data.page.num.max(page_number);
        Ok(CommentPage {
            items: data
                .replies
                .unwrap_or_default()
                .into_iter()
                .map(comment_from_raw)
                .collect(),
            next: page + 1,
            is_end: page * page_size >= data.page.count,
            total: data.page.count.max(data.page.acount),
        })
    }

    pub async fn favorite_folders(&self) -> Result<Vec<FavoriteFolder>, ProviderError> {
        let profile = self.account_profile().await?;
        let uid = profile.user_id.ok_or(ProviderError::NotAuthenticated)?;
        self.favorite_folders_for(uid).await
    }

    pub async fn favorite_folders_for(
        &self,
        uid: i64,
    ) -> Result<Vec<FavoriteFolder>, ProviderError> {
        let mut url = self.api_url("/x/v3/fav/folder/created/list-all");
        url.query_pairs_mut()
            .append_pair("up_mid", &uid.to_string());
        let data: FavoriteFoldersData = self.favorite_data(url).await?;
        Ok(data.list.unwrap_or_default())
    }

    pub async fn subscribed_seasons(
        &self,
        page: u32,
    ) -> Result<SubscribedSeasonPage, ProviderError> {
        let uid = self
            .account_profile()
            .await?
            .user_id
            .filter(|uid| *uid > 0)
            .ok_or(ProviderError::NotAuthenticated)?;
        let mut url = self.api_url("/x/v3/fav/folder/collected/list");
        url.query_pairs_mut()
            .append_pair("up_mid", &uid.to_string())
            .append_pair("pn", &page.to_string())
            .append_pair("ps", "20")
            .append_pair("platform", "web");
        let data: CollectedFoldersData = self.favorite_data(url).await?;
        Ok(data.into_season_page(page))
    }

    pub async fn favorite_videos(
        &self,
        folder_id: i64,
        page: u32,
    ) -> Result<FavoritePage, ProviderError> {
        let mut url = self.api_url("/x/v3/fav/resource/list");
        url.query_pairs_mut()
            .append_pair("media_id", &folder_id.to_string())
            .append_pair("pn", &page.max(1).to_string())
            .append_pair("ps", "20")
            .append_pair("order", "mtime")
            .append_pair("type", "0");
        self.favorite_data(url).await
    }

    pub async fn change_favorite_video(
        &self,
        folder_id: i64,
        aid: i64,
        add: bool,
    ) -> Result<(), ProviderError> {
        let field = if add {
            "add_media_ids"
        } else {
            "del_media_ids"
        };
        let form = [
            ("rid", aid.to_string()),
            ("type", "2".into()),
            (field, folder_id.to_string()),
            ("csrf", self.csrf_token().await?),
        ];
        let _: serde_json::Value = self
            .post_data(self.api_url("/x/v3/fav/resource/deal"), &form)
            .await?;
        Ok(())
    }

    pub async fn comment_replies(
        &self,
        aid: i64,
        root: i64,
        page: u32,
    ) -> Result<Vec<CommentItem>, ProviderError> {
        let mut url = self.api_url("/x/v2/reply/reply");
        url.query_pairs_mut()
            .append_pair("type", "1")
            .append_pair("oid", &aid.to_string())
            .append_pair("root", &root.to_string())
            .append_pair("pn", &page.max(1).to_string())
            .append_pair("ps", "20");
        let data: ReplyData = self.get_data(url).await?;
        Ok(data
            .replies
            .unwrap_or_default()
            .into_iter()
            .map(comment_from_raw)
            .collect())
    }

    pub async fn comment_like(
        &self,
        aid: i64,
        reply_id: i64,
        liked: bool,
    ) -> Result<(), ProviderError> {
        let csrf = self.csrf_token().await?;
        let url = self.api_url("/x/v2/reply/action");
        let form = [
            ("type", "1".to_string()),
            ("oid", aid.to_string()),
            ("rpid", reply_id.to_string()),
            ("action", if liked { "1" } else { "0" }.to_string()),
            ("csrf", csrf),
        ];
        let _: serde_json::Value = self.post_data(url, &form).await?;
        Ok(())
    }

    pub async fn comment_emotes(&self) -> Result<serde_json::Value, ProviderError> {
        let mut url = self.api_url("/x/emote/user/panel/web");
        url.query_pairs_mut().append_pair("business", "reply");
        let mut defaults = self.api_url("/x/emote/package");
        defaults
            .query_pairs_mut()
            .append_pair("business", "reply")
            .append_pair("ids", "1,2");
        let (personal, standard) = tokio::join!(
            self.get_data::<serde_json::Value>(url),
            self.get_data::<serde_json::Value>(defaults)
        );
        let mut packages = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut success = false;
        for data in [standard.as_ref(), personal.as_ref()].into_iter().flatten() {
            success = true;
            for pack in data["packages"].as_array().into_iter().flatten() {
                if pack["emote"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
                    && seen.insert(pack["id"].clone())
                {
                    packages.push(pack.clone());
                }
            }
        }
        if !success {
            return Err(personal.err().or_else(|| standard.err()).unwrap());
        }
        Ok(serde_json::json!({"packages": packages}))
    }

    pub async fn create_favorite_folder(
        &self,
        title: &str,
    ) -> Result<FavoriteFolder, ProviderError> {
        let csrf = self.csrf_token().await?;
        let form = [
            ("title", title.to_owned()),
            ("intro", String::new()),
            ("privacy", "1".into()),
            ("cover", String::new()),
            ("csrf", csrf),
        ];
        let data: serde_json::Value = self
            .post_data(self.api_url("/x/v3/fav/folder/add"), &form)
            .await?;
        let id = data["id"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(|| ProviderError::Api {
                code: -1,
                message: "新建收藏夹响应无效，请在 B 站检查是否已创建".into(),
            })?;
        Ok(FavoriteFolder {
            id,
            title: title.to_owned(),
            media_count: 0,
        })
    }

    pub async fn comment_reply(
        &self,
        aid: i64,
        message: &str,
        root: Option<i64>,
        parent: Option<i64>,
    ) -> Result<(), ProviderError> {
        let csrf = self.csrf_token().await?;
        let url = self.api_url("/x/v2/reply/add");
        let mut form = vec![
            ("type", "1".to_string()),
            ("oid", aid.to_string()),
            ("message", message.to_string()),
            ("plat", "1".to_string()),
            ("csrf", csrf),
        ];
        if let Some(root) = root {
            form.push(("root", root.to_string()));
        }
        if let Some(parent) = parent {
            form.push(("parent", parent.to_string()));
        }
        let _: serde_json::Value = self.post_data(url, &form).await?;
        Ok(())
    }

    pub async fn search_suggestions(&self, keyword: &str) -> Result<Vec<String>, ProviderError> {
        let keyword = keyword.trim();
        if keyword.is_empty()
            || keyword.chars().count() > 100
            || normalize_bvid(keyword).is_some()
            || video_link(keyword).is_some()
        {
            return Ok(vec![]);
        }
        let value: serde_json::Value = self
            .client
            .get("https://s.search.bilibili.com/main/suggest")
            .query(&[
                ("term", keyword),
                ("main_ver", "v1"),
                ("func", "suggest"),
                ("suggest_type", "accurate"),
                ("sub_type", "tag"),
                ("tag_num", "8"),
                ("highlight", ""),
            ])
            .header(reqwest::header::REFERER, "https://search.bilibili.com/")
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(suggestion_words(&value))
    }

    pub async fn search(
        &self,
        keyword: &str,
        page: u32,
        page_size: u32,
    ) -> Result<SearchPage, ProviderError> {
        let link = video_link(keyword);
        let bvid = match (normalize_bvid(keyword), link) {
            (Some(bvid), _) => Some(bvid),
            (None, Some(link)) => Some(self.resolve_video_link(link).await?),
            (None, None) => None,
        };
        if let Some(bvid) = bvid {
            let page = page.max(1);
            let items = if page == 1 {
                let detail = self.video_detail(&bvid).await?;
                vec![SearchItem {
                    published_at: detail.pubdate.filter(|date| *date > 0),
                    bvid: detail.bvid,
                    title: detail.title,
                    uploader_name: detail.owner.name,
                    uploader_id: detail.owner.mid,
                    cover_url: normalize_url(&detail.pic),
                    duration_seconds: detail.duration,
                    play_count: detail.stat.and_then(|stat| stat.view).unwrap_or(0),
                    description: detail.desc,
                }]
            } else {
                vec![]
            };
            return Ok(SearchPage {
                items,
                page,
                page_size: page_size.clamp(1, 50),
                total: 1,
            });
        }
        let mut url = self.api_url("/x/web-interface/search/type");
        url.query_pairs_mut()
            .append_pair("search_type", "video")
            .append_pair("keyword", keyword)
            .append_pair("page", &page.max(1).to_string())
            .append_pair("pagesize", &page_size.clamp(1, 50).to_string());
        let data = self
            .search_response(url, Url::parse(WEB_ORIGIN).expect("web origin"))
            .await?;
        Ok(SearchPage {
            page: data.page.max(1),
            page_size: data.page_size.max(1),
            total: data.num_results,
            items: data
                .result
                .into_iter()
                .map(|item| SearchItem {
                    published_at: item.pubdate.filter(|date| *date > 0),
                    bvid: item.bvid,
                    title: clean_html(&item.title),
                    uploader_name: item.author,
                    uploader_id: item.mid,
                    cover_url: normalize_url(&item.pic),
                    duration_seconds: parse_duration(&item.duration),
                    play_count: item.play,
                    description: clean_html(&item.description),
                })
                .collect(),
        })
    }

    async fn resolve_video_link(&self, mut url: Url) -> Result<String, ProviderError> {
        if url.host_str() != Some("b23.tv") {
            return bvid_from_url(&url).ok_or(ProviderError::InvalidVideoLink);
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .user_agent("Mozilla/5.0")
            .build()?;
        for _ in 0..3 {
            let response = client.get(url.clone()).send().await?.error_for_status()?;
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .filter(|_| response.status().is_redirection())
                .and_then(|value| value.to_str().ok())
                .and_then(|value| url.join(value).ok())
                .and_then(|next| video_link(next.as_str()))
                .ok_or(ProviderError::InvalidVideoLink)?;
            if next.host_str() != Some("b23.tv") {
                return bvid_from_url(&next).ok_or(ProviderError::InvalidVideoLink);
            }
            url = next;
        }
        Err(ProviderError::InvalidVideoLink)
    }

    async fn ensure_search_session(
        &self,
        web_url: Url,
        refresh: bool,
    ) -> Result<(), ProviderError> {
        let mut ready = self.search_session.lock().await;
        if *ready && !refresh {
            return Ok(());
        }
        // Complete the ordinary website cookie handshake before the search API call.
        // The shared jar also retains Set-Cookie headers on non-success API responses.
        self.authenticated_get(web_url)
            .await
            .header(ACCEPT, "text/html")
            .send()
            .await?
            .error_for_status()?;
        *ready = true;
        Ok(())
    }

    async fn search_response(&self, url: Url, web_url: Url) -> Result<SearchData, ProviderError> {
        self.ensure_search_session(web_url.clone(), false).await?;
        match self.get_data(url.clone()).await {
            Err(error)
                if matches!(&error,
                ProviderError::Network(e) if e.status() == Some(reqwest::StatusCode::PRECONDITION_FAILED))
                    || matches!(&error, ProviderError::Api { code: -412, .. }) =>
            {
                // Recover a stale visitor session once; persistent restrictions remain errors.
                self.ensure_search_session(web_url, true).await?;
                self.get_data(url).await
            }
            result => result,
        }
    }

    async fn video_detail(&self, bvid: &str) -> Result<DetailData, ProviderError> {
        let mut url = self.api_url("/x/web-interface/view");
        url.query_pairs_mut().append_pair("bvid", bvid);
        self.get_data(url).await
    }

    async fn charge_info(&self, detail: &DetailData) -> Option<ChargeInfo> {
        if !detail.access.is_upower_exclusive {
            return None;
        }
        let mut url = self.api_url("/x/web-interface/elec/show");
        url.query_pairs_mut()
            .append_pair("aid", &detail.aid.to_string())
            .append_pair("mid", &detail.owner.mid.to_string());
        tokio::time::timeout(Duration::from_secs(2), self.get_data(url))
            .await
            .ok()?
            .ok()
    }

    pub async fn video_tags(&self, bvid: &str) -> Result<Vec<String>, ProviderError> {
        let _permit = self.page_slots.acquire().await.expect("page semaphore remains open");
        let mut url = self.api_url("/x/tag/archive/tags");
        url.query_pairs_mut().append_pair("bvid", bvid);
        let rows: Vec<serde_json::Value> = self.get_data(url).await?;
        Ok(rows.into_iter().filter_map(|row| row["tag_name"].as_str().map(str::to_owned)).collect())
    }

    pub async fn video_parts(&self, bvid: &str) -> Result<VideoParts, ProviderError> {
        let epoch = self.catalog_epoch.load(Ordering::Relaxed);
        let detail = self.video_detail(bvid).await?;
        let charge = self.charge_info(&detail).await;
        let fallback_cover = normalize_url(&detail.pic);
        let season = detail
            .ugc_season
            .as_ref()
            .and_then(|season| season_summary(season, &detail.owner));
        let title = detail.title;
        let parts = normalize_pages(detail.pages, &title, &fallback_cover);
        self.remember_pages(epoch, bvid, parts.clone()).await;
        if let (Some(raw), Some(summary)) = (detail.ugc_season.as_ref(), season.as_ref()) {
            if let Some(snapshot) = complete_season(raw, summary, &detail.bvid) {
                self.remember_season(epoch, snapshot).await;
            }
        }
        Ok(VideoParts {
            access: detail.access.kind(charge.as_ref()),
            play_count: detail.stat.and_then(|stat| stat.view),
            published_at: detail.pubdate.filter(|date| *date > 0),
            bvid: detail.bvid,
            aid: detail.aid,
            title,
            cover_url: fallback_cover,
            uploader_name: detail.owner.name,
            uploader_id: detail.owner.mid,
            parts,
            season,
        })
    }

    pub async fn playback_source(
        &self,
        bvid: &str,
        cid: i64,
    ) -> Result<PlaybackSource, ProviderError> {
        self.playback_source_with_quality(bvid, cid, 0).await
    }
    pub async fn playback_source_with_quality(
        &self,
        bvid: &str,
        cid: i64,
        audio_id: u32,
    ) -> Result<PlaybackSource, ProviderError> {
        let dash = self.play_dash(bvid, cid, false).await?;
        let stream = select_audio(&dash, audio_id)
            .cloned()
            .ok_or(ProviderError::NoAudio)?;
        Ok(Self::audio_source(stream))
    }

    pub async fn playback_startup_sources(
        &self,
        bvid: &str,
        cid: i64,
        audio_id: u32,
    ) -> Result<(PlaybackSource, Option<PlaybackSource>), ProviderError> {
        let dash = self.play_dash(bvid, cid, false).await?;
        let target = select_audio(&dash, audio_id).ok_or(ProviderError::NoAudio)?;
        let initial = startup_audio(&dash, target)
            .cloned()
            .map(Self::audio_source);
        Ok((Self::audio_source(target.clone()), initial))
    }

    pub(crate) async fn compatible_audio_source(
        &self,
        bvid: &str,
        cid: i64,
    ) -> Result<PlaybackSource, ProviderError> {
        let dash = self.play_dash(bvid, cid, false).await?;
        compatible_audio(&dash)
            .cloned()
            .map(Self::audio_source)
            .ok_or(ProviderError::NoAudio)
    }

    fn audio_source(stream: DashStream) -> PlaybackSource {
        let audio_url = if stream.base_url_camel.is_empty() {
            stream.base_url
        } else {
            stream.base_url_camel
        };
        let backup_urls = if stream.backup_url_camel.is_empty() {
            stream.backup_url
        } else {
            stream.backup_url_camel
        };
        let mime_type = if stream.mime_type_camel.is_empty() {
            stream.mime_type
        } else {
            stream.mime_type_camel
        };
        PlaybackSource {
            quality_id: stream.id,
            audio_url,
            backup_urls,
            mime_type,
            codecs: stream.codecs,
            bandwidth: stream.bandwidth,
        }
    }

    pub async fn video_source(&self, bvid: &str, cid: i64) -> Result<VideoSource, ProviderError> {
        self.video_source_with_quality(bvid, cid, 0, false).await
    }
    pub async fn video_source_with_quality(
        &self,
        bvid: &str,
        cid: i64,
        video_height: u32,
        compatible: bool,
    ) -> Result<VideoSource, ProviderError> {
        let expanded = !compatible && video_height > 1080;
        if video_height != 0 && !expanded {
            let cache = self.dash_cache.read().await;
            let key = (bvid.to_owned(), cid, true);
            if let Some((expires, dash)) = cache.get(&key).and_then(|entry| entry.get()) {
                if *expires > Instant::now() {
                    if let Ok(source) = Self::select_video_for_platform(
                        &dash.video,
                        video_height,
                        cfg!(target_os = "ios"),
                        compatible,
                    ) {
                        return Ok(source);
                    }
                }
            }
        }
        let dash = self.play_dash(bvid, cid, expanded).await?;
        Self::select_video_for_platform(
            &dash.video,
            video_height,
            cfg!(target_os = "ios"),
            compatible,
        )
    }

    pub async fn invalidate_playback(&self, bvid: &str, cid: i64) {
        self.dash_cache
            .write()
            .await
            .retain(|(video, part, _), _| video != bvid || *part != cid);
    }

    /// Reads only the existing DASH result, never adds a network request.
    pub async fn cached_loudness(
        &self,
        bvid: &str,
        cid: i64,
    ) -> Option<crate::domain::loudness::LoudnessDescriptor> {
        self.dash_cache
            .read()
            .await
            .get(&(bvid.to_owned(), cid, false))?
            .get()?
            .1
            .loudness
            .clone()
    }

    pub async fn warm_playback(&self, bvid: &str, cid: i64) -> Result<(), ProviderError> {
        self.play_dash(bvid, cid, false).await.map(|_| ())
    }

    async fn play_dash(
        &self,
        bvid: &str,
        cid: i64,
        expanded: bool,
    ) -> Result<Arc<DashData>, ProviderError> {
        let entry = {
            let mut cache = self.dash_cache.write().await;
            let now = Instant::now();
            cache.retain(|_, entry| entry.get().is_none_or(|(expires, _)| *expires > now));
            let key = (bvid.to_owned(), cid, expanded);
            if let Some(entry) = cache.get(&key) {
                entry.clone()
            } else {
                if cache.len() >= DASH_CACHE_LIMIT {
                    let oldest = cache
                        .iter()
                        .filter(|(_, entry)| Arc::strong_count(entry) == 1)
                        .min_by_key(|(_, entry)| entry.get().map(|(expires, _)| *expires))
                        .map(|(key, _)| key.clone());
                    if let Some(oldest) = oldest {
                        cache.remove(&oldest);
                    }
                }
                let entry = Arc::new(tokio::sync::OnceCell::new());
                if cache.len() < DASH_CACHE_LIMIT {
                    cache.insert(key, entry.clone());
                }
                entry
            }
        };
        // The same playurl response contains both audio and video URLs. Share
        // the in-flight request when the user enables video during audio startup.
        let (_, dash) = entry
            .get_or_try_init(|| async {
                let dash = self.fetch_dash(bvid, cid, expanded).await?;
                let ttl = dash_cache_ttl(&dash);
                Ok::<_, ProviderError>((Instant::now() + ttl, Arc::new(dash)))
            })
            .await?;
        Ok(dash.clone())
    }

    async fn fetch_dash(
        &self,
        bvid: &str,
        cid: i64,
        expanded: bool,
    ) -> Result<DashData, ProviderError> {
        let mut url = self.api_url("/x/player/playurl");
        url.query_pairs_mut()
            .append_pair("bvid", bvid)
            .append_pair("cid", &cid.to_string())
            .append_pair("qn", if expanded { "120" } else { "80" })
            .append_pair("voice_balance", "1")
            .append_pair("fnver", "0")
            .append_pair("fnval", if expanded { "4048" } else { "1040" })
            .append_pair("fourk", if expanded { "1" } else { "0" });
        let play: PlayData = match self.get_data(url).await {
            Ok(play) => play,
            Err(
                error @ ProviderError::Api {
                    code: -403 | -10403 | -101,
                    ..
                },
            ) => {
                return Err(self.restricted_playback(bvid, false).await.unwrap_or(error));
            }
            Err(error @ ProviderError::Api { code: -404, .. }) => {
                return match tokio::time::timeout(Duration::from_secs(3), self.video_detail(bvid)).await {
                    Ok(Err(expired @ ProviderError::Api { code: 62002, .. })) => Err(expired),
                    _ => Err(error),
                };
            }
            Err(error) => return Err(error),
        };
        let preview = play.is_preview();
        // A guest may receive a short durl and no DASH even though the
        // envelope says success and timelength describes the full video.
        if preview || !play.has_audio() {
            if let Some(error) = self.restricted_playback(bvid, preview).await {
                return Err(error);
            }
        }
        play.into_dash(bvid, cid)
    }

    async fn restricted_playback(&self, bvid: &str, preview: bool) -> Option<ProviderError> {
        if let Ok(Ok(detail)) =
            tokio::time::timeout(Duration::from_secs(3), self.video_detail(bvid)).await
        {
            if detail.access.blocked_kind(None).is_some() {
                let charge = self.charge_info(&detail).await;
                return detail
                    .access
                    .blocked_kind(charge.as_ref())
                    .map(ProviderError::AccessRestricted);
            }
            if detail.access.is_upower_preview && !detail.access.is_upower_play {
                return Some(ProviderError::PreviewOnly);
            }
        }
        preview.then_some(ProviderError::PreviewOnly)
    }

    #[cfg(test)]
    pub(crate) async fn video_probe_for_platform(
        &self,
        bvid: &str,
        cid: i64,
        height: u32,
        ios: bool,
    ) -> Result<VideoSource, ProviderError> {
        let dash = self.play_dash(bvid, cid, height > 1080).await?;
        Self::select_video_for_platform(&dash.video, height, ios, false)
    }
    fn select_video_for_platform(
        streams: &[DashStream],
        height: u32,
        ios: bool,
        compatible: bool,
    ) -> Result<VideoSource, ProviderError> {
        let maximum = if compatible {
            if height > 0 { height.min(480) } else { 480 }
        } else if height > 0 {
            height
        } else if ios {
            480
        } else {
            720
        };
        let preferred = if ios && !compatible { "hvc1" } else { "avc" };
        let within_limit = |prefix: &str| {
            streams
                .iter()
                .filter(|s| s.codecs.starts_with(prefix) && s.height > 0 && s.height <= maximum)
                .max_by_key(|s| (s.height, s.bandwidth))
        };
        let preferred_stream = within_limit(preferred);
        let avc_stream = within_limit("avc");
        let stream = if height == 0 || compatible {
            let budget = if ios || compatible {
                650_000
            } else {
                1_200_000
            };
            let compatible = || {
                streams.iter().filter(|s| {
                    s.codecs.starts_with(preferred) && s.height > 0 && s.height <= maximum
                })
            };
            compatible()
                .filter(|s| s.bandwidth <= budget)
                .max_by_key(|s| (s.height, s.bandwidth))
                .or_else(|| compatible().min_by_key(|s| s.bandwidth))
                .or_else(|| {
                    streams
                        .iter()
                        .filter(|s| s.codecs.starts_with("avc"))
                        .min_by_key(|s| s.bandwidth)
                })
        } else {
            match (preferred_stream, avc_stream) {
                (Some(hevc), Some(avc)) if avc.height > hevc.height => Some(avc),
                (preferred, avc) => preferred.or(avc),
            }
        }
        .or_else(|| {
            streams
                .iter()
                .filter(|s| s.codecs.starts_with(preferred) || s.codecs.starts_with("avc"))
                .min_by_key(|s| s.bandwidth)
        })
        .ok_or(ProviderError::NoVideo)?;
        let source = VideoSource {
            backup_urls: if stream.backup_url_camel.is_empty() {
                stream.backup_url.clone()
            } else {
                stream.backup_url_camel.clone()
            },
            video_url: if stream.base_url_camel.is_empty() {
                stream.base_url.clone()
            } else {
                stream.base_url_camel.clone()
            },
            mime_type: if stream.mime_type_camel.is_empty() {
                stream.mime_type.clone()
            } else {
                stream.mime_type_camel.clone()
            },
            codecs: stream.codecs.clone(),
            bandwidth: stream.bandwidth,
        };
        Ok(source)
    }

    pub async fn danmaku(&self, cid: i64) -> Result<Vec<DanmakuItem>, ProviderError> {
        let client = Client::builder()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .user_agent("Mozilla/5.0 Resonance/0.1")
            .build()?;
        let bytes = client
            .get(format!("{API_ORIGIN}/x/v1/dm/list.so?oid={cid}"))
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let body = if bytes.starts_with(b"<") {
            String::from_utf8_lossy(&bytes).into_owned()
        } else {
            use std::io::Read;
            let mut body = String::new();
            flate2::read::DeflateDecoder::new(bytes.as_ref())
                .read_to_string(&mut body)
                .map_err(|error| ProviderError::DanmakuDecode(error.to_string()))?;
            body
        };
        Ok(parse_danmaku(&body))
    }

    fn api_url(&self, path: &str) -> Url {
        Url::parse(&format!("{API_ORIGIN}{path}")).expect("static API URL")
    }

    async fn get_data<T: DeserializeOwned>(&self, url: Url) -> Result<T, ProviderError> {
        let request = self.authenticated_get(url.clone()).await;
        let response = match request.send().await {
            Err(error) if error.is_connect() || (error.is_request() && !error.is_timeout()) => {
                // A resumed app may still hold a dead pooled connection. Retry this read with a fresh pool.
                let fresh = Self::build_client(self.cookies.clone())?;
                self.authenticated_get_with(&fresh, url)
                    .await
                    .send()
                    .await?
            }
            result => result?,
        };
        let envelope: Envelope<T> = response.error_for_status()?.json().await?;
        if envelope.code != 0 {
            return Err(ProviderError::Api {
                code: envelope.code,
                message: envelope.message,
            });
        }
        envelope.data.ok_or_else(|| ProviderError::Api {
            code: -1,
            message: "响应缺少 data".into(),
        })
    }

    async fn favorite_data<T: DeserializeOwned>(&self, url: Url) -> Result<T, ProviderError> {
        // Shared by fixed-session import providers too; bulk imports cannot burst
        // requests by creating another provider or opening another folder.
        let mut last = FAVORITE_READ.lock().await;
        if let Some(at) = *last {
            tokio::time::sleep(Duration::from_millis(500).saturating_sub(at.elapsed())).await;
        }
        *last = Some(Instant::now());
        self.get_data(url).await
    }

    async fn authenticated_get(&self, url: Url) -> reqwest::RequestBuilder {
        self.authenticated_get_with(&self.client, url).await
    }

    async fn authenticated_get_with(&self, client: &Client, url: Url) -> reqwest::RequestBuilder {
        let request = client.get(url.clone());
        match self.session_cookie.read().await.as_deref() {
            Some(session) => {
                // Explicit login headers otherwise replace the jar's visitor cookies.
                let visitor = self.cookies.cookies(&url);
                let visitor = visitor
                    .as_ref()
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("");
                let mut cookies: HashMap<&str, &str> = visitor
                    .split(';')
                    .chain(session.split(';'))
                    .filter_map(|entry| entry.trim().split_once('='))
                    .collect();
                let mut entries: Vec<_> = cookies.drain().collect();
                entries.sort_by_key(|entry| entry.0);
                request.header(
                    COOKIE,
                    entries
                        .into_iter()
                        .map(|(key, value)| format!("{key}={value}"))
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            }
            None => request,
        }
    }

    async fn csrf_token(&self) -> Result<String, ProviderError> {
        let cookie = self
            .session_cookie
            .read()
            .await
            .clone()
            .ok_or(ProviderError::NotAuthenticated)?;
        cookie
            .split(';')
            .map(str::trim)
            .find_map(|part| part.strip_prefix("bili_jct="))
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or(ProviderError::NotAuthenticated)
    }

    async fn post_data<T: DeserializeOwned>(
        &self,
        url: Url,
        form: &[(&str, String)],
    ) -> Result<T, ProviderError> {
        let cookie = self
            .session_cookie
            .read()
            .await
            .clone()
            .ok_or(ProviderError::NotAuthenticated)?;
        let envelope: Envelope<T> = self
            .client
            .post(url)
            .header(COOKIE, cookie)
            .form(form)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if envelope.code != 0 {
            return Err(ProviderError::Api {
                code: envelope.code,
                message: envelope.message,
            });
        }
        // Mutation endpoints may acknowledge success with data: null. Value
        // accepts null; structured response types still reject missing data.
        envelope
            .data
            .or_else(|| serde_json::from_value(serde_json::Value::Null).ok())
            .ok_or_else(|| ProviderError::Api {
                code: -1,
                message: "响应缺少 data".into(),
            })
    }
}

fn comment_from_raw(raw: RawReply) -> CommentItem {
    let id = raw.rpid;
    CommentItem {
        id,
        root_id: if raw.root == 0 { id } else { raw.root },
        parent_id: raw.parent,
        user_id: raw.member.mid.parse().unwrap_or(0),
        user_name: raw.member.uname,
        avatar_url: normalize_url(&raw.member.avatar),
        message: raw.content.message,
        emotes: raw
            .content
            .emote
            .unwrap_or_default()
            .into_iter()
            .take(64)
            .filter_map(|(token, emote)| {
                let url = Url::parse(&normalize_url(&emote.url)).ok()?;
                let host = url.host_str()?;
                (url.scheme() == "https"
                    && url.username().is_empty()
                    && url.password().is_none()
                    && ["hdslb.com", "biliimg.com"].iter().any(|domain| {
                        host == *domain
                            || host
                                .strip_suffix(*domain)
                                .is_some_and(|prefix| prefix.ends_with('.'))
                    }))
                .then(|| (token, url.to_string()))
            })
            .collect(),
        created_at: raw.ctime,
        like_count: raw.like_count,
        liked: raw.action == 1,
        reply_count: raw.rcount,
        replies: raw
            .replies
            .unwrap_or_default()
            .into_iter()
            .map(comment_from_raw)
            .collect(),
    }
}

fn parse_danmaku(xml: &str) -> Vec<DanmakuItem> {
    use quick_xml::{Reader, events::Event};
    let mut reader = Reader::from_str(xml);
    let mut result = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) if element.name().as_ref() == b"d" => {
                let parameters = element
                    .attributes()
                    .flatten()
                    .find(|attribute| attribute.key.as_ref() == b"p")
                    .and_then(|attribute| String::from_utf8(attribute.value.into_owned()).ok());
                if let Some(parameters) = parameters {
                    let mut content = String::new();
                    loop {
                        match reader.read_event() {
                            Ok(Event::Text(text)) => content.push_str(
                                &text
                                    .decode()
                                    .map(|value| value.into_owned())
                                    .unwrap_or_default(),
                            ),
                            Ok(Event::GeneralRef(entity)) => {
                                let entity_name: &[u8] = entity.as_ref();
                                content.push_str(match entity_name {
                                    b"amp" => "&",
                                    b"lt" => "<",
                                    b"gt" => ">",
                                    b"quot" => "\"",
                                    b"apos" => "'",
                                    _ => "",
                                })
                            }
                            Ok(Event::End(end)) if end.name().as_ref() == b"d" => break,
                            Ok(Event::Eof) | Err(_) => break,
                            _ => {}
                        }
                    }
                    let values: Vec<&str> = parameters.split(',').collect();
                    if values.len() >= 4 {
                        result.push(DanmakuItem {
                            time_seconds: values[0].parse().unwrap_or(0.0),
                            mode: values[1].parse().unwrap_or(1),
                            font_size: values[2].parse().unwrap_or(25),
                            color: values[3].parse().unwrap_or(0xffffff),
                            text: content,
                        });
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    result
}

fn normalize_url(value: &str) -> String {
    if value.starts_with("//") {
        format!("https:{value}")
    } else if let Some(path) = value.strip_prefix("http://") {
        format!("https://{path}")
    } else {
        value.to_owned()
    }
}

fn parse_duration(value: &str) -> u64 {
    value.split(':').fold(0_u64, |total, part| {
        total
            .saturating_mul(60)
            .saturating_add(part.parse().unwrap_or(0))
    })
}

fn clean_html(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => result.push(character),
            _ => {}
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn suggestion_words(value: &serde_json::Value) -> Vec<String> {
    let mut words = Vec::new();
    if value["code"].as_i64() != Some(0) {
        return words;
    }
    if let Some(tags) = value["result"]["tag"].as_array() {
        for tag in tags {
            if let Some(word) = tag["value"].as_str().or_else(|| tag["term"].as_str()) {
                let word = word.trim();
                if !word.is_empty()
                    && word.chars().count() <= 100
                    && !words.iter().any(|v| v == word)
                {
                    words.push(word.to_owned());
                    if words.len() == 8 {
                        break;
                    }
                }
            }
        }
    }
    words
}

fn account_profile_from_nav(data: NavData) -> AccountProfile {
    let vip_status = data
        .vip_status
        .or_else(|| data.vip.as_ref().and_then(|vip| vip.status));
    let vip_active = vip_status
        .filter(|_| data.is_login)
        .map(|status| status == 1);
    let active = vip_active == Some(true);
    let vip_type = data
        .vip_type
        .or_else(|| data.vip.as_ref().and_then(|vip| vip.kind))
        .filter(|_| data.is_login && active);
    let label_source = data
        .vip_label
        .as_ref()
        .or_else(|| data.vip.as_ref().and_then(|vip| vip.label.as_ref()));
    let vip_theme = if data.is_login && active {
        label_source
            .and_then(|label| label.label_theme.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    let vip_label = if data.is_login && active {
        label_source
            .and_then(|label| label.text.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    AccountProfile {
        logged_in: data.is_login,
        user_id: data.is_login.then_some(data.mid),
        name: data.is_login.then_some(data.uname),
        avatar_url: data.is_login.then_some(normalize_url(&data.face)),
        level: data
            .level
            .filter(|_| data.is_login)
            .and_then(|level| level.current_level),
        senior_member: data
            .is_senior_member
            .filter(|_| data.is_login)
            .map(|value| value == 1),
        vip_active,
        vip_type,
        vip_theme,
        vip_label,
    }
}

#[cfg(test)]
mod nav_profile_tests {
    use super::{NavData, account_profile_from_nav};

    #[test]
    fn parses_vip_tiers_and_senior_member_from_nav() {
        let ten_year: NavData = serde_json::from_str(
            r#"{
                    "isLogin": true,
                    "mid": 42,
                    "uname": "音乐旅人",
                    "face": "http://i0.hdslb.com/a.jpg",
                    "level_info": { "current_level": 6 },
                    "is_senior_member": 1,
                    "vipStatus": 1,
                    "vipType": 2,
                    "vip_label": { "text": "十年大会员", "label_theme": "ten_annual_vip" }
                }"#,
        )
        .expect("ten year nav");
        let profile = account_profile_from_nav(ten_year);
        assert_eq!(profile.level, Some(6));
        assert_eq!(profile.senior_member, Some(true));
        assert_eq!(profile.vip_active, Some(true));
        assert_eq!(profile.vip_type, Some(2));
        assert_eq!(profile.vip_theme.as_deref(), Some("ten_annual_vip"));
        assert_eq!(profile.vip_label.as_deref(), Some("十年大会员"));

        let expired: NavData = serde_json::from_str(
            r#"{
                    "isLogin": true,
                    "mid": 43,
                    "uname": "旧会员",
                    "face": "https://i0.hdslb.com/b.jpg",
                    "level_info": { "current_level": 5 },
                    "vipStatus": 0,
                    "vipType": 2,
                    "vip_label": { "text": "年度大会员", "label_theme": "annual_vip" }
                }"#,
        )
        .expect("expired nav");
        let expired_profile = account_profile_from_nav(expired);
        assert_eq!(expired_profile.vip_active, Some(false));
        assert_eq!(expired_profile.vip_type, None);
        assert_eq!(expired_profile.vip_theme, None);
        assert_eq!(expired_profile.vip_label, None);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn subscribed_seasons_filter_mixed_pages_without_stopping_pagination() {
        use super::CollectedFoldersData;
        use serde_json::{from_value, json};

        let page: CollectedFoldersData = from_value(json!({
            "has_more": true,
            "list": [
                {"type": 11, "id": 555},
                {"type": 21, "id": 9465322, "fid": 0, "mid": 3747575452667567_i64,
                 "title": "合集", "cover": "//example.test/cover.jpg", "media_count": 0,
                 "upper": {"mid": 3747575452667567_i64, "name": "UP 主"}},
                {"type": 21, "id": 0, "mid": 12},
                {"type": 21, "id": 123}
            ]
        }))
        .unwrap();
        let page = page.into_season_page(1);
        assert_eq!(page.next_page, Some(2));
        assert_eq!(page.items.len(), 1);
        let item = &page.items[0];
        assert_eq!(item.reference, "season:3747575452667567:9465322");
        assert_eq!(item.title, "合集");
        assert_eq!(item.cover_url, "https://example.test/cover.jpg");
        assert_eq!(item.uploader_name, "UP 主");
        assert_eq!(item.video_count, Some(0));

        let page: CollectedFoldersData = from_value(json!({
            "has_more": true,
            "list": [{"type": 11, "id": 556}]
        }))
        .unwrap();
        let page = page.into_season_page(2);
        assert!(page.items.is_empty());
        assert_eq!(page.next_page, Some(3));

        let page: CollectedFoldersData = from_value(json!({
            "has_more": false,
            "list": null
        }))
        .unwrap();
        assert_eq!(page.into_season_page(3).next_page, None);
    }

    #[test]
    fn access_flags_distinguish_early_access_exclusive_and_paid() {
        use super::{AccessFlags, ChargeInfo, VideoAccess};
        use serde_json::{from_value, json};

        let charge: AccessFlags = from_value(json!({
            "is_upower_exclusive": true,
            "is_upower_play": false,
            "is_upower_preview": true,
            "rights": { "pay": 0, "arc_pay": 0, "ugc_pay": 0 }
        }))
        .unwrap();
        let early: ChargeInfo = from_value(json!({
            "show_info": { "high_level": { "title": "该视频为「充电包」充电抢先看视频" } }
        }))
        .unwrap();
        let exclusive: ChargeInfo = from_value(json!({
            "show_info": { "high_level": { "title": "该视频为「大开大合」专属视频" } }
        }))
        .unwrap();
        assert_eq!(
            charge.kind(Some(&early)),
            Some(VideoAccess::ChargeEarlyAccess)
        );
        assert_eq!(
            charge.kind(Some(&exclusive)),
            Some(VideoAccess::ChargeExclusive)
        );
        assert_eq!(
            charge.blocked_kind(None),
            Some(VideoAccess::ChargeExclusive)
        );
        let entitled = AccessFlags {
            is_upower_play: true,
            ..charge
        };
        assert_eq!(
            entitled.kind(Some(&early)),
            Some(VideoAccess::ChargeEarlyAccess)
        );
        assert_eq!(entitled.blocked_kind(Some(&early)), None);

        let paid: AccessFlags = from_value(json!({"rights":{"ugc_pay":1}})).unwrap();
        assert_eq!(paid.kind(None), Some(VideoAccess::Paid));
        let public: AccessFlags =
            from_value(json!({"rights":{"arc_pay":1,"free_watch":1}})).unwrap();
        assert_eq!(public.kind(None), None);
        let legacy: AccessFlags = from_value(json!({"rights":null})).unwrap();
        assert_eq!(legacy.kind(None), None);
        assert_eq!(AccessFlags::default().kind(None), None);
    }

    #[test]
    fn guest_preview_can_report_the_full_duration_without_a_dash_stream() {
        use super::PlayData;
        use serde_json::{from_value, json};

        let response: PlayData = from_value(json!({
            "timelength": 3365941, "durl":[{"length": 654989}]
        }))
        .unwrap();
        assert!(!response.has_audio());
        assert!(!response.is_preview());
        let response: PlayData = from_value(json!({
            "dash": {"audio":[{"baseUrl":"https://cdn.test/audio"}]}, "is_preview":1
        }))
        .unwrap();
        assert!(response.has_audio());
        assert!(response.is_preview());
    }

    #[tokio::test]
    #[ignore = "requires access to Bilibili and current guest restrictions"]
    async fn live_charge_restrictions_on_reported_videos() {
        use super::{BilibiliProvider, ProviderError, VideoAccess};
        let provider = BilibiliProvider::new().unwrap();
        for (bvid, expected) in [
            ("BV1Thsr68Edj", VideoAccess::ChargeEarlyAccess),
            ("BV1FZNZ67EaP", VideoAccess::ChargeExclusive),
            ("BV1Ns9uBiEkj", VideoAccess::ChargeExclusive),
        ] {
            let detail = provider.video_parts(bvid).await.unwrap();
            assert_eq!(detail.access, Some(expected), "{bvid}");
            let cid = detail.parts[0].cid;
            assert!(
                matches!(provider.playback_source(bvid, cid).await, Err(ProviderError::AccessRestricted(kind)) if kind == expected),
                "{bvid}"
            );
        }
        let bvid = "BV1GJ411x7h7";
        let detail = provider.video_parts(bvid).await.unwrap();
        assert_eq!(detail.access, None);
        assert!(
            provider
                .playback_source(bvid, detail.parts[0].cid)
                .await
                .is_ok()
        );
    }

    #[test]
    fn platform_video_profiles_keep_native_codec_and_bandwidth_preferences() {
        let streams: Vec<super::DashStream> = serde_json::from_value(serde_json::json!([
            {"height":720,"bandwidth":900000,"codecs":"avc1.64001f","baseUrl":"https://cdn.test/avc720","mimeType":"video/mp4"},
            {"height":480,"bandwidth":500000,"codecs":"hvc1.1.6.L93.90","baseUrl":"https://cdn.test/hevc480","mimeType":"video/mp4"},
            {"height":360,"bandwidth":300000,"codecs":"avc1.64001e","baseUrl":"https://cdn.test/avc360","mimeType":"video/mp4"}
        ])).unwrap();
        let mac =
            super::BilibiliProvider::select_video_for_platform(&streams, 0, false, false).unwrap();
        let ios =
            super::BilibiliProvider::select_video_for_platform(&streams, 0, true, false).unwrap();
        assert_eq!(mac.video_url, "https://cdn.test/avc720");
        assert_eq!(ios.video_url, "https://cdn.test/hevc480");
        let car =
            super::BilibiliProvider::select_video_for_platform(&streams, 0, false, true).unwrap();
        assert_eq!(car.video_url, "https://cdn.test/avc360");
        let compatible_retry =
            super::BilibiliProvider::select_video_for_platform(&streams, 1080, false, true)
                .unwrap();
        assert_eq!(compatible_retry.video_url, car.video_url);
        assert!(crate::infrastructure::fragmented_mp4::prefer_segmented(
            1800,
            &mac.codecs
        ));
        assert!(crate::infrastructure::fragmented_mp4::prefer_segmented(
            1800,
            &ios.codecs
        ));
    }
    #[test]
    fn optional_loudness_metadata_preserves_dash_audio_and_is_bound_to_the_part() {
        for volume in [
            serde_json::Value::Null,
            serde_json::json!({"measured_i":-12,"measured_tp":0}),
            serde_json::json!({"measured_i":"broken"}),
            serde_json::json!("broken"),
        ] {
            let response = serde_json::json!({"volume":volume,"dash":{"audio":[{"id":30280,"baseUrl":"https://cdn.test/audio","bandwidth":192000}],"video":[]}});
            let dash = serde_json::from_value::<super::PlayData>(response)
                .unwrap()
                .into_dash("BVtest", 42)
                .unwrap();
            assert_eq!(dash.audio[0].id, 30280);
            assert_eq!(dash.audio[0].bandwidth, 192000);
            assert_eq!(
                dash.loudness.is_some(),
                volume["measured_i"].as_f64().is_some()
            );
            if let Some(d) = dash.loudness {
                assert!(d.valid_for("BVtest", 42));
                assert!(!d.valid_for("BVtest", 43));
                assert_eq!(d.gain_db(), -6.0);
            }
        }
    }

    #[test]
    fn dash_cache_never_outlives_a_signed_source_deadline() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let dash = |deadline| {
            serde_json::from_value::<super::DashData>(serde_json::json!({"audio":[{"baseUrl":format!("https://cdn.test/audio?deadline={deadline}")}]})).unwrap()
        };
        assert!(super::dash_cache_ttl(&dash(now + 45)) <= std::time::Duration::from_secs(15));
        assert_eq!(super::dash_cache_ttl(&dash(now + 600)), super::DASH_TTL);
        assert_eq!(
            super::dash_cache_ttl(&dash(now - 1)),
            std::time::Duration::ZERO
        );
    }

    #[test]
    fn suggestions_use_plain_values_and_ignore_invalid_or_duplicate_items() {
        let value = serde_json::json!({"code":0,"result":{"tag":[
            {"name":"<em>歌曲</em>","value":"歌曲精选"}, {"value":"歌曲精选"},
            {"term":"演唱会"}, {"value":" "}, {"name":"HTML only"}
        ]}});
        assert_eq!(super::suggestion_words(&value), vec!["歌曲精选", "演唱会"]);
        assert!(super::suggestion_words(&serde_json::json!({"code":-1})).is_empty());
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_search_suggestions() {
        let provider = super::BilibiliProvider::new().unwrap();
        let words = provider.search_suggestions("周杰伦").await.unwrap();
        assert!(!words.is_empty());
        assert!(words.len() <= 8);
        assert!(words.iter().all(|v| !v.contains("<em")));
    }
    use super::{clean_html, parse_danmaku, parse_duration};

    #[test]
    fn parses_variable_length_duration() {
        assert_eq!(parse_duration("04:12"), 252);
        assert_eq!(parse_duration("1:02:03"), 3723);
    }

    #[tokio::test]
    async fn favorite_reads_share_one_request_gate_across_provider_instances() {
        use axum::{Json, Router, routing::get};
        let times = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = times.clone();
        let app = Router::new().route(
            "/favorites",
            get(move || {
                observed.lock().unwrap().push(std::time::Instant::now());
                async { Json(serde_json::json!({"code":0,"data":{"value":1}})) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: super::Url = format!("http://{}/favorites", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let a = super::BilibiliProvider::new().unwrap();
        let b = super::BilibiliProvider::new().unwrap();
        let (x, y) = tokio::join!(
            a.favorite_data::<serde_json::Value>(url.clone()),
            b.favorite_data::<serde_json::Value>(url)
        );
        assert!(x.is_ok() && y.is_ok());
        let times = times.lock().unwrap();
        assert_eq!(times.len(), 2);
        assert!(times[1].duration_since(times[0]) >= std::time::Duration::from_millis(450));
        server.abort();
    }

    #[test]
    fn read_retry_policy_excludes_authentication_and_missing_content() {
        for code in [-352, -412, -509, -799] {
            assert!(
                super::ProviderError::Api {
                    code,
                    message: String::new()
                }
                .retryable_read()
            );
        }
        for code in [-101, -400, -404, 0] {
            assert!(
                !super::ProviderError::Api {
                    code,
                    message: String::new()
                }
                .retryable_read()
            );
        }
    }

    #[tokio::test]
    async fn mutation_accepts_null_acknowledgement_but_rejects_api_failure() {
        use super::{BilibiliProvider, Url};
        use axum::{Json, Router, routing::post};
        let app = Router::new()
            .route(
                "/ok",
                post(|| async { Json(serde_json::json!({"code":0,"data":null})) }),
            )
            .route(
                "/fail",
                post(|| async {
                    Json(serde_json::json!({"code":-101,"message":"not logged in","data":null}))
                }),
            );
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
        let provider = BilibiliProvider::new().unwrap();
        provider
            .set_session_cookie(Some("SESSDATA=test".into()))
            .await;
        let ok: Url = format!("http://{address}/ok").parse().unwrap();
        let fail: Url = format!("http://{address}/fail").parse().unwrap();
        assert!(
            provider
                .post_data::<serde_json::Value>(ok, &[])
                .await
                .unwrap()
                .is_null()
        );
        assert!(
            provider
                .post_data::<serde_json::Value>(fail, &[])
                .await
                .is_err()
        );
        server.abort();
    }

    #[tokio::test]
    async fn search_initializes_visitor_cookie_and_retries_412_only_once() {
        use super::{Arc, BilibiliProvider, COOKIE, HeaderMap, SET_COOKIE, Url};
        use axum::{
            Router,
            body::Body,
            http::{Response, StatusCode},
            routing::get,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        for failures in [0usize, 1, usize::MAX] {
            let homes = Arc::new(AtomicUsize::new(0));
            let searches = Arc::new(AtomicUsize::new(0));
            let home_count = homes.clone();
            let search_count = searches.clone();
            let router = Router::new()
                .route("/", get(move || {
                    let count = home_count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        Response::builder().header(SET_COOKIE, "buvid3=visitor-session; Path=/")
                            .body(Body::from("website")).unwrap()
                    }
                }))
                .route("/search", get(move |headers: HeaderMap| {
                    let count = search_count.clone();
                    async move {
                        let cookie = headers.get(COOKIE).unwrap().to_str().unwrap();
                        assert!(cookie.contains("buvid3=visitor-session"));
                        assert!(cookie.contains("SESSDATA=saved-login"));
                        let call = count.fetch_add(1, Ordering::SeqCst);
                        if call < failures { return Response::builder().status(StatusCode::PRECONDITION_FAILED).body(Body::empty()).unwrap(); }
                        Response::builder().header("content-type", "application/json")
                            .body(Body::from(r#"{"code":0,"message":"ok","data":{"page":1,"pagesize":20,"numResults":1,"result":[]}}"#)).unwrap()
                    }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            let provider = BilibiliProvider::new().unwrap();
            provider
                .set_session_cookie(Some("SESSDATA=saved-login".into()))
                .await;
            let web: Url = format!("http://{address}/").parse().unwrap();
            let search: Url = format!("http://{address}/search").parse().unwrap();
            let result = provider.search_response(search.clone(), web.clone()).await;
            assert_eq!(
                searches.load(Ordering::SeqCst),
                if failures == 0 { 1 } else { 2 }
            );
            assert_eq!(
                homes.load(Ordering::SeqCst),
                if failures == 0 { 1 } else { 2 }
            );
            if failures == usize::MAX {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap().num_results, 1);
                // An initialized provider does not reload the website for each keyword.
                provider.search_response(search, web).await.unwrap();
                assert_eq!(
                    homes.load(Ordering::SeqCst),
                    if failures == 0 { 1 } else { 2 }
                );
            }
            server.abort();
        }
    }

    #[test]
    fn strips_search_highlight_markup() {
        assert_eq!(
            clean_html("城市<em class=\"keyword\">音乐</em>&amp;夜"),
            "城市音乐&夜"
        );
    }

    #[test]
    fn exact_video_search_recognizes_ids_and_only_bilibili_video_links() {
        use super::{bvid_from_url, normalize_bvid, video_link};

        assert_eq!(
            normalize_bvid("bv1EAHyeKEkG").as_deref(),
            Some("BV1EAHyeKEkG")
        );
        assert!(normalize_bvid("陶喆 BV1EAHyeKEkG").is_none());
        for input in [
            "https://www.bilibili.com/video/BV1EAHyeKEkG/?p=2#t=12",
            "m.bilibili.com/video/BV1EAHyeKEkG",
        ] {
            assert_eq!(
                bvid_from_url(&video_link(input).unwrap()).as_deref(),
                Some("BV1EAHyeKEkG")
            );
        }
        assert_eq!(
            video_link("https://b23.tv/ba99").unwrap().host_str(),
            Some("b23.tv")
        );
        for input in [
            "https://www.bilibili.com.example/video/BV1EAHyeKEkG",
            "https://www.bilibili.com/video/BV1EAHyeKEkG/comments",
            "https://www.bilibili.com/?bvid=BV1EAHyeKEkG",
            "https://www.bilibili.com@other.example/video/BV1EAHyeKEkG",
            "https://b23.tv:1234/ba99",
        ] {
            assert!(video_link(input).is_none(), "{input}");
        }
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_exact_video_search() {
        let provider = super::BilibiliProvider::new().unwrap();
        let expected = "BV1EAHyeKEkG";
        for query in [
            expected,
            "https://www.bilibili.com/video/BV1EAHyeKEkG/?p=1",
            "https://b23.tv/BV1EAHyeKEkG",
        ] {
            let result = provider.search(query, 1, 20).await.unwrap();
            assert_eq!(result.total, 1);
            assert_eq!(result.items.len(), 1);
            let item = &result.items[0];
            assert_eq!(item.bvid, expected);
            assert!(
                !item.title.is_empty()
                    && !item.uploader_name.is_empty()
                    && !item.cover_url.is_empty()
            );
            assert!(item.duration_seconds > 0);
        }
        let second = provider.search(expected, 2, 20).await.unwrap();
        assert!(second.items.is_empty());
    }

    #[test]
    fn parses_danmaku_timing_style_and_escaped_text() {
        let items = parse_danmaku(r#"<i><d p="1.25,1,25,16777215,0,0,x,1">你好&amp;世界</d></i>"#);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].time_seconds, 1.25);
        assert_eq!(items[0].font_size, 25);
        assert_eq!(items[0].text, "你好&世界");
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_provider_resolves_search_parts_and_audio() {
        let provider = super::BilibiliProvider::new().expect("provider client");
        let search = provider
            .search("音乐", 1, 5)
            .await
            .expect("search response");
        assert!(!search.items.is_empty());

        let detail = provider
            .video_parts("BV1GJ411x7h7")
            .await
            .expect("video detail");
        let first = detail.parts.first().expect("at least one video part");
        let source = provider
            .playback_source(&detail.bvid, first.cid)
            .await
            .expect("audio source");
        assert!(source.audio_url.starts_with("https://"));
        assert!(source.bandwidth > 0);
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_provider_resolves_video_and_danmaku() {
        let provider = super::BilibiliProvider::new().expect("provider client");
        let detail = provider
            .video_parts("BV1GJ411x7h7")
            .await
            .expect("video detail");
        let first = detail.parts.first().expect("at least one video part");
        let video = provider
            .video_source(&detail.bvid, first.cid)
            .await
            .expect("video source");
        assert!(video.video_url.starts_with("https://"));
        assert!(
            !provider
                .danmaku(first.cid)
                .await
                .expect("danmaku")
                .is_empty()
        );
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_provider_generates_login_qr() {
        let provider = super::BilibiliProvider::new().expect("provider client");
        let login = provider.qr_login_generate().await.expect("login QR");
        assert!(!login.key.is_empty());
        assert!(login.url.starts_with("https://"));
    }

    #[tokio::test]
    #[ignore = "requires live Bilibili network access"]
    async fn live_provider_reads_comments_and_replies() {
        let provider = super::BilibiliProvider::new().expect("provider client");
        let detail = provider
            .video_parts("BV1GJ411x7h7")
            .await
            .expect("video detail");
        let page = provider.comments(detail.aid, 0).await.expect("comments");
        assert!(!page.items.is_empty());
        let first = &page.items[0];
        if first.reply_count > 0 {
            assert!(
                !provider
                    .comment_replies(detail.aid, first.root_id, 1)
                    .await
                    .expect("replies")
                    .is_empty()
            );
        }
    }
}
