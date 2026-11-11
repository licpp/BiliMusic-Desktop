use super::*;
use serde_json::{Value, json};

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
        if action != "search" && mid <= 0 {
            return Err(ProviderError::Api {
                code: -1,
                message: "无效的 UP 主编号".into(),
            });
        }
        match action {
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
                let params = [
                    ("mid", mid.to_string()),
                    ("order", "pubdate".into()),
                    ("pn", page.to_string()),
                    ("ps", "30".into()),
                    ("wts", timestamp.to_string()),
                ];
                url.query_pairs_mut()
                    .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
                let hash = format!(
                    "{:x}",
                    md5::compute(format!("{}{}", url.query().unwrap_or(""), salt))
                );
                url.query_pairs_mut().append_pair("w_rid", &hash);
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
