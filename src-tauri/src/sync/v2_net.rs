//! Bounded WebDAV objects shared by compatibility control and v2. No conditional-write locks.
use super::{
    Config, traffic,
    transport::{self, Secret},
};
pub struct Client<'a> {
    cfg: &'a Config,
    secret: &'a Secret,
    http: reqwest::Client,
    cache: Option<std::path::PathBuf>,
    directories: std::sync::Mutex<std::collections::BTreeSet<String>>,
}
#[derive(Debug, Clone)]
pub struct Object {
    pub body: Vec<u8>,
    pub modified: Option<u64>,
    pub server_time: Option<u64>,
}
fn seconds(date: &str) -> Option<u64> {
    httpdate::parse_http_date(date)
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 1024
        && !path.starts_with('/')
        && path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._/".contains(&c))
        && path
            .split('/')
            .filter(|s| !s.is_empty())
            .all(|s| s != "." && s != "..")
}
impl<'a> Client<'a> {
    pub fn new(cfg: &'a Config, secret: &'a Secret) -> Result<Self, String> {
        Ok(Self {
            cfg,
            secret,
            http: transport::client()?,
            cache: None,
            directories: std::sync::Mutex::new(Default::default()),
        })
    }
    pub fn cached(
        cfg: &'a Config,
        secret: &'a Secret,
        directory: std::path::PathBuf,
    ) -> Result<Self, String> {
        let mut client = Self::new(cfg, secret)?;
        if let Some(entry) = super::cache::load(&directory, "known-directories") {
            *client.directories.get_mut().unwrap() =
                serde_json::from_slice(&entry.body).unwrap_or_default();
        }
        client.cache = Some(directory);
        Ok(client)
    }
    fn directory_known(&self, path: &str) -> bool {
        self.directories.lock().unwrap().contains(path)
    }
    fn remember_directory(&self, path: &str) {
        let mut dirs = self.directories.lock().unwrap();
        dirs.insert(path.into());
        if let Some(root) = &self.cache {
            if let Ok(body) = serde_json::to_vec(&*dirs) {
                super::cache::save(root, "known-directories", String::new(), body);
            }
        }
    }
    pub async fn parents(&self) -> Result<(), String> {
        let base = self.cfg.url.trim_end_matches('/');
        for path in [
            format!("{base}/BiliMusic-sync-v1/"),
            format!("{base}/BiliMusic-sync-v1/{}/", self.cfg.uid),
        ] {
            if self.directory_known(&path) {
                continue;
            }
            let response = traffic::send(
                self.http
                    .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &path)
                    .basic_auth(&self.secret.username, Some(&self.secret.password)),
            )
            .await
            .map_err(|_| "无法创建同步父目录")?;
            if response.status().as_u16() != 405 {
                super::dav::check(response.status())?;
            }
            self.remember_directory(&path);
        }
        Ok(())
    }
    fn url(&self, path: &str) -> Result<String, String> {
        if !valid_path(path) {
            return Err("同步对象路径无效".into());
        }
        Ok(format!(
            "{}/BiliMusic-sync-v1/{}/{path}",
            self.cfg.url.trim_end_matches('/'),
            self.cfg.uid
        ))
    }
    fn request(&self, method: &str, path: &str) -> Result<reqwest::RequestBuilder, String> {
        Ok(self
            .http
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "同步请求类型无效")?,
                self.url(path)?,
            )
            .basic_auth(&self.secret.username, Some(&self.secret.password)))
    }
    async fn response(&self, r: reqwest::Response) -> Result<Object, String> {
        let server_time = r
            .headers()
            .get("date")
            .and_then(|v| v.to_str().ok())
            .and_then(seconds);
        let modified = r
            .headers()
            .get("last-modified")
            .and_then(|v| v.to_str().ok())
            .and_then(seconds)
            .filter(|t| server_time.is_some_and(|now| *t <= now));
        let mut r = r;
        let mut body = Vec::new();
        while let Some(chunk) = r.chunk().await.map_err(|_| "同步对象下载中断")? {
            traffic::downloaded(chunk.len());
            if body.len() + chunk.len() > 12 * 1024 * 1024 {
                return Err("同步对象超过12MB".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Object {
            body,
            modified,
            server_time,
        })
    }
    pub async fn get(&self, path: &str) -> Result<Option<Object>, String> {
        let name = path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .trim_end_matches(".gz")
            .trim_end_matches(".json");
        let digest = if super::causal::valid_hash(name) {
            Some(name)
        } else {
            name.rsplit('-')
                .next()
                .filter(|s| super::causal::valid_hash(s))
        };
        if let (Some(root), Some(hash)) = (&self.cache, digest) {
            if let Some(entry) =
                super::cache::load(root, path).filter(|e| super::causal::hash(&e.body) == hash)
            {
                traffic::cache_hit();
                return Ok(Some(Object {
                    body: entry.body,
                    modified: None,
                    server_time: None,
                }));
            }
        }
        let r = traffic::send(self.request("GET", path)?)
            .await
            .map_err(|_| "无法读取同步对象")?;
        if r.status().as_u16() == 404 {
            return Ok(None);
        }
        super::dav::check(r.status())?;
        let object = self.response(r).await?;
        if let (Some(root), Some(hash)) = (&self.cache, digest) {
            if super::causal::hash(&object.body) != hash {
                return Err("同步对象摘要不符".into());
            }
            super::cache::save(root, path, hash.into(), object.body.clone());
        }
        Ok(Some(object))
    }
    pub async fn list(&self, path: &str) -> Result<(Vec<String>, Option<u64>), String> {
        let r = traffic::send(
            self.request("PROPFIND", path)?
                .header("Depth", "1")
                .header("Content-Type", "application/xml")
                .body(
                    "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>",
                ),
        )
        .await
        .map_err(|_| "无法读取同步目录")?;
        if r.status().as_u16() == 404 {
            return Ok((vec![], None));
        }
        super::dav::check(r.status())?;
        let obj = self.response(r).await?;
        let root = url::Url::parse(&self.url(path)?).map_err(|_| "同步目录无效")?;
        let mut reader = quick_xml::Reader::from_reader(obj.body.as_slice());
        let mut href = false;
        let mut names = std::collections::BTreeSet::new();
        loop {
            match reader.read_event() {
                Ok(quick_xml::events::Event::Start(e)) => href = e.local_name().as_ref() == b"href",
                Ok(quick_xml::events::Event::Text(e)) if href => {
                    let decoded = e.decode().map_err(|_| "同步目录编码无效")?;
                    let text =
                        quick_xml::escape::unescape(&decoded).map_err(|_| "同步目录转义无效")?;
                    let url = root.join(&text).map_err(|_| "同步目录路径无效")?;
                    if url.origin() == root.origin() {
                        if let Some(child) = url.path().strip_prefix(root.path()) {
                            let name = child.trim_end_matches('/');
                            if !name.is_empty() && !name.contains('/') && valid_path(name) {
                                names.insert(name.to_owned());
                            }
                        }
                    }
                }
                Ok(quick_xml::events::Event::Eof) => break,
                Err(_) => return Err("同步目录解析失败".into()),
                _ => {}
            }
        }
        if names.len() > 4096 {
            return Err("同步目录对象过多".into());
        }
        Ok((names.into_iter().collect(), obj.server_time))
    }
    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        if !valid_path(path) {
            return Err("同步目录路径无效".into());
        }
        let parts: Vec<_> = path.trim_end_matches('/').split('/').collect();
        for n in 1..=parts.len() {
            let directory = format!("{}/", parts[..n].join("/"));
            if self.directory_known(&directory) {
                continue;
            }
            let mut status = traffic::send(self.request("MKCOL", &directory)?.body(""))
                .await
                .map_err(|_| "无法创建同步目录")?
                .status();
            if status.as_u16() == 409 {
                self.parents().await?;
                status = traffic::send(self.request("MKCOL", &directory)?.body(""))
                    .await
                    .map_err(|_| "无法恢复同步目录")?
                    .status();
            }
            if status.as_u16() != 405 {
                super::dav::check(status)?;
            }
            self.remember_directory(&directory);
        }
        Ok(())
    }
    pub async fn delete(&self, path: &str) -> Result<(), String> {
        let response = traffic::send(self.request("DELETE", path)?)
            .await
            .map_err(|_| "同步提交清理中断")?;
        if response.status().as_u16() != 404 {
            super::dav::check(response.status())?;
        }
        Ok(())
    }
    pub async fn put(&self, path: &str, body: Vec<u8>) -> Result<(), String> {
        let status = self.put_once(path, body.clone()).await?;
        if status.as_u16() == 409 {
            self.directories.lock().unwrap().clear();
            self.parents().await?;
            let parts: Vec<_> = path.split('/').collect();
            for n in 1..parts.len() {
                self.mkdir(&format!("{}/", parts[..n].join("/"))).await?;
            }
            super::dav::check(self.put_once(path, body).await?)?;
        } else {
            super::dav::check(status)?;
        }
        Ok(())
    }
    async fn put_once(&self, path: &str, body: Vec<u8>) -> Result<reqwest::StatusCode, String> {
        if body.len() > 12 * 1024 * 1024 {
            return Err("同步对象超过12MB".into());
        }
        #[cfg(target_env = "ohos")]
        {
            traffic::bridge_started(body.len());
            let result = crate::ohos_playback::put_webdav(
                &self.url(path)?,
                &self.secret.username,
                &self.secret.password,
                &body,
            )
            .await;
            traffic::bridge_finished(result.as_ref().ok().map(|s| s.as_u16()));
            return result;
        }
        #[cfg(not(target_env = "ohos"))]
        {
            let r = traffic::send(
                self.request("PUT", path)?
                    .header(
                        "Content-Type",
                        if path.ends_with(".gz") {
                            "application/gzip"
                        } else {
                            "application/json"
                        },
                    )
                    .body(body),
            )
            .await
            .map_err(|_| "同步对象上传中断")?;
            Ok(r.status())
        }
    }
}
