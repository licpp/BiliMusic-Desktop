use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

const API_ORIGIN: &str = "https://lrclib.net";

#[derive(Debug, Error)]
pub enum LyricsProviderError {
    #[error("歌词服务连接失败，请稍后重试或手动导入歌词")]
    Network(#[from] reqwest::Error),
    #[error("歌词服务暂时不可用，请稍后重试或手动导入歌词")]
    Unavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricCandidate {
    #[serde(default = "default_provider")]
    pub provider: String,
    pub id: i64,
    #[serde(default)]
    pub track_name: String,
    #[serde(default)]
    pub artist_name: String,
    #[serde(default)]
    pub album_name: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub instrumental: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}

fn default_provider() -> String {
    "lrclib".into()
}

#[derive(Deserialize)]
struct SearchResponse {
    code: i64,
    result: Option<SearchSongs>,
}
#[derive(Deserialize)]
struct SearchSongs {
    #[serde(default)]
    songs: Vec<Song>,
}
#[derive(Deserialize)]
struct Song {
    id: i64,
    name: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    artists: Vec<Artist>,
    album: Option<Artist>,
}
#[derive(Deserialize)]
struct Artist {
    name: String,
}
#[derive(Deserialize)]
struct SongLyrics {
    code: i64,
    lrc: Option<LyricText>,
}
#[derive(Deserialize)]
struct LyricText {
    lyric: Option<String>,
}

pub struct LrclibProvider {
    client: Client,
    api_origin: String,
    fallback_origin: String,
    retry_delay: Duration,
}

impl LrclibProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(6))
                .user_agent("Resonance/0.1 (clean-room desktop music client)")
                .build()?,
            api_origin: API_ORIGIN.into(),
            fallback_origin: "https://music.163.com".into(),
            retry_delay: Duration::from_millis(400),
        })
    }

    pub async fn selected(
        &self,
        provider: &str,
        id: i64,
    ) -> Result<Option<LyricCandidate>, LyricsProviderError> {
        if id <= 0 {
            return Ok(None);
        }
        if provider == "lrclib" {
            let response = self
                .client
                .get(format!("{}/api/get/{id}", self.api_origin))
                .send()
                .await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            return Ok(Some(response.error_for_status()?.json().await?));
        }
        if provider == "netease" {
            let response: SongLyrics = self
                .client
                .get(format!("{}/api/song/lyric", self.fallback_origin))
                .query(&[
                    ("id", id.to_string()),
                    ("lv", "-1".into()),
                    ("kv", "-1".into()),
                    ("tv", "-1".into()),
                ])
                .header("Referer", "https://music.163.com/")
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            if response.code != 200 {
                return Ok(None);
            }
            return Ok(response
                .lrc
                .and_then(|v| v.lyric)
                .map(|text| LyricCandidate {
                    provider: provider.into(),
                    id,
                    track_name: String::new(),
                    artist_name: String::new(),
                    album_name: String::new(),
                    duration: 0.0,
                    instrumental: false,
                    plain_lyrics: None,
                    synced_lyrics: Some(text),
                }));
        }
        Ok(None)
    }

    pub async fn search(
        &self,
        title: &str,
        artist: Option<&str>,
    ) -> Result<Vec<LyricCandidate>, LyricsProviderError> {
        let mut url = Url::parse(&format!("{}/api/search", self.api_origin)).expect("lyrics URL");
        if let Some(artist) = artist.filter(|value| !value.trim().is_empty()) {
            url.query_pairs_mut()
                .append_pair("track_name", title)
                .append_pair("artist_name", artist);
        } else {
            url.query_pairs_mut().append_pair("q", title);
        }
        let mut primary_failure = None;
        for attempt in 0..3 {
            match self
                .client
                .get(url.clone())
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
            {
                Ok(response) => match response.json::<Vec<LyricCandidate>>().await {
                    Ok(results) if !results.is_empty() => return Ok(results),
                    Ok(_) => break,
                    Err(error) => {
                        primary_failure = Some(error);
                        break;
                    }
                },
                Err(error) => {
                    let retryable = error.is_timeout()
                        || error.is_connect()
                        || error.status().is_some_and(|status| {
                            status.is_server_error()
                                || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                        });
                    primary_failure = Some(error);
                    if !retryable || attempt == 2 {
                        break;
                    }
                    tokio::time::sleep(self.retry_delay * (attempt + 1)).await;
                }
            }
        }
        match self.search_fallback(title, artist).await {
            Ok(results) if !results.is_empty() => Ok(results),
            Ok(_) if primary_failure.is_none() => Ok(vec![]),
            _ => Err(LyricsProviderError::Unavailable),
        }
    }

    async fn search_fallback(
        &self,
        title: &str,
        artist: Option<&str>,
    ) -> Result<Vec<LyricCandidate>, LyricsProviderError> {
        let keyword = format!("{} {}", title.trim(), artist.unwrap_or("").trim());
        let mut url = Url::parse(&format!("{}/api/search/get/web", self.fallback_origin))
            .expect("fallback search URL");
        url.query_pairs_mut()
            .append_pair("s", keyword.trim())
            .append_pair("type", "1")
            .append_pair("limit", "3");
        let response: SearchResponse = self
            .client
            .get(url)
            .header("Referer", "https://music.163.com/")
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if response.code != 200 {
            return Err(LyricsProviderError::Unavailable);
        }
        let mut tasks = tokio::task::JoinSet::new();
        for (index, song) in response
            .result
            .map(|result| result.songs)
            .unwrap_or_default()
            .into_iter()
            .take(3)
            .enumerate()
        {
            let client = self.client.clone();
            let mut url = Url::parse(&format!("{}/api/song/lyric", self.fallback_origin))
                .expect("fallback lyrics URL");
            url.query_pairs_mut()
                .append_pair("id", &song.id.to_string())
                .append_pair("lv", "-1")
                .append_pair("kv", "-1")
                .append_pair("tv", "-1");
            tasks.spawn(async move {
                let response: SongLyrics = client
                    .get(url)
                    .header("Referer", "https://music.163.com/")
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                let candidate = response
                    .lrc
                    .and_then(|lyric| lyric.lyric)
                    .filter(|text| !text.trim().is_empty())
                    .filter(|_| response.code == 200)
                    .map(|text| LyricCandidate {
                        provider: "netease".into(),
                        id: song.id,
                        track_name: song.name,
                        artist_name: song
                            .artists
                            .into_iter()
                            .map(|artist| artist.name)
                            .collect::<Vec<_>>()
                            .join(" / "),
                        album_name: song.album.map(|album| album.name).unwrap_or_default(),
                        duration: song.duration / 1000.0,
                        instrumental: false,
                        plain_lyrics: None,
                        synced_lyrics: Some(text),
                    });
                Ok::<_, reqwest::Error>((index, candidate))
            });
        }
        let mut candidates = vec![];
        let mut failed = false;
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok((index, Some(candidate)))) => candidates.push((index, candidate)),
                Ok(Ok(_)) => {}
                _ => failed = true,
            }
        }
        if candidates.is_empty() && failed {
            return Err(LyricsProviderError::Unavailable);
        }
        candidates.sort_by_key(|(index, _)| *index);
        Ok(candidates
            .into_iter()
            .map(|(_, candidate)| candidate)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::StatusCode, routing::get};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    async fn fixture(
        failures: usize,
        fallback: bool,
    ) -> (
        LrclibProvider,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let count = Arc::new(AtomicUsize::new(0));
        let attempts = count.clone();
        let mut router = Router::new().route("/api/search", get(move || {
            let attempts = attempts.clone();
            async move {
                if attempts.fetch_add(1, Ordering::SeqCst) < failures { (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({}))) }
                else { (StatusCode::OK, Json(serde_json::json!([{"id":1,"trackName":"test","syncedLyrics":"[00:01.00]test line"}]))) }
            }
        }));
        if fallback {
            router = router.route("/api/search/get/web", get(|| async { Json(serde_json::json!({"code":200,"result":{"songs":[{"id":2,"name":"test","duration":120000,"artists":[{"name":"artist"}],"album":{"name":"album"}}]}})) }))
                .route("/api/song/lyric", get(|| async { Json(serde_json::json!({"code":200,"lrc":{"lyric":"[00:01.00]fallback test line"}})) }));
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut provider = LrclibProvider::new().unwrap();
        provider.api_origin = origin.clone();
        provider.fallback_origin = origin;
        provider.retry_delay = Duration::ZERO;
        (provider, count, server)
    }

    #[tokio::test]
    async fn retries_temporary_503_before_returning_results() {
        let (provider, count, server) = fixture(1, false).await;
        let results = provider.search("test", None).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(results[0].provider, "lrclib");
        server.abort();
    }

    #[tokio::test]
    async fn switches_provider_when_primary_stays_unavailable() {
        let (provider, count, server) = fixture(usize::MAX, true).await;
        let results = provider.search("test", None).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert_eq!(results[0].provider, "netease");
        assert_eq!(results[0].duration, 120.0);
        assert!(results[0].synced_lyrics.is_some());
        server.abort();
    }

    #[tokio::test]
    async fn all_services_down_returns_actionable_message_without_raw_url() {
        let (provider, count, server) = fixture(usize::MAX, false).await;
        let message = provider.search("test", None).await.unwrap_err().to_string();
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert!(message.contains("手动导入"));
        assert!(!message.contains("http"));
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires live NetEase network access"]
    async fn live_fallback_returns_chinese_lyrics() {
        let provider = LrclibProvider::new().unwrap();
        let results = provider
            .search_fallback("人间", Some("王菲"))
            .await
            .unwrap();
        assert!(
            results
                .iter()
                .any(|candidate| candidate.synced_lyrics.is_some())
        );
        assert!(
            results
                .iter()
                .all(|candidate| candidate.provider == "netease")
        );
    }

    #[tokio::test]
    #[ignore = "requires live LRCLIB network access"]
    async fn live_search_returns_synced_candidates() {
        let provider = super::LrclibProvider::new().unwrap();
        let results = provider
            .search("Yesterday", Some("The Beatles"))
            .await
            .unwrap();
        assert!(
            results
                .iter()
                .any(|candidate| candidate.synced_lyrics.is_some())
        );
    }
}
