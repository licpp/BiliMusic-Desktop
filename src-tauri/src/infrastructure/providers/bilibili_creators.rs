use super::*;
use serde_json::{Value, json};

// WBI hashes the sorted RFC 3986 query, including the creator-specific keyword.
fn creator_video_query(mid: i64, keyword: &str, page: u32, timestamp: u64, salt: &str) -> String {
    fn encode(value: &str) -> String {
        let mut result = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                result.push(byte as char);
            } else {
                result.push_str(&format!("%{byte:02X}"));
            }
        }
        result
    }
    let mut fields = std::collections::BTreeMap::from([
        ("mid", mid.to_string()),
        ("order", "pubdate".into()),
        ("pn", page.to_string()),
        ("ps", "30".into()),
        ("wts", timestamp.to_string()),
    ]);
    let keyword: String = keyword
        .trim()
        .chars()
        .filter(|ch| !"!'()*".contains(*ch))
        .collect();
    if !keyword.is_empty() {
        fields.insert("keyword", keyword);
    }
    let query = fields
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let hash = format!("{:x}", md5::compute(format!("{query}{salt}")));
    format!("{query}&w_rid={hash}")
}

impl BilibiliProvider {
    pub async fn creator_catalog(
        &self,
        action: &str,
        keyword: &str,
        mid: i64,
        page: u32,
    ) -> Result<Value, ProviderError> {
        self.ensure_search_session(Url::parse(WEB_ORIGIN).unwrap(), false)
            .await?;
        let page = page.max(1);
        let mut url = match action {
            "following" => self.api_url("/x/relation/followings"),
            "search" => self.api_url("/x/web-interface/search/type"),
            "profile" => self.api_url("/x/web-interface/card"),
            "videos" => self.api_url("/x/space/wbi/arc/search"),
            "seasons" => self.api_url("/x/polymer/web-space/seasons_series_list"),
            _ => {
                return Err(ProviderError::Api {
                    code: -1,
                    message: "无效的 UP 主操作".into(),
                });
            }
        };
        if action != "search" && action != "following" && mid <= 0 {
            return Err(ProviderError::Api {
                code: -1,
                message: "无效的 UP 主编号".into(),
            });
        }
        match action {
            "following" => {
                let nav: Value = self.get_data(self.api_url("/x/web-interface/nav")).await?;
                let uid =
                    nav["mid"]
                        .as_i64()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| ProviderError::Api {
                            code: -101,
                            message: "请先登录 B站账号再导入关注".into(),
                        })?;
                url.query_pairs_mut()
                    .append_pair("vmid", &uid.to_string())
                    .append_pair("pn", &page.to_string())
                    .append_pair("ps", "50");
            }
            "search" => {
                url.query_pairs_mut()
                    .append_pair("search_type", "bili_user")
                    .append_pair("keyword", keyword)
                    .append_pair("page", &page.to_string())
                    .append_pair("pagesize", "20");
            }
            "profile" => {
                url.query_pairs_mut().append_pair("mid", &mid.to_string());
            }
            "seasons" => {
                url.query_pairs_mut()
                    .append_pair("mid", &mid.to_string())
                    .append_pair("page_num", &page.to_string())
                    .append_pair("page_size", "20");
            }
            _ => {
                let envelope: Value = self
                    .authenticated_get(self.api_url("/x/web-interface/nav"))
                    .await
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                let nav = &envelope["data"];
                let keys = ["img_url", "sub_url"]
                    .map(|k| {
                        nav["wbi_img"][k]
                            .as_str()
                            .unwrap_or("")
                            .rsplit('/')
                            .next()
                            .unwrap_or("")
                            .split('.')
                            .next()
                            .unwrap_or("")
                            .to_owned()
                    })
                    .join("");
                const MIX: [usize; 64] = [
                    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
                    9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26,
                    17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
                    44, 52,
                ];
                if keys.len() != 64 || !keys.is_ascii() {
                    return Err(ProviderError::Api {
                        code: -1,
                        message: "无法获取投稿搜索签名，请重试".into(),
                    });
                }
                let salt: String = MIX
                    .iter()
                    .take(32)
                    .map(|i| keys.as_bytes()[*i] as char)
                    .collect();
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                url.set_query(Some(&creator_video_query(
                    mid, keyword, page, timestamp, &salt,
                )));
            }
        }
        let data: Value = match self.get_data(url.clone()).await {
            Err(ProviderError::Network(error))
                if error.status() == Some(reqwest::StatusCode::PRECONDITION_FAILED) =>
            {
                let space =
                    Url::parse(&format!("https://space.bilibili.com/{mid}/upload/video")).unwrap();
                self.ensure_search_session(space, true).await?;
                self.get_data(url).await?
            }
            result => result?,
        };
        Ok(json!({"data":data,"page":page}))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn creator_video_search_signs_unicode_spaces_and_scope_in_sorted_order() {
        let query = super::creator_video_query(42, "  星 + piano!'()*  ", 2, 1700000000, "salt");
        assert_eq!(
            query,
            "keyword=%E6%98%9F%20%2B%20piano&mid=42&order=pubdate&pn=2&ps=30&wts=1700000000&w_rid=287e4393232ce6133b99b3817eeaae15"
        );
        let empty = super::creator_video_query(42, "", 1, 1700000000, "salt");
        assert!(empty.starts_with("mid=42&order=pubdate&pn=1&ps=30&wts=1700000000&w_rid="));
    }

    use super::*;
    #[tokio::test]
    #[ignore = "uses live Bilibili endpoints"]
    async fn creator_catalog_smoke() {
        let provider = BilibiliProvider::new().unwrap();
        let found = provider
            .creator_catalog("search", "小Lin说", 0, 1)
            .await
            .unwrap();
        assert!(
            found["data"]["result"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        );
        let mid = found["data"]["result"][0]["mid"].as_i64().unwrap();
        let videos = provider
            .creator_catalog("videos", "", mid, 1)
            .await
            .unwrap();
        assert!(videos["data"]["list"]["vlist"].is_array());
        let seasons = provider
            .creator_catalog("seasons", "", mid, 1)
            .await
            .unwrap();
        assert!(seasons["data"]["items_lists"].is_object());
    }
}
