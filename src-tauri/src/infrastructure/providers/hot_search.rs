use super::bilibili::{BilibiliProvider, ProviderError};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};
use thiserror::Error;
use tokio::fs;
use tokio::sync::Mutex;

const FRESH_FOR: Duration = Duration::from_secs(30 * 60);
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60);
const BILIBILI_LIMIT: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HotSearchBadge {
    Hot,
    New,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct HotSearchItem {
    keyword: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    badge: Option<HotSearchBadge>,
}

#[derive(Serialize)]
pub struct HotSearchChart {
    items: Vec<HotSearchItem>,
    stale: bool,
}

#[derive(Debug, Error)]
pub enum HotSearchError {
    #[error("热搜暂时不可用")]
    Unavailable,
    #[error(transparent)]
    Bilibili(#[from] ProviderError),
}

#[derive(Default)]
struct ChartCache {
    success: Option<StoredChart>,
    failure: Option<Instant>,
}

#[derive(Serialize, Deserialize)]
struct StoredChart {
    fetched_at: SystemTime,
    #[serde(alias = "keywords", deserialize_with = "deserialize_chart_items")]
    items: Vec<HotSearchItem>,
}

fn deserialize_chart_items<'de, D>(deserializer: D) -> Result<Vec<HotSearchItem>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Rows {
        Items(Vec<HotSearchItem>),
        Keywords(Vec<String>),
    }
    Ok(match Rows::deserialize(deserializer)? {
        Rows::Items(items) => items,
        Rows::Keywords(words) => words
            .into_iter()
            .map(|keyword| HotSearchItem {
                keyword,
                title: None,
                badge: None,
            })
            .collect(),
    })
}

impl StoredChart {
    async fn load(path: &Path) -> Option<Self> {
        let chart: Self = serde_json::from_slice(&fs::read(path).await.ok()?).ok()?;
        (!chart.items.is_empty()).then_some(chart)
    }

    async fn save(&self, path: &Path) -> std::io::Result<()> {
        let directory = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        fs::create_dir_all(directory).await?;
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(self)?;
        let result = async {
            fs::write(&temporary, bytes).await?;
            fs::rename(&temporary, path).await
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_file(&temporary).await;
        }
        result
    }
}

impl ChartCache {
    fn resolve(
        &self,
        now: Instant,
        wall_clock: SystemTime,
    ) -> Option<Result<HotSearchChart, HotSearchError>> {
        if let Some(chart) = &self.success {
            if wall_clock
                .duration_since(chart.fetched_at)
                .is_ok_and(|age| age < FRESH_FOR)
            {
                return Some(Ok(HotSearchChart {
                    items: chart.items.clone(),
                    stale: false,
                }));
            }
        }
        self.failure
            .filter(|at| now.duration_since(*at) < RETRY_AFTER_FAILURE)
            .map(|_| self.previous().ok_or(HotSearchError::Unavailable))
    }

    fn previous(&self) -> Option<HotSearchChart> {
        self.success.as_ref().map(|chart| HotSearchChart {
            items: chart.items.clone(),
            stale: true,
        })
    }
}

pub struct HotSearchProvider {
    directory: Option<PathBuf>,
    cache: Mutex<Option<ChartCache>>,
}

impl HotSearchProvider {
    pub fn new(directory: Option<PathBuf>) -> Self {
        Self {
            directory,
            cache: Mutex::default(),
        }
    }

    pub async fn chart(
        &self,
        bilibili: &BilibiliProvider,
    ) -> Result<HotSearchChart, HotSearchError> {
        // Simultaneous requests share a single refresh.
        let path = self.directory.as_ref().map(|dir| dir.join("bilibili.json"));
        let mut slot = self.cache.lock().await;
        if slot.is_none() {
            let success = match &path {
                Some(path) => StoredChart::load(path).await,
                None => None,
            };
            *slot = Some(ChartCache {
                success,
                failure: None,
            });
        }
        let cache = slot.get_or_insert_with(ChartCache::default);
        if let Some(chart) = cache.resolve(Instant::now(), SystemTime::now()) {
            return chart;
        }
        let result = bilibili
            .hot_search(BILIBILI_LIMIT)
            .await
            .map_err(HotSearchError::from)
            .and_then(parse_chart);
        match result {
            Ok(items) => {
                cache.failure = None;
                let stored = StoredChart {
                    fetched_at: SystemTime::now(),
                    items: items.clone(),
                };
                if let Some(path) = &path {
                    let _ = stored.save(path).await;
                }
                cache.success = Some(stored);
                Ok(HotSearchChart {
                    items,
                    stale: false,
                })
            }
            Err(error) => {
                cache.failure = Some(Instant::now());
                cache.previous().ok_or(error)
            }
        }
    }
}

fn parse_chart(payload: serde_json::Value) -> Result<Vec<HotSearchItem>, HotSearchError> {
    let rows = &payload["trending"]["list"];
    let mut seen = HashSet::new();
    let items: Vec<_> = rows
        .as_array()
        .ok_or(HotSearchError::Unavailable)?
        .iter()
        .filter_map(|row| {
            let keyword = chart_word(&row["keyword"])?;
            if !seen.insert(keyword.to_lowercase()) {
                return None;
            }
            let title = chart_word(&row["show_name"]).filter(|title| title != &keyword);
            Some(HotSearchItem {
                keyword,
                title,
                badge: chart_badge(row),
            })
        })
        .take(BILIBILI_LIMIT)
        .collect();
    if items.is_empty() {
        return Err(HotSearchError::Unavailable);
    }
    Ok(items)
}

fn chart_word(value: &serde_json::Value) -> Option<String> {
    let word = value
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!word.is_empty() && word.chars().count() <= 120).then_some(word)
}

fn chart_badge(row: &serde_json::Value) -> Option<HotSearchBadge> {
    // The web chart identifies standard badges by their icon asset.
    match row["icon"].as_str()?.rsplit('/').next()? {
        "lrx9rnKo24.png" => Some(HotSearchBadge::Hot),
        "UF7B1wVKT2.png" => Some(HotSearchBadge::New),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bilibili_retains_ten_ranked_terms_and_recognizes_only_standard_icons() {
        let mut rows = vec![
            json!({"keyword":"热搜词", "show_name":"榜单标题", "icon":"http://i0.hdslb.com/example/lrx9rnKo24.png"}),
            json!({"keyword":"新词", "show_name":"新词", "icon":"http://i0.hdslb.com/example/UF7B1wVKT2.png"}),
            json!({"keyword":"自定义图标", "icon":"https://i0.hdslb.com/bfs/legacy/custom.png"}),
        ];
        rows.extend((4..=12).map(|rank| json!({"keyword":format!("词条 {rank}")})));
        let items = parse_chart(json!({"trending":{"list":rows}})).unwrap();
        assert_eq!(items.len(), 10);
        assert_eq!(items[0].keyword, "热搜词");
        assert_eq!(items[0].title.as_deref(), Some("榜单标题"));
        assert_eq!(items[0].badge, Some(HotSearchBadge::Hot));
        assert_eq!(items[1].title, None);
        assert_eq!(items[1].badge, Some(HotSearchBadge::New));
        assert_eq!(items[2].badge, None);
        assert_eq!(items[9].keyword, "词条 10");
    }

    #[test]
    fn rejects_upstream_errors_and_empty_charts() {
        assert!(parse_chart(json!({"code":429})).is_err());
        assert!(parse_chart(json!({"trending":{"list":[]}})).is_err());
    }

    #[test]
    fn caches_for_thirty_minutes_and_keeps_previous_chart_on_failure() {
        let now = Instant::now();
        let fetched_at = SystemTime::now();
        let mut cache = ChartCache {
            success: Some(StoredChart {
                fetched_at,
                items: vec![HotSearchItem {
                    keyword: "传奇".into(),
                    title: None,
                    badge: Some(HotSearchBadge::Hot),
                }],
            }),
            failure: None,
        };
        let refresh_at = now + FRESH_FOR;
        let refresh_wall_clock = fetched_at + FRESH_FOR;
        assert!(
            !cache
                .resolve(now, refresh_wall_clock - Duration::from_secs(1))
                .unwrap()
                .unwrap()
                .stale
        );
        assert!(cache.resolve(refresh_at, refresh_wall_clock).is_none());
        cache.failure = Some(refresh_at);
        let previous = cache
            .resolve(refresh_at, refresh_wall_clock)
            .unwrap()
            .unwrap();
        assert!(previous.stale);
        assert_eq!(previous.items[0].keyword, "传奇");
        assert_eq!(previous.items[0].badge, Some(HotSearchBadge::Hot));
        assert!(
            cache
                .resolve(refresh_at + RETRY_AFTER_FAILURE, refresh_wall_clock)
                .is_none()
        );
        cache.success = None;
        assert!(
            cache
                .resolve(refresh_at, refresh_wall_clock)
                .unwrap()
                .is_err()
        );
    }

    #[tokio::test]
    async fn loads_persisted_chart_without_network_on_restart() {
        let directory = std::env::temp_dir().join(format!(
            "bilimusic-hot-search-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).await.unwrap();
        fs::write(
            directory.join("bilibili.json"),
            json!({"fetched_at":SystemTime::now(),"keywords":["榜单"]}).to_string(),
        )
        .await
        .unwrap();
        let provider = HotSearchProvider::new(Some(directory.clone()));
        let bilibili = BilibiliProvider::new().unwrap();
        let chart = provider.chart(&bilibili).await.unwrap();
        fs::remove_dir_all(directory).await.unwrap();
        assert_eq!(chart.items[0].keyword, "榜单");
        assert!(!chart.stale);
    }

    #[tokio::test]
    #[ignore = "queries public provider endpoints"]
    async fn live_bilibili_returns_keywords() {
        let provider = HotSearchProvider::new(None);
        let bilibili = BilibiliProvider::new().unwrap();
        assert_eq!(
            provider.chart(&bilibili).await.unwrap().items.len(),
            BILIBILI_LIMIT
        );
    }
}
