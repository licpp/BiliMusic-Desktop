use super::domestic_music;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};
use thiserror::Error;
use tokio::sync::Mutex;

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("音乐资料服务连接失败，请稍后重试或切换来源")]
    Network(#[from] reqwest::Error),
    #[error("音乐资料服务暂时不可用，请稍后重试或切换来源")]
    Unavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCandidate {
    pub track_id: String,
    pub track_name: String,
    pub artist_name: String,
    pub collection_name: Option<String>,
    pub artwork_url: Option<String>,
    pub source: String,
}

#[derive(Deserialize)]
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
    // MusicBrainz permits one request per second per client IP.
    musicbrainz_gate: Mutex<Option<tokio::time::Instant>>,
}

impl MusicCatalogProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(8))
                .user_agent("BiliMusic/0.1.6 (https://github.com/licpp/BiliMusic-Desktop)")
                .build()?,
            musicbrainz_gate: Mutex::new(None),
        })
    }

    pub async fn search(
        &self,
        title: &str,
        artist: &str,
        source: &str,
    ) -> Result<Vec<CatalogCandidate>, CatalogError> {
        if source == "musicbrainz" {
            return self.search_musicbrainz(title, artist).await;
        }
        if source == "netease" || source == "qq" {
            return self.search_domestic(title, artist, source).await;
        }
        if source == "itunes" {
            return self.search_itunes(title, artist).await;
        }
        let (netease, qq, itunes) = tokio::join!(
            self.search_domestic(title, artist, "netease"),
            self.search_domestic(title, artist, "qq"),
            self.search_itunes(title, artist)
        );
        let mut items = vec![];
        let mut succeeded = false;
        // Interleave catalogs so one provider cannot crowd all others out of the result page.
        let mut sources = vec![];
        for result in [netease, qq, itunes] {
            if let Ok(found) = result {
                succeeded = true;
                sources.push(found.into_iter())
            }
        }
        for _ in 0..20 {
            for source in &mut sources {
                if let Some(item) = source.next() {
                    items.push(item)
                }
            }
        }
        if !items.is_empty() {
            return Ok(deduplicate(items));
        }
        match self.search_musicbrainz(title, artist).await {
            Ok(found) => Ok(found),
            Err(_) if succeeded => Ok(vec![]),
            Err(error) => Err(error),
        }
    }

    async fn search_domestic(
        &self,
        title: &str,
        artist: &str,
        source: &str,
    ) -> Result<Vec<CatalogCandidate>, CatalogError> {
        let keyword = format!("{title} {artist}");
        let songs = if source == "netease" {
            domestic_music::search_netease(
                &self.client,
                "https://music.163.com",
                keyword.trim(),
                12,
                true,
            )
            .await
        } else {
            domestic_music::search_qq(&self.client, "https://u.y.qq.com", keyword.trim(), 12).await
        }
        .map_err(|_| CatalogError::Unavailable)?;
        Ok(songs
            .into_iter()
            .map(|song| CatalogCandidate {
                track_id: format!("{source}:{}", song.id),
                track_name: song.name,
                artist_name: song.artist,
                collection_name: song.album,
                artwork_url: song.cover,
                source: if source == "netease" {
                    "网易云音乐".into()
                } else {
                    "QQ 音乐".into()
                },
            })
            .collect())
    }

    async fn search_itunes(
        &self,
        title: &str,
        artist: &str,
    ) -> Result<Vec<CatalogCandidate>, CatalogError> {
        let responses = tokio::join!(
            self.search_store(title, artist, "TW"),
            self.search_store(title, artist, "HK"),
            self.search_store(title, artist, "US")
        );
        let mut items = Vec::new();
        let mut first_error = None;
        let mut succeeded = false;
        for response in [responses.0, responses.1, responses.2] {
            match response {
                Ok(found) => {
                    succeeded = true;
                    items.extend(found);
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if !succeeded {
            return Err(first_error.expect("three failed stores"));
        }
        Ok(deduplicate(items))
    }

    async fn search_store(
        &self,
        title: &str,
        artist: &str,
        country: &str,
    ) -> Result<Vec<CatalogCandidate>, CatalogError> {
        let mut url = Url::parse("https://itunes.apple.com/search").expect("static catalog URL");
        url.query_pairs_mut()
            .append_pair("term", &format!("{title} {artist}"))
            .append_pair("country", country)
            .append_pair("entity", "song")
            .append_pair("limit", "20");
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
                track_id: format!("itunes:{country}:{}", item.track_id),
                track_name: item.track_name,
                artist_name: item.artist_name,
                collection_name: item.collection_name,
                artwork_url: item
                    .artwork_url100
                    .map(|url| url.replace("100x100bb", "600x600bb")),
                source: format!("iTunes · {country}"),
            })
            .collect())
    }

    async fn search_musicbrainz(
        &self,
        title: &str,
        artist: &str,
    ) -> Result<Vec<CatalogCandidate>, CatalogError> {
        let mut gate = self.musicbrainz_gate.lock().await;
        if let Some(last) = *gate {
            tokio::time::sleep_until(last + Duration::from_secs(1)).await;
        }
        *gate = Some(tokio::time::Instant::now());
        let mut url =
            Url::parse("https://musicbrainz.org/ws/2/recording").expect("static catalog URL");
        let mut query = format!("recording:\"{}\"", escape_query(title));
        if !artist.is_empty() {
            query.push_str(&format!(" AND artist:\"{}\"", escape_query(artist)));
        }
        url.query_pairs_mut()
            .append_pair("query", &query)
            .append_pair("fmt", "json")
            .append_pair("limit", "15");
        let response: serde_json::Value = self
            .client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        drop(gate);
        let mut candidates = Vec::new();
        for recording in response["recordings"].as_array().into_iter().flatten() {
            let Some(id) = recording["id"].as_str() else {
                continue;
            };
            let Some(name) = recording["title"].as_str() else {
                continue;
            };
            let artist_name = recording["artist-credit"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|credit| {
                    format!(
                        "{}{}",
                        credit["name"]
                            .as_str()
                            .or_else(|| credit["artist"]["name"].as_str())
                            .unwrap_or(""),
                        credit["joinphrase"].as_str().unwrap_or("")
                    )
                })
                .collect::<String>();
            for release in recording["releases"]
                .as_array()
                .into_iter()
                .flatten()
                .take(3)
            {
                let Some(release_id) = release["id"].as_str() else {
                    continue;
                };
                if uuid::Uuid::parse_str(release_id).is_err() {
                    continue;
                }
                candidates.push(CatalogCandidate {
                    track_id: format!("musicbrainz:{id}:{release_id}"),
                    track_name: name.into(),
                    artist_name: artist_name.clone(),
                    collection_name: release["title"].as_str().map(str::to_owned),
                    artwork_url: None,
                    source: "MusicBrainz".into(),
                });
            }
        }
        let mut candidates = deduplicate(candidates);
        candidates.truncate(8);
        // Only offer an artwork URL after the archive confirms a front cover exists.
        let covers = futures_util::future::join_all(candidates.iter().map(|candidate| async {
            let release_id = candidate.track_id.rsplit(':').next().unwrap_or("");
            let url = format!("https://coverartarchive.org/release/{release_id}");
            let response: serde_json::Value = self
                .client
                .get(url)
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .json()
                .await
                .ok()?;
            let image = response["images"]
                .as_array()?
                .iter()
                .find(|image| image["front"].as_bool() == Some(true))?;
            image["thumbnails"]["500"]
                .as_str()
                .or_else(|| image["image"].as_str())
                .map(|url| url.replacen("http://", "https://", 1))
        }))
        .await;
        for (candidate, cover) in candidates.iter_mut().zip(covers) {
            candidate.artwork_url = cover;
        }
        candidates.sort_by_key(|candidate| candidate.artwork_url.is_none());
        Ok(candidates)
    }
}

fn escape_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn deduplicate(items: Vec<CatalogCandidate>) -> Vec<CatalogCandidate> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|item| {
            seen.insert((
                item.track_name.to_lowercase(),
                item.artist_name.to_lowercase(),
                item.collection_name.as_deref().unwrap_or("").to_lowercase(),
            ))
        })
        .take(40)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_literals_and_cross_store_duplicates_are_safe() {
        assert_eq!(escape_query("a\"b\\c"), "a\\\"b\\\\c");
        let candidate = CatalogCandidate {
            track_id: "itunes:1".into(),
            track_name: "晴天".into(),
            artist_name: "周杰倫".into(),
            collection_name: Some("葉惠美".into()),
            artwork_url: Some("cover".into()),
            source: "iTunes · TW".into(),
        };
        let mut duplicate = candidate.clone();
        duplicate.track_id = "itunes:2".into();
        let mut live = candidate.clone();
        live.collection_name = Some("Live".into());
        let results = deduplicate(vec![candidate, duplicate, live]);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].source, "iTunes · TW");
    }
    #[tokio::test]
    #[ignore = "requires live domestic music catalog access"]
    async fn live_domestic_catalog_has_album_and_loadable_artwork() {
        let provider = MusicCatalogProvider::new().unwrap();
        for source in ["netease", "qq"] {
            let items = provider.search("晴天", "周杰伦", source).await.unwrap();
            let candidate = items
                .iter()
                .find(|s| {
                    s.track_name == "晴天" && s.collection_name.is_some() && s.artwork_url.is_some()
                })
                .expect("album and cover");
            let response = provider
                .client
                .get(candidate.artwork_url.as_ref().unwrap())
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            assert!(
                response
                    .headers()
                    .get("content-type")
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("image/")
            );
            println!(
                "{source}: {} / {} / artwork HTTP {}",
                candidate.track_name,
                candidate.collection_name.as_ref().unwrap(),
                response.status()
            );
        }
    }
    #[tokio::test]
    #[ignore = "requires live catalog network access"]
    async fn live_catalog_returns_jay_chou_album_and_artwork() {
        let provider = MusicCatalogProvider::new().unwrap();
        let results = provider.search("晴天", "周杰伦", "itunes").await.unwrap();
        assert!(results.iter().any(|item| item.track_name == "晴天"
            && item.collection_name.as_deref() == Some("葉惠美")
            && item.artwork_url.is_some()));
    }
}
