//! Provider routing and shared HTTP resources; provider formats live in their own modules.
pub use super::cloud_transport::{CLOUD, authenticate, cloud_delete};
use super::{Config, model::Snapshot};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
#[derive(Serialize, Deserialize)]
pub struct Secret {
    pub username: String,
    pub password: String,
}
pub struct Remote {
    pub snapshot: Snapshot,
    pub version: Option<String>,
    pub dav: Option<super::dav::DavState>,
    pub conflicts: Vec<super::model::Conflict>,
    pub legacy_cloud: bool,
    pub track_positions: bool,
    pub creators: bool,
    pub creator_groups: bool,
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
pub fn endpoint(c: &Config) -> Result<String, String> {
    if c.provider == "cloud" {
        return super::cloud_transport::endpoint(c);
    }
    let u = url::Url::parse(&c.url).map_err(|_| "WebDAV地址无效")?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.host_str() != Some("dav.jianguoyun.com")
    {
        return Err("首版仅支持坚果云 HTTPS WebDAV 地址".into());
    }
    Ok(format!(
        "{}/BiliMusic-sync-v1/{}/library.json",
        c.url.trim_end_matches('/'),
        c.uid
    ))
}

pub async fn read(cfg: &Config, secret: &Secret) -> Result<Remote, String> {
    match cfg.provider.as_str() {
        "webdav" => super::dav::read(cfg, secret).await,
        "cloud" => super::cloud_transport::read(cfg, secret).await,
        _ => Err("未知的同步服务".into()),
    }
}
pub async fn write(
    cfg: &Config,
    secret: &Secret,
    remote: &Remote,
    snapshot: &Snapshot,
) -> Result<bool, String> {
    match cfg.provider.as_str() {
        "webdav" => super::dav::write(cfg, secret, remote, snapshot).await,
        "cloud" => super::cloud_transport::write(cfg, secret, remote, snapshot).await,
        _ => Err("未知的同步服务".into()),
    }
}
