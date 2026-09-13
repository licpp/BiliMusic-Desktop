use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

const API_ORIGIN: &str = "https://lrclib.net";

#[derive(Debug, Error)]
pub enum LyricsProviderError {
    #[error("歌词服务请求失败: {0}")]
    Network(#[from] reqwest::Error),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricCandidate {
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

pub struct LrclibProvider {
    client: Client,
}

impl LrclibProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(15))
                .user_agent("Resonance/0.1 (clean-room desktop music client)")
                .build()?,
        })
    }

    pub async fn search(
        &self,
        title: &str,
        artist: Option<&str>,
    ) -> Result<Vec<LyricCandidate>, LyricsProviderError> {
        let mut url = Url::parse(&format!("{API_ORIGIN}/api/search")).expect("static lyrics URL");
        if let Some(artist) = artist.filter(|value| !value.trim().is_empty()) {
            url.query_pairs_mut()
                .append_pair("track_name", title)
                .append_pair("artist_name", artist);
        } else {
            url.query_pairs_mut().append_pair("q", title);
        }
        Ok(self
            .client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
}

#[cfg(test)]
mod tests {
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
