use reqwest::{Client, Url};
use std::time::Duration;

const API_ORIGIN: &str = "https://api.bilibili.com";

pub struct BilibiliProvider {
    client: Client,
}

impl BilibiliProvider {
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = Client::builder()
            .cookie_store(true)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .user_agent("Resonance/0.1 desktop-client")
            .build()?;
        Ok(Self { client })
    }

    pub async fn video_detail(&self, bvid: &str) -> Result<serde_json::Value, reqwest::Error> {
        let mut url = Url::parse(&format!("{API_ORIGIN}/x/web-interface/view")).expect("static API URL");
        url.query_pairs_mut().append_pair("bvid", bvid);
        self.client.get(url).header("Referer", "https://www.bilibili.com/").send().await?.error_for_status()?.json().await
    }
}
