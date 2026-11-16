use serde::{Deserialize, Serialize};
use std::time::Duration;
pub const DOWNLOAD_PAGE: &str = "https://bilimusic.cn/#download";
pub const RELEASE_ENDPOINTS: [&str; 3] = [
    "https://bilimusic.cn/api/v1/releases",
    "https://gitee.com/yoaker/BiliMusic-Desktop/raw/main/website/releases.json",
    "https://raw.githubusercontent.com/licpp/BiliMusic-Desktop/main/website/releases.json",
];
pub const UPDATER_ENDPOINTS: [&str; 3] = [
    "https://bilimusic.cn/api/v1/updater",
    "https://gitee.com/yoaker/BiliMusic-Desktop/raw/main/website/updater.json",
    "https://raw.githubusercontent.com/licpp/BiliMusic-Desktop/main/website/updater.json",
];
const MAX_MANIFEST_BYTES: usize = 128 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: Vec<Platform>,
}
#[derive(Deserialize)]
struct Platform {
    id: String,
    status: String,
    version: Option<String>,
    file: Option<String>,
    size: Option<u64>,
    sha256: Option<String>,
    #[serde(default)]
    channels: Vec<Channel>,
}
#[derive(Clone, Deserialize, Debug)]
pub struct Channel {
    pub id: Option<String>,
    pub url: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    pub version: String,
    pub available: bool,
    pub installable: bool,
    pub request_id: Option<String>,
    pub platform: Option<String>,
    pub size: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct DownloadPackage {
    pub version: String,
    pub platform: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub channels: Vec<Channel>,
}
pub fn allowed_download(url: &str) -> bool {
    [
        "https://github.com/licpp/BiliMusic-Desktop/releases/download/",
        "https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/",
    ]
    .iter()
    .any(|prefix| url.starts_with(prefix))
        && url::Url::parse(url).is_ok_and(|u| {
            u.as_str() == url
                && !url.contains('\\')
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
        })
}
pub fn platform_id(os: &str, arch: &str, large: bool) -> Option<&'static str> {
    match (os, arch) {
        ("android", "aarch64") => Some(if large { "android-large" } else { "android" }),
        ("ios", "aarch64") => Some("ios"),
        ("macos", "aarch64") => Some("mac"),
        ("windows", "x86_64") => Some("windows"),
        _ => None,
    }
}
fn parse_selection(
    bytes: &[u8],
    os: &str,
    arch: &str,
    large: bool,
) -> Result<(UpdateRelease, Option<DownloadPackage>), String> {
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "更新版本信息异常，请稍后重试")?;
    let platform = platform_id(os, arch, large);
    let selected = manifest
        .platforms
        .into_iter()
        .find(|p| Some(p.id.as_str()) == platform && p.status == "available");
    let version = selected
        .as_ref()
        .and_then(|p| p.version.clone())
        .unwrap_or(manifest.version);
    version
        .parse::<semver::Version>()
        .map_err(|_| "更新版本号无效")?;
    let available = selected.as_ref().is_some_and(|p| {
        p.channels
            .iter()
            .any(|c| c.url.as_deref().is_some_and(allowed_download))
    });
    let mut release = UpdateRelease {
        version: version.clone(),
        available,
        installable: false,
        request_id: None,
        platform: platform.map(str::to_owned),
        size: None,
    };
    let package = selected.and_then(|p| {
        let (file, size, sha256) = (p.file?, p.size?, p.sha256?);
        let valid = file.ends_with(".apk")
            && file
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            && size > 0
            && size <= MAX_PACKAGE_BYTES
            && sha256.len() == 64
            && sha256.bytes().all(|b| b.is_ascii_hexdigit())
            && p.channels.iter().any(|c| {
                c.url
                    .as_deref()
                    .is_some_and(|u| allowed_download(u) && u.ends_with(&format!("/{file}")))
            });
        if !valid {
            return None;
        }
        let channels = p
            .channels
            .into_iter()
            .filter(|c| {
                c.url
                    .as_deref()
                    .is_some_and(|u| allowed_download(u) && u.ends_with(&format!("/{file}")))
            })
            .collect();
        Some(DownloadPackage {
            version,
            platform: p.id,
            file,
            size,
            sha256,
            channels,
        })
    });
    release.size = package.as_ref().map(|p| p.size);
    Ok((release, package))
}
#[cfg(test)]
pub fn parse_manifest(bytes: &[u8], os: &str, arch: &str) -> Result<UpdateRelease, String> {
    parse_selection(bytes, os, arch, false).map(|s| s.0)
}
pub async fn fetch_selection(
    large: bool,
) -> Result<(UpdateRelease, Option<DownloadPackage>), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(5))
        .user_agent("BiliMusic update check")
        .build()
        .map_err(|_| "无法初始化更新检查")?;
    for endpoint in RELEASE_ENDPOINTS {
        let attempt = async {
            let mut response = client.get(endpoint).send().await?.error_for_status()?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if bytes.len() + chunk.len() > MAX_MANIFEST_BYTES {
                    return Ok(None);
                }
                bytes.extend_from_slice(&chunk)
            }
            Ok::<_, reqwest::Error>(
                parse_selection(&bytes, std::env::consts::OS, std::env::consts::ARCH, large).ok(),
            )
        }
        .await;
        if let Ok(Some(selected)) = attempt {
            return Ok(selected);
        }
    }
    Err("无法获取更新信息，官网或镜像暂不可用，请稍后重试".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_manifest_keeps_manual_download_and_rejects_unsafe_assets() {
        let mut data = serde_json::json!({"version":"0.3.8","platforms":[{"id":"android","status":"available","channels":[{"id":"gitee","url":"https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/v0.3.8/phone.apk"}]}]});
        let (release, package) = parse_selection(
            &serde_json::to_vec(&data).unwrap(),
            "android",
            "aarch64",
            false,
        )
        .unwrap();
        assert!(release.available);
        assert!(!release.installable);
        assert!(package.is_none());
        for (file, size, hash) in [
            ("phone.apk", 0, "a".repeat(64)),
            ("phone.apk", MAX_PACKAGE_BYTES + 1, "a".repeat(64)),
            ("../phone.apk", 12, "a".repeat(64)),
            ("phone.apk", 12, "invalid".into()),
        ] {
            data["platforms"][0]["file"] = serde_json::json!(file);
            data["platforms"][0]["size"] = serde_json::json!(size);
            data["platforms"][0]["sha256"] = serde_json::json!(hash);
            assert!(
                parse_selection(
                    &serde_json::to_vec(&data).unwrap(),
                    "android",
                    "aarch64",
                    false
                )
                .unwrap()
                .1
                .is_none()
            );
        }
        for invalid in [
            "https://github.com/licpp/BiliMusic-Desktop/releases/download/v/a.apk?token=x",
            "https://github.com/licpp/BiliMusic-Desktop/releases/download/v/../../evil.apk",
            "https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/v/a.apk#fragment",
        ] {
            assert!(!allowed_download(invalid));
        }
    }
    #[test]
    fn platform_and_integrity_guards() {
        let data = serde_json::json!({"version":"0.3.9","platforms":[{"id":"android-large","version":"0.3.8","status":"available","file":"large.apk","size":10,"sha256":"a".repeat(64),"channels":[{"id":"github","url":"https://github.com/licpp/BiliMusic-Desktop/releases/download/v0.3.8/large.apk"}]}]});
        let bytes = serde_json::to_vec(&data).unwrap();
        let (release, package) = parse_selection(&bytes, "android", "aarch64", true).unwrap();
        assert_eq!(release.version, "0.3.8");
        assert!(package.is_some());
        assert!(
            !parse_selection(&bytes, "android", "aarch64", false)
                .unwrap()
                .0
                .available
        );
        assert!(
            !parse_manifest(&bytes, "windows", "aarch64")
                .unwrap()
                .available
        );
        for url in [
            "https://evil.test/app.apk",
            "https://github.com.evil.test/licpp/BiliMusic-Desktop/releases/download/v/x.apk",
            "http://github.com/licpp/BiliMusic-Desktop/releases/download/v/x.apk",
        ] {
            assert!(!allowed_download(url))
        }
        let mut broken = data.clone();
        broken["platforms"][0]["sha256"] = serde_json::json!("bad");
        assert!(
            parse_selection(
                &serde_json::to_vec(&broken).unwrap(),
                "android",
                "aarch64",
                true
            )
            .unwrap()
            .1
            .is_none()
        );
        assert!(parse_manifest(b"<html>ICP</html>", "macos", "aarch64").is_err());
    }
}
