use reqwest::{
    Client, Url,
    header::{ACCEPT, ACCEPT_LANGUAGE, HeaderMap, HeaderValue, ORIGIN, REFERER},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::time::Duration;
use thiserror::Error;

const API_ORIGIN: &str = "https://api.bilibili.com";
const WEB_ORIGIN: &str = "https://www.bilibili.com/";

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
    #[error("弹幕数据解码失败: {0}")]
    DanmakuDecode(String),
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
    pub bvid: String,
    pub aid: i64,
    pub title: String,
    pub cover_url: String,
    pub uploader_name: String,
    pub uploader_id: i64,
    pub parts: Vec<VideoPart>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPart {
    pub cid: i64,
    pub page: u32,
    pub title: String,
    pub duration_seconds: u64,
    pub cover_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSource {
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

#[derive(Deserialize)]
struct Envelope<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
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
    bvid: String,
    aid: i64,
    title: String,
    pic: String,
    owner: Owner,
    #[serde(default)]
    pages: Vec<PageData>,
}

#[derive(Deserialize)]
struct Owner {
    mid: i64,
    name: String,
}

#[derive(Deserialize)]
struct PageData {
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
}

#[derive(Deserialize)]
struct DashData {
    #[serde(default)]
    audio: Vec<DashStream>,
    #[serde(default)]
    video: Vec<DashStream>,
}

#[derive(Deserialize)]
struct DashStream {
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

pub struct BilibiliProvider {
    client: Client,
}

impl BilibiliProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
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
        let client = Client::builder()
            .cookie_store(true)
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
            .build()?;
        Ok(Self { client })
    }

    pub async fn search(
        &self,
        keyword: &str,
        page: u32,
        page_size: u32,
    ) -> Result<SearchPage, ProviderError> {
        let mut url = self.api_url("/x/web-interface/search/type");
        url.query_pairs_mut()
            .append_pair("search_type", "video")
            .append_pair("keyword", keyword)
            .append_pair("page", &page.max(1).to_string())
            .append_pair("pagesize", &page_size.clamp(1, 50).to_string());
        let data: SearchData = self.get_data(url).await?;
        Ok(SearchPage {
            page: data.page.max(1),
            page_size: data.page_size.max(1),
            total: data.num_results,
            items: data
                .result
                .into_iter()
                .map(|item| SearchItem {
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

    pub async fn video_parts(&self, bvid: &str) -> Result<VideoParts, ProviderError> {
        let mut url = self.api_url("/x/web-interface/view");
        url.query_pairs_mut().append_pair("bvid", bvid);
        let detail: DetailData = self.get_data(url).await?;
        let fallback_cover = normalize_url(&detail.pic);
        let title = detail.title;
        let parts = detail
            .pages
            .into_iter()
            .map(|part| VideoPart {
                cid: part.cid,
                page: part.page,
                title: if part.part.trim().is_empty() {
                    title.clone()
                } else {
                    part.part
                },
                duration_seconds: part.duration,
                cover_url: if part.first_frame.is_empty() {
                    fallback_cover.clone()
                } else {
                    normalize_url(&part.first_frame)
                },
            })
            .collect();
        Ok(VideoParts {
            bvid: detail.bvid,
            aid: detail.aid,
            title,
            cover_url: fallback_cover,
            uploader_name: detail.owner.name,
            uploader_id: detail.owner.mid,
            parts,
        })
    }

    pub async fn playback_source(
        &self,
        bvid: &str,
        cid: i64,
    ) -> Result<PlaybackSource, ProviderError> {
        let mut url = self.api_url("/x/player/playurl");
        url.query_pairs_mut()
            .append_pair("bvid", bvid)
            .append_pair("cid", &cid.to_string())
            .append_pair("qn", "80")
            .append_pair("fnver", "0")
            .append_pair("fnval", "16")
            .append_pair("fourk", "1");
        let play: PlayData = self.get_data(url).await?;
        let stream = play
            .dash
            .and_then(|dash| dash.audio.into_iter().max_by_key(|stream| stream.bandwidth))
            .ok_or(ProviderError::NoAudio)?;
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
        Ok(PlaybackSource {
            audio_url,
            backup_urls,
            mime_type,
            codecs: stream.codecs,
            bandwidth: stream.bandwidth,
        })
    }

    pub async fn video_source(&self, bvid: &str, cid: i64) -> Result<VideoSource, ProviderError> {
        let mut url = self.api_url("/x/player/playurl");
        url.query_pairs_mut()
            .append_pair("bvid", bvid)
            .append_pair("cid", &cid.to_string())
            .append_pair("qn", "80")
            .append_pair("fnver", "0")
            .append_pair("fnval", "16")
            .append_pair("fourk", "0");
        let play: PlayData = self.get_data(url).await?;
        let streams = play.dash.map(|dash| dash.video).unwrap_or_default();
        let stream = streams
            .iter()
            .filter(|item| item.codecs.starts_with("avc"))
            .max_by_key(|item| item.bandwidth)
            .or_else(|| streams.iter().max_by_key(|item| item.bandwidth))
            .ok_or(ProviderError::NoVideo)?;
        Ok(VideoSource {
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
        })
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
        let envelope: Envelope<T> = self
            .client
            .get(url)
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
        envelope.data.ok_or_else(|| ProviderError::Api {
            code: -1,
            message: "响应缺少 data".into(),
        })
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

#[cfg(test)]
mod tests {
    use super::{clean_html, parse_danmaku, parse_duration};

    #[test]
    fn parses_variable_length_duration() {
        assert_eq!(parse_duration("04:12"), 252);
        assert_eq!(parse_duration("1:02:03"), 3723);
    }

    #[test]
    fn strips_search_highlight_markup() {
        assert_eq!(
            clean_html("城市<em class=\"keyword\">音乐</em>&amp;夜"),
            "城市音乐&夜"
        );
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
}
