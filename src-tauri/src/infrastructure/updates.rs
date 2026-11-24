use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, time::Duration};
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
    #[serde(default)]
    build: u32,
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
    pub build: u32,
    pub current_build: u32,
    pub available: bool,
    pub installable: bool,
    pub request_id: Option<String>,
    pub platform: Option<String>,
    pub size: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct DownloadPackage {
    pub version: String,
    pub build: u32,
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
pub fn current_build() -> u32 {
    env!("BILIMUSIC_BUILD_NUMBER")
        .parse()
        .expect("build script validated the build number")
}

pub fn compare_release(version: &str, build: u32, current: &semver::Version) -> Option<Ordering> {
    Some(
        version
            .parse::<semver::Version>()
            .ok()?
            .cmp_precedence(current)
            .then_with(|| build.cmp(&current_build())),
    )
}

pub fn platform_id(os: &str, arch: &str, large: bool) -> Option<&'static str> {
    match (os, arch) {
        ("android", "aarch64") => Some(if large { "android-large" } else { "android" }),
        ("android", "arm") if large => Some("android-large-armv7"),
        ("ios", "aarch64") => Some("ios"),
        ("ohos", "aarch64") => Some("ohos"),
        ("macos", "aarch64") => Some("mac"),
        ("macos", "x86_64") => Some("mac-intel"),
        ("windows", "x86_64") => Some("windows"),
        ("windows", "aarch64") => Some("windows-arm64"),
        _ => None,
    }
}
fn parse_selection(
    bytes: &[u8],
    platform: Option<&'static str>,
) -> Result<(UpdateRelease, Option<DownloadPackage>), String> {
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "更新版本信息异常，请稍后重试")?;
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
    let build = selected.as_ref().map_or(0, |p| p.build);
    if build > 50 {
        return Err("更新构建号无效".into());
    }
    let available = selected.as_ref().is_some_and(|p| {
        p.channels
            .iter()
            .any(|c| c.url.as_deref().is_some_and(allowed_download))
    });
    let mut release = UpdateRelease {
        version: version.clone(),
        build,
        current_build: current_build(),
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
            build,
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
    parse_selection(bytes, platform_id(os, arch, false)).map(|s| s.0)
}
pub async fn fetch_selection(
    platform: Option<&'static str>,
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
            Ok::<_, reqwest::Error>(parse_selection(&bytes, platform).ok())
        }
        .await;
        if let Ok(Some(selected)) = attempt {
            return Ok(selected);
        }
    }
    Err("无法获取更新信息，官网或镜像暂不可用，请稍后重试".into())
}

pub fn installed_platform(large: bool) -> Option<&'static str> {
    let arch = std::env::consts::ARCH;
    if cfg!(target_env = "ohos") {
        return platform_id("ohos", arch, large);
    }
    if cfg!(all(target_os = "linux", not(target_env = "ohos"))) {
        return match (arch, std::env::var_os("APPIMAGE").is_some()) {
            ("x86_64", true) => Some("linux-x64-appimage"),
            ("x86_64", false) => Some("linux-x64-deb"),
            ("aarch64", true) => Some("linux-arm64-appimage"),
            ("aarch64", false) => Some("linux-arm64-deb"),
            _ => None,
        };
    }
    platform_id(std::env::consts::OS, arch, large)
}

#[cfg(all(desktop, not(target_env = "ohos")))]
pub fn desktop_target(platform: &str) -> Option<&'static str> {
    match platform {
        "mac" => Some("darwin-aarch64"),
        "mac-intel" => Some("darwin-x86_64"),
        "windows" => Some("windows-x86_64"),
        "windows-arm64" => Some("windows-aarch64"),
        _ => None,
    }
}

#[cfg(all(desktop, not(target_env = "ohos")))]
pub fn desktop_build(feed: &serde_json::Value, target: &str) -> Option<u32> {
    let entry = feed.get("platforms")?.get(target)?;
    match entry.get("build") {
        None => Some(0),
        Some(build) => build
            .as_u64()
            .filter(|n| *n > 0 && *n <= 50)
            .map(|n| n as u32),
    }
}

#[cfg(all(desktop, not(target_env = "ohos")))]
pub fn desktop_matches_catalog(
    catalog: &Result<(UpdateRelease, Option<DownloadPackage>), String>,
    version: &str,
    build: u32,
) -> bool {
    match catalog {
        Ok((release, _)) if release.available => {
            release.version == version && release.build == build
        }
        _ => build == 0,
    }
}

#[cfg(any(test, target_os = "android"))]
pub fn android_version_code(version: &str, build: u32) -> Option<u64> {
    if !(1..=50).contains(&build) {
        return None;
    }
    let v = version.parse::<semver::Version>().ok()?;
    if !v.pre.is_empty() || v.minor > 99 || v.patch > 99 {
        return None;
    }
    let code = v
        .major
        .checked_mul(1_000_000)?
        .checked_add(v.minor * 10_000 + v.patch * 100 + u64::from(build - 1))?;
    (code <= 2_100_000_000).then_some(code)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_version_update_is_selected_only_for_the_built_platform() {
        let local = "0.4.0".parse().unwrap();
        let previous = "0.3.7".parse().unwrap();
        let current = current_build();
        let patch = if current == 50 {
            current - 1
        } else {
            current + 1
        };
        let data = serde_json::json!({"version":"0.4.0","platforms":[
            {"id":"android","status":"available","build":patch,"file":"phone.apk","size":10,"sha256":"a".repeat(64),
                "channels":[{"url":"https://github.com/licpp/BiliMusic-Desktop/releases/download/v0.4.0/phone.apk"}]},
            {"id":"android-large","status":"available","build":current,
                "channels":[{"url":"https://github.com/licpp/BiliMusic-Desktop/releases/download/v0.4.0/large.apk"}]}
        ]});
        let raw = serde_json::to_vec(&data).unwrap();
        let (phone, apk) = parse_selection(&raw, Some("android")).unwrap();
        let (large, _) = parse_selection(&raw, Some("android-large")).unwrap();
        assert_eq!(
            compare_release(&phone.version, 1, &previous),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_release(&phone.version, phone.build, &local),
            Some(patch.cmp(&current))
        );
        assert_eq!(
            compare_release(&large.version, large.build, &local),
            Some(Ordering::Equal)
        );
        assert_eq!(compare_release("0.4.0", 0, &local), Some(Ordering::Less));
        assert_eq!(compare_release("0.4.1", 1, &local), Some(Ordering::Greater));
        assert_eq!(
            android_version_code(&phone.version, apk.unwrap().build),
            Some(40_000 + u64::from(patch - 1))
        );
        assert_eq!(android_version_code("0.3.7", 0), None);
    }

    #[cfg(all(desktop, not(target_env = "ohos")))]
    #[test]
    fn desktop_installer_must_agree_with_the_catalog() {
        let catalog = serde_json::json!({"version":"0.4.0","platforms":[
            {"id":"mac-intel","status":"available","build":2,
                "channels":[{"url":"https://github.com/licpp/BiliMusic-Desktop/releases/download/v0.4.0/mac-intel.dmg"}]}
        ]});
        let selected = parse_selection(&serde_json::to_vec(&catalog).unwrap(), Some("mac-intel"));
        let feed = serde_json::json!({"version":"0.4.0","platforms":{
            "darwin-aarch64":{"build":1}, "darwin-x86_64":{"build":2}, "windows-x86_64":{}
        }});
        assert_eq!(desktop_build(&feed, "windows-x86_64"), Some(0));
        assert_eq!(
            desktop_build(&feed, desktop_target("mac-intel").unwrap()),
            Some(2)
        );
        assert!(desktop_matches_catalog(&selected, "0.4.0", 2));
        assert!(!desktop_matches_catalog(&selected, "0.4.0", 1));
        assert!(!desktop_matches_catalog(&selected, "0.3.7", 2));
        assert_eq!(desktop_build(&feed, "windows-aarch64"), None);
    }
    #[test]
    fn legacy_manifest_keeps_manual_download_and_rejects_unsafe_assets() {
        let mut data = serde_json::json!({"version":"0.3.8","platforms":[{"id":"android","status":"available","channels":[{"id":"gitee","url":"https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/v0.3.8/phone.apk"}]}]});
        let (release, package) =
            parse_selection(&serde_json::to_vec(&data).unwrap(), Some("android")).unwrap();
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
                parse_selection(&serde_json::to_vec(&data).unwrap(), Some("android"))
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
        let (release, package) = parse_selection(&bytes, Some("android-large")).unwrap();
        assert_eq!(release.version, "0.3.8");
        assert!(package.is_some());
        assert!(
            !parse_selection(&bytes, Some("android"))
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
            parse_selection(&serde_json::to_vec(&broken).unwrap(), Some("android-large"),)
                .unwrap()
                .1
                .is_none()
        );
        assert!(parse_manifest(b"<html>ICP</html>", "macos", "aarch64").is_err());
    }
    #[test]
    fn armv7_updates_never_offer_an_arm64_package() {
        let package = |id: &str| serde_json::json!({"id":id,"status":"available","file":format!("{id}.apk"),"size":10,"sha256":"a".repeat(64),"channels":[{"id":"github","url":format!("https://github.com/licpp/BiliMusic-Desktop/releases/download/v0.3.5/{id}.apk")} ]});
        let only64 = serde_json::json!({"version":"0.3.5","platforms":[package("android-large")]});
        let (_, selected) = parse_selection(
            &serde_json::to_vec(&only64).unwrap(),
            Some("android-large-armv7"),
        )
        .unwrap();
        assert!(selected.is_none());
        let both = serde_json::json!({"version":"0.3.5","platforms":[package("android-large"),package("android-large-armv7")]});
        let bytes = serde_json::to_vec(&both).unwrap();
        for (arch, expected) in [("arm", "android-large-armv7"), ("aarch64", "android-large")] {
            assert_eq!(
                parse_selection(&bytes, platform_id("android", arch, true))
                    .unwrap()
                    .1
                    .unwrap()
                    .platform,
                expected
            );
        }
        assert!(
            parse_selection(&bytes, platform_id("android", "arm", false))
                .unwrap()
                .1
                .is_none()
        );
    }
}
