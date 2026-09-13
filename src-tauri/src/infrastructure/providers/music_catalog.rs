use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("音乐资料服务请求失败: {0}")]
    Network(#[from] reqwest::Error),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCandidate {
    pub track_id: i64,
    pub track_name: String,
    pub artist_name: String,
    pub collection_name: Option<String>,
    pub artwork_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    results: Vec<RawCandidate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCandidate {
    track_id: i64,
    track_name: String,
    artist_name: String,
    collection_name: Option<String>,
    artwork_url100: Option<String>,
}

pub struct MusicCatalogProvider {
    client: Client,
}

impl MusicCatalogProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent("Resonance/0.1")
                .build()?,
        })
    }

    pub async fn search(
        &self,
        title: &str,
        artist: &str,
    ) -> Result<Vec<CatalogCandidate>, CatalogError> {
        let mut url = Url::parse("https://itunes.apple.com/search").expect("static catalog URL");
        url.query_pairs_mut()
            .append_pair("term", &format!("{title} {artist}"))
            .append_pair("entity", "song")
            .append_pair("limit", "10");
        let response: SearchResponse = self
            .client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(response
            .results
            .into_iter()
            .map(|item| CatalogCandidate {
                track_id: item.track_id,
                track_name: item.track_name,
                artist_name: item.artist_name,
                collection_name: item.collection_name,
                artwork_url: item
                    .artwork_url100
                    .map(|url| url.replace("100x100bb", "600x600bb")),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "requires live catalog network access"]
    async fn live_catalog_returns_album_and_artwork() {
        let provider = super::MusicCatalogProvider::new().unwrap();
        let results = provider.search("Yesterday", "The Beatles").await.unwrap();
        assert!(
            results
                .iter()
                .any(|item| item.collection_name.is_some() && item.artwork_url.is_some())
        );
    }
}
