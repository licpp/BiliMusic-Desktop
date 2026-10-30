use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DOWNLOAD_PAGE: &str = "https://bilimusic.cn/#download";
const RELEASE_ENDPOINTS: [&str; 3] = [
    "https://bilimusic.cn/api/v1/releases",
    "https://gitee.com/yoaker/BiliMusic-Desktop/raw/main/website/releases.json",
    "https://raw.githubusercontent.com/licpp/BiliMusic-Desktop/main/website/releases.json",
];
const MAX_MANIFEST_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: Vec<Platform>,
}
#[derive(Deserialize)]
struct Platform {
    id: String,
    status: String,
    #[serde(default)]
    channels: Vec<Channel>,
}
#[derive(Deserialize)]
struct Channel {
    url: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct UpdateRelease {
    pub version: String,
    pub available: bool,
}

fn parse_manifest(bytes: &[u8], os: &str, arch: &str) -> Result<UpdateRelease, String> {
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "更新版本信息异常，请稍后重试")?;
    if manifest.version.is_empty() || manifest.version.len() > 128 {
        return Err("更新版本信息异常，请稍后重试".into());
    }
    // Only these architectures currently have published installers.
    let platform = match (os, arch) {
        ("android", "aarch64") => Some("android"),
        ("macos", "aarch64") => Some("mac"),
        ("windows", "x86_64") => Some("windows"),
        _ => None,
    };
    let available = manifest.platforms.iter().any(|item| {
        Some(item.id.as_str()) == platform
            && item.status == "available"
            && item.channels.iter().any(|channel| {
                channel.url.as_deref().is_some_and(|url| {
                    url.starts_with("https://github.com/licpp/BiliMusic-Desktop/releases/download/")
                        || url.starts_with(
                            "https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/",
                        )
                })
            })
    });
    Ok(UpdateRelease {
        version: manifest.version,
        available,
    })
}

async fn fetch_manifest(client: &reqwest::Client, endpoint: &str) -> Result<UpdateRelease, String> {
    let mut response = client
        .get(endpoint)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "无法连接更新服务，请检查网络后重试")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取版本信息失败，请重试")?
    {
        if bytes.len() + chunk.len() > MAX_MANIFEST_BYTES {
            return Err("更新版本信息过大，请稍后重试".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_manifest(&bytes, std::env::consts::OS, std::env::consts::ARCH)
}

pub async fn check_update() -> Result<UpdateRelease, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(5))
        .user_agent("BiliMusic update check")
        .build()
        .map_err(|_| "无法初始化更新检查")?;
    // Prefer domestic endpoints; each failed request is bounded so three sources take at most about 15 seconds.
    // Both repositories mirror the published manifest, without requiring login or API tokens.
    for endpoint in RELEASE_ENDPOINTS {
        if let Ok(release) = fetch_manifest(&client, endpoint).await {
            return Ok(release);
        }
    }
    Err("无法获取更新信息，请检查网络后重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn domestic_mirror_precedes_github_and_download_stays_on_website() {
        assert!(RELEASE_ENDPOINTS[0].starts_with("https://bilimusic.cn/"));
        assert!(RELEASE_ENDPOINTS[1].starts_with("https://gitee.com/"));
        assert!(RELEASE_ENDPOINTS[2].starts_with("https://raw.githubusercontent.com/"));
        assert_eq!(DOWNLOAD_PAGE, "https://bilimusic.cn/#download");
    }
    #[test]
    fn gitee_only_manifest_is_accepted() {
        let bytes=br#"{"version":"0.1.8","platforms":[{"id":"android","status":"available","channels":[{"url":"https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/v0.1.8/app.apk"}]}]}"#;
        assert!(
            parse_manifest(bytes, "android", "aarch64")
                .unwrap()
                .available
        );
    }
    #[test]
    fn only_offer_available_installers_for_the_device() {
        let bytes = br#"{"version":"0.1.6-preview.10","platforms":[{"id":"mac","status":"available","channels":[{"url":"https://github.com/licpp/BiliMusic-Desktop/releases/download/test/app.dmg"}]},{"id":"android","status":"coming_soon"},{"id":"windows","status":"available","channels":[{"url":null}]}]}"#;
        assert!(parse_manifest(bytes, "macos", "aarch64").unwrap().available);
        assert!(!parse_manifest(bytes, "macos", "x86_64").unwrap().available);
        assert!(
            !parse_manifest(bytes, "android", "aarch64")
                .unwrap()
                .available
        );
        assert!(
            !parse_manifest(bytes, "windows", "x86_64")
                .unwrap()
                .available
        );
        assert!(parse_manifest(b"<html>error</html>", "macos", "aarch64").is_err());
    }
}
