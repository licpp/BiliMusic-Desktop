//! Provider routing and shared HTTP resources; provider formats live in their own modules.
pub use super::cloud_transport::{authenticate, cloud_delete};
use super::Config;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
#[derive(Serialize, Deserialize)]
pub struct Secret {
    pub username: String,
    pub password: String,
}
pub fn client() -> Result<Client, String> {
    #[cfg(not(test))]
    static HTTP: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    #[cfg(not(test))]
    if let Some(client) = HTTP.get() {
        return Ok(client.clone());
    }
    let builder = Client::builder();
    #[cfg(test)]
    let builder = if std::env::var("SYNC_TEST_DIRECT").as_deref() == Ok("1") {
        builder
            .no_proxy()
            .resolve("bilimusic.cn", "127.0.0.1:18443".parse().unwrap())
    } else {
        builder
    };
    let built = builder
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化同步连接".to_string())?;
    #[cfg(not(test))]
    return Ok(HTTP.get_or_init(|| built).clone());
    #[cfg(test)]
    Ok(built)
}
pub fn validate_nutstore(c: &Config) -> Result<(), String> {
    let u = url::Url::parse(&c.url).map_err(|_| "WebDAV地址无效")?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.host_str() != Some("dav.jianguoyun.com")
    {
        return Err("请使用坚果云 HTTPS WebDAV 地址".into());
    }
    Ok(())
}
