use super::{
    Config,
    model::{MAX_BYTES, Snapshot},
};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;
pub const CLOUD: &str = "https://bilimusic.cn/api/sync/v1";
fn cloud() -> String {
    #[cfg(test)]
    if let Ok(value) = std::env::var("SYNC_TEST_CLOUD_BASE") {
        return value;
    }
    CLOUD.into()
}
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
}
pub fn client() -> Result<Client, String> {
    let builder = Client::builder();
    #[cfg(test)]
    let builder = if std::env::var("SYNC_TEST_DIRECT").as_deref() == Ok("1") {
        builder
            .no_proxy()
            .resolve("bilimusic.cn", "127.0.0.1:18443".parse().unwrap())
    } else {
        builder
    };
    builder
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化同步连接".into())
}
pub fn endpoint(c: &Config) -> Result<String, String> {
    if c.provider == "cloud" {
        return Ok(format!("{}/vault", cloud()));
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
fn auth(r: reqwest::RequestBuilder, c: &Config, s: &Secret) -> reqwest::RequestBuilder {
    if c.provider == "cloud" {
        r.bearer_auth(&s.password)
    } else {
        r.basic_auth(&s.username, Some(&s.password))
    }
}
async fn body(mut r: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut bytes = vec![];
    while let Some(chunk) = r.chunk().await.map_err(|_| "同步下载中断")? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("云端同步数据超过3MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn http_error(s: StatusCode) -> String {
    match s.as_u16() {
        401 | 403 => "同步授权失效，请重新连接（已停止自动重试）".into(),
        429 => "同步请求过于频繁，请稍后重试".into(),
        _ => format!("同步服务返回 HTTP {}", s.as_u16()),
    }
}
pub async fn read(c: &Config, s: &Secret) -> Result<Remote, String> {
    if c.provider == "webdav" {
        return super::dav::read(c, s).await;
    }
    let response = auth(client()?.get(endpoint(c)?), c, s)
        .send()
        .await
        .map_err(|_| "无法连接同步服务，请检查网络")?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Remote {
            snapshot: Snapshot::empty(&c.uid),
            version: None,
            dav: None,
            conflicts: vec![],
        });
    }
    if response.status() != StatusCode::OK {
        return Err(http_error(response.status()));
    }
    let version = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.starts_with("W/"))
        .map(str::to_owned)
        .ok_or("服务不支持强 ETag，已禁止多设备自动写入")?;
    let snapshot: Snapshot =
        serde_json::from_slice(&body(response).await?).map_err(|_| "云端同步文件格式不正确")?;
    snapshot.validate(&c.uid)?;
    Ok(Remote {
        snapshot,
        version: Some(version),
        dav: None,
        conflicts: vec![],
    })
}
pub async fn write(
    c: &Config,
    s: &Secret,
    remote: &Remote,
    snapshot: &Snapshot,
) -> Result<bool, String> {
    if c.provider == "webdav" {
        return super::dav::write(c, s, remote, snapshot).await;
    }
    snapshot.validate(&c.uid)?;
    let url = endpoint(c)?;
    let http = client()?;
    if c.provider == "webdav" && remote.version.is_none() {
        for path in [
            format!("{}/BiliMusic-sync-v1/", c.url.trim_end_matches('/')),
            format!(
                "{}/BiliMusic-sync-v1/{}/",
                c.url.trim_end_matches('/'),
                c.uid
            ),
        ] {
            let r = auth(
                http.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), path),
                c,
                s,
            )
            .send()
            .await
            .map_err(|_| "无法创建坚果云同步目录")?;
            if !matches!(r.status().as_u16(), 201 | 405) {
                return Err(http_error(r.status()));
            }
        }
    }
    let mut request = auth(http.put(url), c, s).header("content-type", "application/json");
    request = if let Some(v) = &remote.version {
        request.header("if-match", v)
    } else {
        request.header("if-none-match", "*")
    };
    let r = request
        .body(serde_json::to_vec(snapshot).map_err(|_| "无法编码同步数据")?)
        .send()
        .await
        .map_err(|_| "同步上传中断，下次将重新核对云端版本")?;
    if matches!(r.status().as_u16(), 409 | 412) {
        return Ok(false);
    }
    if !r.status().is_success() {
        return Err(http_error(r.status()));
    }
    Ok(true)
}
pub async fn authenticate(cookie: String, expected_uid: &str) -> Result<Secret, String> {
    let response = client()?
        .post(format!("{}/auth", cloud()))
        .json(&serde_json::json!({"cookie":cookie}))
        .send()
        .await
        .map_err(|_| "无法连接 BiliMusic 同步认证服务")?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body(response).await?).map_err(|_| "认证响应无效")?;
    if value["uid"].as_str() != Some(expected_uid) {
        return Err("服务端验证账号与当前账号不一致".into());
    }
    Ok(Secret {
        username: String::new(),
        password: value["token"].as_str().ok_or("同步令牌缺失")?.into(),
    })
}

pub async fn cloud_delete(s: &Secret, path: &str) -> Result<(), String> {
    let r = client()?
        .delete(format!("{}/{path}", cloud()))
        .bearer_auth(&s.password)
        .send()
        .await
        .map_err(|_| "无法连接同步服务")?;
    if !r.status().is_success() {
        return Err(http_error(r.status()));
    }
    Ok(())
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::sync::model::Record;
    #[tokio::test]
    #[ignore = "requires a temporary synthetic server session"]
    async fn live_cloud_https_conditional_write_and_revocation() {
        let path = std::env::var("SYNC_TEST_CLOUD_FILE").expect("isolated session file");
        let session: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mut cfg = Config::default();
        cfg.provider = "cloud".into();
        cfg.uid = session["uid"].as_str().unwrap().into();
        let secret = Secret {
            username: String::new(),
            password: session["token"].as_str().unwrap().into(),
        };
        let result=async {
   let initial=read(&cfg,&secret).await?;if initial.version.is_some(){return Err("test session was not isolated".to_owned());}
   let mut snapshot=Snapshot::empty(&cfg.uid);let id=uuid::Uuid::new_v4().to_string();let key=format!("playlist:{id}");snapshot.records.insert(key.clone(),Record{kind:"playlist".into(),fields:serde_json::from_value(serde_json::json!({"id":id,"name":"Temporary API test","description":"","coverUrl":null})).unwrap()});
   if !write(&cfg,&secret,&initial,&snapshot).await?{return Err("initial create failed".into());}
   if write(&cfg,&secret,&initial,&snapshot).await?{return Err("conditional create allowed overwrite".into());}
   let first=read(&cfg,&secret).await?;if first.snapshot!=snapshot{return Err("HTTPS readback mismatch".into());}
   snapshot.records.get_mut(&key).unwrap().fields.insert("name".into(),serde_json::json!("updated"));
   if !write(&cfg,&secret,&first,&snapshot).await?||write(&cfg,&secret,&first,&snapshot).await?{return Err("stale-write protection failed".into());}
   Ok::<(),String>(())
  }.await;
        cloud_delete(&secret, "vault")
            .await
            .expect("temporary cloud test cleanup");
        assert!(
            read(&cfg, &secret).await.is_err(),
            "deleted vault did not revoke test session"
        );
        assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    }
}
