use super::*;
use serde_json::Value;
use std::collections::HashSet;

const FEED_PATH: &str = "/x/web-interface/wbi/index/top/feed/rcmd";
const PAGE_SIZE: u32 = 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    items: Vec<SearchItem>,
    next_page: Option<u32>,
}

impl BilibiliProvider {
    pub async fn personalized_feed(&self, page: u32) -> Result<FeedPage, ProviderError> {
        let page = page.max(1);
        let (epoch, session) = self.request_session().await;
        if session.is_none() {
            return Err(ProviderError::NotAuthenticated);
        }
        let salt = self.wbi_salt(true).await?;
        self.check_request_epoch(epoch)?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut url = self.api_url(FEED_PATH);
        url.set_query(Some(&feed_query(page, timestamp, &salt)));
        let data = self.get_data(url).await?;
        self.check_request_epoch(epoch)?;
        feed_page(data, page)
    }
}

fn feed_query(page: u32, timestamp: u64, salt: &str) -> String {
    wbi::signed_query(
        std::collections::BTreeMap::from([
            ("version", "1".into()),
            ("feed_version", "V8".into()),
            ("homepage_ver", "1".into()),
            ("ps", PAGE_SIZE.to_string()),
            ("fresh_idx", page.to_string()),
            ("brush", page.to_string()),
            ("fresh_type", "4".into()),
        ]),
        timestamp,
        salt,
    )
}

fn feed_page(data: Value, page: u32) -> Result<FeedPage, ProviderError> {
    let rows = data["item"]
        .as_array()
        .ok_or(ProviderError::UnexpectedResponse)?;
    let mut seen = HashSet::new();
    let items = rows
        .iter()
        .filter_map(|row| {
            if row["goto"].as_str() != Some("av") || row["is_ad"].as_bool() == Some(true) {
                return None;
            }
            let bvid = row["bvid"].as_str().filter(|value| valid_bvid(value))?;
            let title = row["title"]
                .as_str()
                .filter(|value| !value.trim().is_empty())?;
            if !seen.insert(bvid) {
                return None;
            }
            Some(SearchItem {
                bvid: bvid.into(),
                title: title.into(),
                cover_url: normalize_url(row["pic"].as_str().unwrap_or_default()),
                uploader_name: row["owner"]["name"].as_str().unwrap_or_default().into(),
                uploader_id: row["owner"]["mid"].as_i64().unwrap_or_default(),
                play_count: row["stat"]["view"].as_u64().unwrap_or_default(),
                duration_seconds: row["duration"].as_u64().unwrap_or_default(),
                published_at: row["pubdate"].as_u64().filter(|time| *time > 0),
                description: String::new(),
            })
        })
        .collect();
    Ok(FeedPage {
        items,
        next_page: if rows.is_empty() {
            None
        } else {
            page.checked_add(1)
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn feed_preserves_server_order_and_keeps_only_playable_video_cards() {
        let video = json!({
            "goto": "av", "bvid": "BV1fixtureAB", "title": "A & B",
            "pic": "//i0.hdslb.com/cover.jpg", "owner": {"mid": 43, "name": "UP 主"},
            "stat": {"view": 567}, "duration": 182, "pubdate": 1795700000
        });
        let page = feed_page(
            json!({"item": [
                {"goto": "live", "title": "直播"},
                {"goto": "av", "bvid": "BV1fixtureAE", "title": "广告", "is_ad": true},
                video.clone(),
                video,
                {"goto": "av", "bvid": "BV1fixtureAC", "title": "下一首", "stat": null},
                {"goto": "av", "title": "缺少视频 ID"}
            ]}),
            2,
        )
        .unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.bvid.as_str())
                .collect::<Vec<_>>(),
            ["BV1fixtureAB", "BV1fixtureAC"]
        );
        let first = &page.items[0];
        assert_eq!(first.title, "A & B");
        assert_eq!(first.uploader_name, "UP 主");
        assert_eq!(first.uploader_id, 43);
        assert_eq!(first.cover_url, "https://i0.hdslb.com/cover.jpg");
        assert_eq!(first.play_count, 567);
        assert_eq!(first.duration_seconds, 182);
        assert_eq!(first.published_at, Some(1795700000));
        assert_eq!(page.next_page, Some(3));
        assert_eq!(feed_page(json!({"item": []}), 3).unwrap().next_page, None);
        assert_eq!(
            feed_page(json!({"item": [{"goto": "live"}]}), 3)
                .unwrap()
                .next_page,
            Some(4)
        );
        assert!(matches!(
            feed_page(json!({}), 1),
            Err(ProviderError::UnexpectedResponse)
        ));
    }

    #[test]
    fn feed_signs_the_requested_batch_with_the_shared_signer() {
        let query = feed_query(3, 1795700000, "salt");
        assert!(query.starts_with("brush=3&feed_version=V8&fresh_idx=3&fresh_type=4&homepage_ver=1&ps=20&version=1&wts=1795700000&w_rid="));
    }
}
