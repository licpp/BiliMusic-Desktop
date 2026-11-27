use super::bilibili::{BilibiliProvider, ProviderError};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
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

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotSearchSource {
    Bilibili,
    Netease,
    Qq,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HotSearchBadge {
    Hot,
    New,
    Viral,
    Rising,
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
    #[error("热搜请求失败")]
    Request(#[from] reqwest::Error),
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
    client: Client,
    directory: Option<PathBuf>,
    bilibili: Mutex<Option<ChartCache>>,
    netease: Mutex<Option<ChartCache>>,
    qq: Mutex<Option<ChartCache>>,
}

impl HotSearchProvider {
    pub fn new(directory: Option<PathBuf>) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(8))
                .build()?,
            directory,
            bilibili: Mutex::default(),
            netease: Mutex::default(),
            qq: Mutex::default(),
        })
    }

    pub async fn chart(
        &self,
        source: HotSearchSource,
        bilibili: &BilibiliProvider,
    ) -> Result<HotSearchChart, HotSearchError> {
        let (slot, filename) = match source {
            HotSearchSource::Bilibili => (&self.bilibili, "bilibili.json"),
            HotSearchSource::Netease => (&self.netease, "netease.json"),
            HotSearchSource::Qq => (&self.qq, "qq.json"),
        };
        // Simultaneous requests share a single refresh per provider.
        let path = self.directory.as_ref().map(|dir| dir.join(filename));
        let mut slot = slot.lock().await;
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
        match self.fetch(source, bilibili).await {
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

    async fn fetch(
        &self,
        source: HotSearchSource,
        bilibili: &BilibiliProvider,
    ) -> Result<Vec<HotSearchItem>, HotSearchError> {
        let response = match source {
            HotSearchSource::Bilibili => {
                let data = bilibili.hot_search(BILIBILI_LIMIT).await?;
                return parse_chart(source, data);
            }
            HotSearchSource::Netease => {
                self.client
                    .get("https://music.163.com/api/hotsearchlist/get")
                    .send()
                    .await?
            }
            HotSearchSource::Qq => {
                self.client
                    .post("https://u.y.qq.com/cgi-bin/musicu.fcg")
                    .json(&json!({
                        "comm": { "ct": 24, "cv": 0 },
                        "hotkey": {
                            "module": "music.musicsearch.HotkeyService",
                            "method": "GetHotkeyForQQMusicMobile",
                            "param": {}
                        }
                    }))
                    .send()
                    .await?
            }
        };
        let payload = response.error_for_status()?.json().await?;
        parse_chart(source, payload)
    }
}

fn parse_chart(
    source: HotSearchSource,
    payload: serde_json::Value,
) -> Result<Vec<HotSearchItem>, HotSearchError> {
    let (rows, field, limit) = match source {
        HotSearchSource::Bilibili => (&payload["trending"]["list"], "keyword", BILIBILI_LIMIT),
        HotSearchSource::Netease if payload["code"].as_i64() == Some(200) => {
            (&payload["data"], "searchWord", 30)
        }
        HotSearchSource::Qq
            if payload["code"].as_i64() == Some(0)
                && payload["hotkey"]["code"].as_i64() == Some(0)
                && payload["hotkey"]["data"]["ret_code"].as_i64() == Some(0) =>
        {
            (&payload["hotkey"]["data"]["vec_hotkey"], "query", 30)
        }
        _ => return Err(HotSearchError::Unavailable),
    };
    let mut seen = HashSet::new();
    let items: Vec<_> = rows
        .as_array()
        .ok_or(HotSearchError::Unavailable)?
        .iter()
        .filter_map(|row| {
            let keyword = chart_word(&row[field])?;
            if !seen.insert(keyword.to_lowercase()) {
                return None;
            }
            let title = match source {
                HotSearchSource::Bilibili => chart_word(&row["show_name"]),
                HotSearchSource::Netease | HotSearchSource::Qq => None,
            }
            .filter(|title| title != &keyword);
            Some(HotSearchItem {
                keyword,
                title,
                badge: chart_badge(source, row),
            })
        })
        .take(limit)
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

fn chart_badge(source: HotSearchSource, row: &serde_json::Value) -> Option<HotSearchBadge> {
    use HotSearchBadge::*;
    match source {
        // The web chart identifies standard badges by their icon asset.
        HotSearchSource::Bilibili => match row["icon"].as_str()?.rsplit('/').next()? {
            "lrx9rnKo24.png" => Some(Hot),
            "UF7B1wVKT2.png" => Some(New),
            _ => None,
        },
        HotSearchSource::Netease => match row["iconType"].as_i64()? {
            4 => Some(Viral),
            5 => Some(Rising),
            _ => None,
        },
        HotSearchSource::Qq => match row["desc_icon_text"].as_str() {
            Some("热") => Some(Hot),
            Some("新") => Some(New),
            _ if row["description"].as_str() == Some("新歌") => Some(New),
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn music_rank_and_badges_follow_each_provider() {
        let netease = json!({"code":200,"data":[
            {"searchWord":" 汤令山 ", "iconType":4}, {"searchWord":"Time Machine", "iconType":5},
            {"searchWord":"time   machine"}, {"searchWord":" "}, {"searchWord":"趁早", "iconType":99}
        ]});
        let qq = json!({"code":0,"hotkey":{"code":0,"data":{"ret_code":0,"vec_hotkey":[
            {"query":"慌啥子嘛 赵本山","description":"正在热搜"},
            {"query":"发如雪","description":"新歌"}, {"jump_url":"example"}
        ]}}});
        let entries = |source, payload| {
            parse_chart(source, payload)
                .unwrap()
                .into_iter()
                .map(|row| (row.keyword, row.badge))
                .collect::<Vec<_>>()
        };
        use HotSearchBadge::*;
        assert_eq!(
            entries(HotSearchSource::Netease, netease.clone()),
            [
                ("汤令山".into(), Some(Viral)),
                ("Time Machine".into(), Some(Rising)),
                ("趁早".into(), None)
            ]
        );
        assert_eq!(
            entries(HotSearchSource::Qq, qq.clone()),
            [
                ("慌啥子嘛 赵本山".into(), None),
                ("发如雪".into(), Some(New))
            ]
        );
        assert!(parse_chart(HotSearchSource::Qq, netease).is_err());
        assert!(parse_chart(HotSearchSource::Netease, qq).is_err());
    }

    #[test]
    fn bilibili_retains_ten_ranked_terms_and_recognizes_only_standard_icons() {
        let mut rows = vec![
            json!({"keyword":"热搜词", "show_name":"榜单标题", "icon":"http://i0.hdslb.com/example/lrx9rnKo24.png"}),
            json!({"keyword":"新词", "show_name":"新词", "icon":"http://i0.hdslb.com/example/UF7B1wVKT2.png"}),
            json!({"keyword":"自定义图标", "icon":"https://i0.hdslb.com/bfs/legacy/custom.png"}),
        ];
        rows.extend((4..=12).map(|rank| json!({"keyword":format!("词条 {rank}")})));
        let items =
            parse_chart(HotSearchSource::Bilibili, json!({"trending":{"list":rows}})).unwrap();
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
        for (source, payload) in [
            (HotSearchSource::Netease, json!({"code":200,"data":[]})),
            (
                HotSearchSource::Netease,
                json!({"code":429,"data":[{"searchWord":"old"}]}),
            ),
            (
                HotSearchSource::Qq,
                json!({"code":0,"hotkey":{"code":0,"data":{
                    "ret_code":1, "vec_hotkey":[{"query":"old"}]
                }}}),
            ),
        ] {
            assert!(parse_chart(source, payload).is_err());
        }
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
                    badge: Some(HotSearchBadge::Viral),
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
        assert_eq!(previous.items[0].badge, Some(HotSearchBadge::Viral));
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
    async fn loads_each_persisted_chart_without_network_on_restart() {
        let directory = std::env::temp_dir().join(format!(
            "bilimusic-hot-search-test-{}",
            uuid::Uuid::new_v4()
        ));
        let fetched_at = SystemTime::now();
        StoredChart {
            fetched_at,
            items: vec![HotSearchItem {
                keyword: "榜单".into(),
                title: None,
                badge: Some(HotSearchBadge::Hot),
            }],
        }
        .save(&directory.join("bilibili.json"))
        .await
        .unwrap();
        for (file, keyword) in [("netease.json", "传奇"), ("qq.json", "发如雪")] {
            fs::write(
                directory.join(file),
                json!({ "fetched_at": fetched_at, "keywords": [keyword] }).to_string(),
            )
            .await
            .unwrap();
        }
        let provider = HotSearchProvider::new(Some(directory.clone())).unwrap();
        let bilibili = BilibiliProvider::new().unwrap();
        let bili = provider
            .chart(HotSearchSource::Bilibili, &bilibili)
            .await
            .unwrap();
        let netease = provider
            .chart(HotSearchSource::Netease, &bilibili)
            .await
            .unwrap();
        let qq = provider
            .chart(HotSearchSource::Qq, &bilibili)
            .await
            .unwrap();
        fs::remove_dir_all(directory).await.unwrap();
        assert_eq!(bili.items[0].badge, Some(HotSearchBadge::Hot));
        assert_eq!(netease.items[0].keyword, "传奇");
        assert_eq!(qq.items[0].keyword, "发如雪");
        assert!(!bili.stale && !netease.stale && !qq.stale);
    }

    #[tokio::test]
    #[ignore = "queries public provider endpoints"]
    async fn live_providers_return_keywords() {
        let provider = HotSearchProvider::new(None).unwrap();
        let bilibili = BilibiliProvider::new().unwrap();
        let (bili, netease, qq) = tokio::join!(
            provider.chart(HotSearchSource::Bilibili, &bilibili),
            provider.chart(HotSearchSource::Netease, &bilibili),
            provider.chart(HotSearchSource::Qq, &bilibili)
        );
        assert_eq!(bili.unwrap().items.len(), BILIBILI_LIMIT);
        for chart in [netease.unwrap(), qq.unwrap()] {
            assert!(!chart.items.is_empty() && !chart.stale);
        }
    }
}
