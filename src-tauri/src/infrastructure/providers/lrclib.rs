use super::domestic_music::{self, MusicLyrics, MusicSong};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translated_lyrics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub romanized_lyrics: Option<String>,
}

fn default_provider() -> String {
    "lrclib".into()
}

pub struct LrclibProvider {
    client: Client,
    api_origin: String,
    fallback_origin: String,
    qq_origin: String,
    qq_lyric_origin: String,
    retry_delay: Duration,
}

impl LrclibProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(6))
                .user_agent("Mozilla/5.0 BiliMusic/0.2.8")
                .build()?,
            api_origin: API_ORIGIN.into(),
            fallback_origin: "https://music.163.com".into(),
            qq_origin: "https://u.y.qq.com".into(),
            qq_lyric_origin: "https://u.y.qq.com".into(),
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
        let lyrics = match provider {
            "netease" => {
                domestic_music::netease_lyrics(&self.client, &self.fallback_origin, id).await
            }
            "qq" => domestic_music::qq_lyrics(&self.client, &self.qq_lyric_origin, id).await,
            _ => return Ok(None),
        }
        .map_err(|_| LyricsProviderError::Unavailable)?;
        Ok(domestic_candidate(provider, id, lyrics, None))
    }

    pub async fn search(
        &self,
        title: &str,
        artist: Option<&str>,
    ) -> Result<Vec<LyricCandidate>, LyricsProviderError> {
        // Search each catalog once. A slow or unavailable source cannot exclude working sources.
        let budget = Duration::from_secs(8);
        let (primary, netease, qq) = tokio::join!(
            tokio::time::timeout(budget, self.search_primary(title, artist)),
            tokio::time::timeout(budget, self.search_fallback(title, artist)),
            tokio::time::timeout(budget, self.search_domestic("qq", title, artist))
        );
        let mut candidates = vec![];
        let mut available = false;
        for result in [primary, netease, qq] {
            if let Ok(Ok(found)) = result {
                available = true;
                candidates.extend(found)
            }
        }
        if !available {
            return Err(LyricsProviderError::Unavailable);
        }
        Ok(candidates)
    }

    async fn search_primary(
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
        match primary_failure {
            Some(error) => Err(LyricsProviderError::Network(error)),
            None => Ok(vec![]),
        }
    }

    async fn search_fallback(
        &self,
        title: &str,
        artist: Option<&str>,
    ) -> Result<Vec<LyricCandidate>, LyricsProviderError> {
        self.search_domestic("netease", title, artist).await
    }
    async fn search_domestic(
        &self,
        provider: &str,
        title: &str,
        artist: Option<&str>,
    ) -> Result<Vec<LyricCandidate>, LyricsProviderError> {
        let keyword = format!("{} {}", title.trim(), artist.unwrap_or("").trim());
        let songs = if provider == "netease" {
            domestic_music::search_netease(
                &self.client,
                &self.fallback_origin,
                keyword.trim(),
                3,
                false,
            )
            .await
        } else {
            domestic_music::search_qq(&self.client, &self.qq_origin, keyword.trim(), 3).await
        }
        .map_err(|_| LyricsProviderError::Unavailable)?;
        let responses = futures_util::future::join_all(songs.into_iter().map(|song| async move {
            let result = if provider == "netease" {
                domestic_music::netease_lyrics(&self.client, &self.fallback_origin, song.id).await
            } else {
                domestic_music::qq_lyrics(&self.client, &self.qq_lyric_origin, song.id).await
            };
            result.map(|lyrics| domestic_candidate(provider, song.id, lyrics, Some(song)))
        }))
        .await;
        let mut candidates = vec![];
        let mut failed = false;
        for result in responses {
            match result {
                Ok(Some(candidate)) => candidates.push(candidate),
                Ok(None) => {}
                Err(_) => failed = true,
            }
        }
        if candidates.is_empty() && failed {
            return Err(LyricsProviderError::Unavailable);
        }
        Ok(candidates)
    }
}
fn domestic_candidate(
    provider: &str,
    id: i64,
    lyrics: MusicLyrics,
    song: Option<MusicSong>,
) -> Option<LyricCandidate> {
    let original = lyrics.original.filter(|s| !s.trim().is_empty())?;
    Some(LyricCandidate {
        provider: provider.into(),
        id,
        track_name: song.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
        artist_name: song.as_ref().map(|s| s.artist.clone()).unwrap_or_default(),
        album_name: song
            .as_ref()
            .and_then(|s| s.album.clone())
            .unwrap_or_default(),
        duration: song.as_ref().map(|s| s.duration).unwrap_or_default(),
        instrumental: false,
        plain_lyrics: None,
        synced_lyrics: Some(original),
        translated_lyrics: lyrics.translated,
        romanized_lyrics: lyrics.romanized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        http::StatusCode,
        routing::{get, post},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    async fn fixture(
        failures: usize,
        fallback: bool,
        qq: bool,
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
                .route("/api/song/lyric", get(|| async { Json(serde_json::json!({"code":200,"lrc":{"lyric":"[00:01.00]fallback test line"},"tlyric":{"lyric":"[00:01.00]translated line"},"romalrc":{"lyric":"[00:01.00]romanized line"}})) }));
        }
        if qq {
            router=router.route("/cgi-bin/musics.fcg",post(||async{Json(serde_json::json!({"code":0,"music.search.SearchCgiService":{"code":0,"data":{"body":{"song":{"list":[{"id":3,"name":"test","interval":120,"singer":[{"name":"artist"}],"album":{"name":"album","mid":"abc123"}}]}}}}}))}))
                .route("/cgi-bin/musicu.fcg",get(||async{Json(serde_json::json!({"code":0,"req":{"code":0,"data":{"lyric":"[00:01.00]QQ line","trans":"[00:01.00]translated line"}}}))}));
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut provider = LrclibProvider::new().unwrap();
        provider.api_origin = origin.clone();
        provider.fallback_origin = origin.clone();
        provider.qq_origin = origin.clone();
        provider.qq_lyric_origin = origin;
        provider.retry_delay = Duration::ZERO;
        (provider, count, server)
    }

    #[tokio::test]
    async fn retries_temporary_503_before_returning_results() {
        let (provider, count, server) = fixture(1, false, false).await;
        let results = provider.search("test", None).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(results[0].provider, "lrclib");
        server.abort();
    }

    #[tokio::test]
    async fn switches_provider_when_primary_stays_unavailable() {
        let (provider, count, server) = fixture(usize::MAX, true, false).await;
        let results = provider.search("test", None).await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert_eq!(results[0].provider, "netease");
        assert_eq!(results[0].duration, 120.0);
        assert!(results[0].synced_lyrics.is_some());
        server.abort();
    }

    #[tokio::test]
    async fn all_services_down_returns_actionable_message_without_raw_url() {
        let (provider, count, server) = fixture(usize::MAX, false, false).await;
        let message = provider.search("test", None).await.unwrap_err().to_string();
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert!(message.contains("手动导入"));
        assert!(!message.contains("http"));
        server.abort();
    }

    #[tokio::test]
    async fn qq_fallback_and_domestic_supplements_restore_by_provider_id() {
        let (provider, _, server) = fixture(usize::MAX, false, true).await;
        let results = provider.search("test", Some("artist")).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].provider, "qq");
        assert_eq!(
            results[0].translated_lyrics.as_deref(),
            Some("[00:01.00]translated line")
        );
        let restored = provider.selected("qq", 3).await.unwrap().unwrap();
        assert_eq!(restored.translated_lyrics, results[0].translated_lyrics);
        server.abort();
        let (provider, _, server) = fixture(0, true, false).await;
        let selected = provider.selected("netease", 2).await.unwrap().unwrap();
        assert!(selected.translated_lyrics.is_some());
        assert!(selected.romanized_lyrics.is_some());
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires live domestic music catalog and lyric access"]
    async fn live_domestic_lyrics_have_translation_and_romanization() {
        fn times(text: &str) -> Vec<f64> {
            text.lines()
                .filter_map(|line| {
                    let stamp = line.strip_prefix('[')?.split_once(']')?.0;
                    let (minutes, seconds) = stamp.split_once(':')?;
                    Some(
                        minutes.parse::<f64>().ok()? * 60000.0
                            + seconds.parse::<f64>().ok()? * 1000.0,
                    )
                })
                .collect()
        }
        let provider = LrclibProvider::new().unwrap();
        for source in ["netease", "qq"] {
            let results = provider
                .search_domestic(source, "Lemon", Some("米津玄師"))
                .await
                .unwrap();
            let candidate = results
                .iter()
                .find(|v| v.track_name == "Lemon" && v.translated_lyrics.is_some())
                .expect("original and translated lyrics");
            assert!(
                candidate
                    .synced_lyrics
                    .as_ref()
                    .is_some_and(|s| s.contains('['))
            );
            assert!(candidate.romanized_lyrics.is_some());
            let original = times(candidate.synced_lyrics.as_ref().unwrap());
            for supplement in [&candidate.translated_lyrics, &candidate.romanized_lyrics] {
                let extra = times(supplement.as_ref().unwrap());
                let aligned = extra
                    .iter()
                    .filter(|t| original.iter().any(|o| (o - *t).abs() <= 120.0))
                    .count();
                assert!(
                    aligned >= extra.len() / 2 && aligned >= 8,
                    "supplement timestamps align with original lyrics"
                );
            }
            println!(
                "{source}: id={}, translated={}, romanized={}",
                candidate.id,
                candidate.translated_lyrics.is_some(),
                candidate.romanized_lyrics.is_some()
            );
        }
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
