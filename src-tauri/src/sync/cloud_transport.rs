//! BiliMusic Cloud compatibility, isolated from the Nutstore v2 execution path.
use super::{
    Config,
    model::{MAX_BYTES, Snapshot},
    transport::{Secret, client},
};
use reqwest::StatusCode;
use serde_json::Value;
pub(super) struct Remote {
    pub snapshot: Snapshot,
    pub version: Option<String>,
    pub legacy_cloud: bool,
    pub track_positions: bool,
    pub creators: bool,
    pub creator_groups: bool,
    pub wide_lyric_bias: bool,
}
pub fn endpoint(_c: &Config) -> Result<String, String> {
    Ok(format!("{}/vault", cloud()))
}
const CLOUD_FORMAT_HEADER: &str = "x-bilimusic-sync-format";
const CLOUD_FORMAT_CREATORS: &str = "creator-progress";
const CLOUD_FORMAT_GROUPS: &str = "creator-groups";
const CLOUD_FORMAT_TRACKS: &str = "track-checkpoints";
const CLOUD_FORMAT_CHECKPOINTS: &str = "checkpoints";
const WIDE_LYRIC_BIAS_HEADER: &str = "x-bilimusic-lyric-bias";
pub const CLOUD: &str = "https://bilimusic.cn/api/sync/v1";

fn legacy_bias(bias: i64) -> i64 {
    bias.clamp(-30_000, 30_000)
}

pub(super) fn project_lyric_bias(snapshot: &mut Snapshot) {
    for lyric in snapshot.records.values_mut().filter(|r| r.kind == "lyric") {
        if let Some(bias) = lyric.fields.get("biasMs").and_then(Value::as_i64) {
            lyric.fields.insert("biasMs".into(), legacy_bias(bias).into());
        }
    }
}

pub(super) fn restore_local_lyric_bias(snapshot: &mut Snapshot, local: &Snapshot) {
    for (key, lyric) in local.records.iter().filter(|(_, r)| r.kind == "lyric") {
        let Some(bias) = lyric.fields.get("biasMs").and_then(Value::as_i64) else {
            continue;
        };
        if bias == legacy_bias(bias) {
            continue;
        }
        if let Some(merged) = snapshot.records.get_mut(key).filter(|r| r.kind == "lyric") {
            let same_selection = ["provider", "providerLyricId", "manual"]
                .iter()
                .all(|field| merged.fields.get(*field) == lyric.fields.get(*field));
            if same_selection
                && merged.fields.get("biasMs").and_then(Value::as_i64) == Some(legacy_bias(bias))
            {
                merged.fields.insert("biasMs".into(), bias.into());
            }
        }
    }
}
fn cloud() -> String {
    #[cfg(test)]
    if let Ok(value) = std::env::var("SYNC_TEST_CLOUD_BASE") {
        return value;
    }
    CLOUD.into()
}
fn auth(r: reqwest::RequestBuilder, c: &Config, s: &Secret) -> reqwest::RequestBuilder {
    let _ = c;
    r.bearer_auth(&s.password)
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
    let mut response = auth(client()?.get(endpoint(c)?), c, s)
        .header(CLOUD_FORMAT_HEADER, CLOUD_FORMAT_GROUPS)
        .header(WIDE_LYRIC_BIAS_HEADER, "wide")
        .send()
        .await
        .map_err(|_| "无法连接同步服务，请检查网络")?;
    if matches!(response.status(), StatusCode::OK | StatusCode::NOT_FOUND)
        && !response.headers().contains_key(CLOUD_FORMAT_HEADER)
    {
        response = auth(client()?.get(endpoint(c)?), c, s)
            .header(CLOUD_FORMAT_HEADER, CLOUD_FORMAT_CREATORS)
            .header(WIDE_LYRIC_BIAS_HEADER, "wide")
            .send()
            .await
            .map_err(|_| "无法连接同步服务")?;
    }
    if matches!(response.status(), StatusCode::OK | StatusCode::NOT_FOUND)
        && !response.headers().contains_key(CLOUD_FORMAT_HEADER)
    {
        response = auth(client()?.get(endpoint(c)?), c, s)
            .header(CLOUD_FORMAT_HEADER, CLOUD_FORMAT_TRACKS)
            .header(WIDE_LYRIC_BIAS_HEADER, "wide")
            .send()
            .await
            .map_err(|_| "无法连接同步服务，请检查网络")?;
    }
    if matches!(response.status(), StatusCode::OK | StatusCode::NOT_FOUND)
        && !response.headers().contains_key(CLOUD_FORMAT_HEADER)
    {
        response = auth(client()?.get(endpoint(c)?), c, s)
            .header(CLOUD_FORMAT_HEADER, CLOUD_FORMAT_CHECKPOINTS)
            .header(WIDE_LYRIC_BIAS_HEADER, "wide")
            .send()
            .await
            .map_err(|_| "无法连接同步服务，请检查网络")?;
    }
    let format = response.headers().get(CLOUD_FORMAT_HEADER);
    let wide_lyric_bias = response
        .headers()
        .get(WIDE_LYRIC_BIAS_HEADER)
        .is_some_and(|value| value == "wide");
    let creator_groups = format.is_some_and(|value| value == CLOUD_FORMAT_GROUPS);
    let creators = creator_groups || format.is_some_and(|value| value == CLOUD_FORMAT_CREATORS);
    let track_positions = creators || format.is_some_and(|value| value == CLOUD_FORMAT_TRACKS);
    let legacy_cloud =
        !track_positions && format.is_none_or(|value| value != CLOUD_FORMAT_CHECKPOINTS);
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Remote {
            snapshot: Snapshot::empty(&c.uid),
            version: None,
            legacy_cloud,
            track_positions,
            creators,
            creator_groups,
            wide_lyric_bias,
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
        legacy_cloud,
        track_positions,
        creators,
        creator_groups,
        wide_lyric_bias,
    })
}
pub async fn write(
    c: &Config,
    s: &Secret,
    remote: &Remote,
    snapshot: &Snapshot,
) -> Result<bool, String> {
    snapshot.validate(&c.uid)?;
    let url = endpoint(c)?;
    let http = client()?;
    let mut request = auth(http.put(url), c, s).header("content-type", "application/json");
    if remote.wide_lyric_bias {
        request = request.header(WIDE_LYRIC_BIAS_HEADER, "wide");
    }
    if !remote.legacy_cloud {
        request = request.header(
            CLOUD_FORMAT_HEADER,
            if remote.creator_groups {
                CLOUD_FORMAT_GROUPS
            } else if remote.creators {
                CLOUD_FORMAT_CREATORS
            } else if remote.track_positions {
                CLOUD_FORMAT_TRACKS
            } else {
                CLOUD_FORMAT_CHECKPOINTS
            },
        );
    }
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

    #[test]
    fn legacy_server_projection_keeps_local_bias_until_the_selection_changes() {
        let mut local = Snapshot::empty("42");
        let key = "lyric:bilibili:BV123:7";
        local.records.insert(
            key.into(),
            Record {
                kind: "lyric".into(),
                fields: serde_json::from_value(serde_json::json!({
                    "id": "bilibili:BV123:7", "provider": "qq", "providerLyricId": "9",
                    "biasMs": -96_500, "manual": true,
                }))
                .unwrap(),
            },
        );
        let mut cloud = local.clone();
        project_lyric_bias(&mut cloud);
        assert_eq!(cloud.records[key].fields["biasMs"], -30_000);
        let mut remote_edit = cloud.clone();
        restore_local_lyric_bias(&mut cloud, &local);
        assert_eq!(cloud, local);
        remote_edit
            .records
            .get_mut(key)
            .unwrap()
            .fields
            .insert("providerLyricId".into(), "11".into());
        restore_local_lyric_bias(&mut remote_edit, &local);
        assert_eq!(remote_edit.records[key].fields["biasMs"], -30_000);
    }

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
