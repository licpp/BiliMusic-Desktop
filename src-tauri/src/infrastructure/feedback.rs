use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{Client, Request, Response, StatusCode, header, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const SITE: &str = "https://bilimusic.cn";
const POLICY_PATH: &str = "/api/v1/policy";
const FEEDBACK_PATH: &str = "/api/v1/app/feedback";
const STATUS_PATH: &str = "/api/v1/app/feedback/status";
const MAX_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_TEXT_BYTES: usize = 24_000;
const MAX_IMAGES: usize = 3;
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum FeedbackError {
    Invalid(&'static str),
    Network,
    Uncertain,
    NotFound,
    Protocol,
    PolicyChanged,
    RateLimited {
        seconds: Option<u64>,
        message: Option<String>,
    },
    Rejected {
        status: u16,
        message: Option<String>,
    },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct FeedbackPolicy {
    pub version: String,
    pub title: String,
    pub sections: Vec<[String; 2]>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct FeedbackReceipt {
    pub id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackStatusValue {
    New,
    InProgress,
    Resolved,
    Closed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackStatus {
    pub id: String,
    status: FeedbackStatusValue,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_changed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    replies: Vec<FeedbackReply>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackReply {
    id: String,
    body: String,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackImageInput {
    // Original filenames are unnecessary and may contain user information.
    pub mime_type: String,
    pub base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEnvironment {
    system: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_build: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_level: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    architecture: Option<String>,
    webview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    webview_package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    large_screen: Option<bool>,
}

impl FeedbackEnvironment {
    fn validate(&self) -> Result<(), FeedbackError> {
        let invalid_text = [
            (Some(self.system.as_str()), 193),
            (Some(self.webview.as_str()), 96),
            (self.system_build.as_deref(), 96),
            (self.device_model.as_deref(), 96),
            (self.architecture.as_deref(), 96),
            (self.webview_package.as_deref(), 96),
        ]
        .into_iter()
        .filter_map(|(value, max)| value.map(|value| (value, max)))
        .any(|(value, max)| {
            value.trim().is_empty()
                || value.trim().encode_utf16().count() > max
                || value
                    .chars()
                    .any(|ch| ch.is_control() || ":\\=\u{2028}\u{2029}".contains(ch))
        });
        if invalid_text || self.api_level == Some(0) {
            return Err(FeedbackError::Invalid(
                "设备环境信息无效，请重新加载后再提交。",
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackBody<'a> {
    pub category: &'a str,
    pub title: &'a str,
    pub message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<&'a str>,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub contact: &'a str,
    pub consent: bool,
    pub policy_version: &'a str,
    pub platform: &'static str,
    pub version: &'static str,
    pub anonymous: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_bilibili_uid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bilibili_uid: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_key_hash: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<&'a FeedbackEnvironment>,
}

impl FeedbackBody<'_> {
    pub fn validate(&self) -> Result<(), FeedbackError> {
        if !self.consent || self.policy_version.trim().is_empty() || self.policy_version.len() > 80
        {
            return Err(FeedbackError::Invalid("请阅读并同意最新的使用与隐私说明。"));
        }
        if !matches!(self.category, "bug" | "suggestion" | "copyright" | "other") {
            return Err(FeedbackError::Invalid("请选择反馈类型。"));
        }
        for (value, min, max, error) in [
            (self.title, 3, 120, "标题请填写 3 至 120 个字符。"),
            (self.message, 10, 5000, "描述请填写 10 至 5000 个字符。"),
            (self.contact, 0, 200, "联系方式最多 200 个字符。"),
        ] {
            if !(min..=max).contains(&value.encode_utf16().count()) || value.contains('\0') {
                return Err(FeedbackError::Invalid(error));
            }
        }
        if self.email.is_some_and(|email| !valid_email(email)) {
            return Err(FeedbackError::Invalid("请输入有效的电子邮箱地址。"));
        }
        if self.category == "copyright" && self.email.is_none() && self.contact.is_empty() {
            return Err(FeedbackError::Invalid("版权与权利反馈请留下联系方式。"));
        }
        if let Some(environment) = self.environment {
            environment.validate()?;
        }
        Ok(())
    }
}

fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    email.len() <= 254
        && !local.is_empty()
        && local.len() <= 64
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&byte))
        && domain.contains('.')
        && domain.split('.').all(|label| {
            let bytes = label.as_bytes();
            bytes.len() <= 63
                && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
                && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
                && bytes
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        })
}

pub struct FeedbackClient {
    client: Client,
    #[cfg(test)]
    test_origin: Option<String>,
}

impl FeedbackClient {
    pub fn new() -> Result<Self, FeedbackError> {
        Ok(Self {
            client: Self::builder()
                .https_only(true)
                .build()
                .map_err(|_| FeedbackError::Network)?,
            #[cfg(test)]
            test_origin: None,
        })
    }

    fn builder() -> reqwest::ClientBuilder {
        Client::builder()
            .cookie_store(false)
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
    }

    #[cfg(test)]
    pub(crate) fn for_test(origin: String) -> Self {
        Self {
            client: Self::builder().no_proxy().build().unwrap(),
            test_origin: Some(origin),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        #[cfg(test)]
        if let Some(origin) = &self.test_origin {
            return format!("{origin}{path}");
        }
        format!("{SITE}{path}")
    }

    pub async fn policy(&self) -> Result<FeedbackPolicy, FeedbackError> {
        let response = self
            .client
            .get(self.endpoint(POLICY_PATH))
            .send()
            .await
            .map_err(|_| FeedbackError::Network)?;
        let policy: FeedbackPolicy = read_json(accepted_response(response).await?).await?;
        if policy.version.trim().is_empty()
            || policy.version.len() > 80
            || policy.title.trim().is_empty()
            || policy.sections.is_empty()
        {
            return Err(FeedbackError::Protocol);
        }
        Ok(policy)
    }

    pub fn prepare_submission(
        &self,
        input: &FeedbackBody<'_>,
        images: Vec<FeedbackImageInput>,
    ) -> Result<Request, FeedbackError> {
        input.validate()?;
        let payload = serde_json::to_vec(input).map_err(|_| FeedbackError::Protocol)?;
        if payload.len() > MAX_TEXT_BYTES {
            return Err(FeedbackError::Invalid("反馈内容过长。"));
        }
        let (content_type, body) = if images.is_empty() {
            ("application/json".to_owned(), payload)
        } else {
            encode_multipart(payload, images)?
        };
        self.client
            .post(self.endpoint(FEEDBACK_PATH))
            .header(header::CONTENT_TYPE, content_type)
            .body(body)
            .build()
            .map_err(|_| FeedbackError::Protocol)
    }

    pub async fn status(&self, tracking_key: &str) -> Result<FeedbackStatus, FeedbackError> {
        let response = self
            .client
            .post(self.endpoint(STATUS_PATH))
            .json(&serde_json::json!({"trackingKey": tracking_key}))
            .send()
            .await
            .map_err(|_| FeedbackError::Network)?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(FeedbackError::NotFound);
        }
        let status: FeedbackStatus = read_json(accepted_response(response).await?).await?;
        if uuid::Uuid::parse_str(&status.id).is_err() {
            return Err(FeedbackError::Protocol);
        }
        Ok(status)
    }

    pub async fn submit(&self, request: Request) -> Result<FeedbackReceipt, FeedbackError> {
        let response = self.client.execute(request).await.map_err(|error| {
            if error.is_connect() {
                FeedbackError::Network
            } else {
                FeedbackError::Uncertain
            }
        })?;
        let receipt: FeedbackReceipt = read_json(accepted_response(response).await?)
            .await
            .map_err(|_| FeedbackError::Uncertain)?;
        if uuid::Uuid::parse_str(&receipt.id).is_err() {
            return Err(FeedbackError::Uncertain);
        }
        Ok(receipt)
    }
}

pub fn submission_fingerprint(
    body: &FeedbackBody<'_>,
    images: &[FeedbackImageInput],
) -> Result<String, FeedbackError> {
    use ring::digest::{Context, SHA256};
    if images.len() > MAX_IMAGES {
        return Err(FeedbackError::Invalid("最多上传 3 张图片。"));
    }
    let mut fingerprint = Context::new(&SHA256);
    fingerprint.update(&serde_json::to_vec(body).map_err(|_| FeedbackError::Protocol)?);
    for image in images {
        if image.base64.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err(FeedbackError::Invalid("每张图片最多 2 MB。"));
        }
        for value in [&image.mime_type, &image.base64] {
            fingerprint.update(&(value.len() as u64).to_le_bytes());
            fingerprint.update(value.as_bytes());
        }
    }
    Ok(feedback_hash_hex(fingerprint.finish()))
}

pub fn feedback_hash_hex(hash: ring::digest::Digest) -> String {
    hash.as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn encode_multipart(
    payload: Vec<u8>,
    images: Vec<FeedbackImageInput>,
) -> Result<(String, Vec<u8>), FeedbackError> {
    if images.len() > MAX_IMAGES {
        return Err(FeedbackError::Invalid("最多上传 3 张图片。"));
    }
    let boundary = format!("bilimusic-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(payload.len() + 512);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"feedback\"\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(&payload);
    body.extend_from_slice(b"\r\n");
    for (index, image) in images.into_iter().enumerate() {
        if image.base64.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err(FeedbackError::Invalid("每张图片最多 2 MB。"));
        }
        let bytes = STANDARD
            .decode(image.base64)
            .map_err(|_| FeedbackError::Invalid("无法读取图片，请重新选择。"))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(FeedbackError::Invalid("每张图片最多 2 MB。"));
        }
        let extension = match image.mime_type.as_str() {
            "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
            "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") => "jpg",
            "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
                "webp"
            }
            _ => return Err(FeedbackError::Invalid("图片须为 JPEG、PNG 或 WebP。")),
        };
        let mime = image.mime_type;
        let number = index + 1;
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"images\"; filename=\"image-{number}.{extension}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(&bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

#[derive(Deserialize)]
struct Rejection {
    code: Option<String>,
    message: Option<String>,
}

async fn accepted_response(response: Response) -> Result<Response, FeedbackError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let retry_seconds = response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let rejection = read_json::<Rejection>(response).await.ok();
    let code = rejection.as_ref().and_then(|notice| notice.code.as_deref());
    if status == StatusCode::CONFLICT || code == Some("feedback_policy_changed") {
        return Err(FeedbackError::PolicyChanged);
    }
    let message = rejection.and_then(|notice| notice.message).filter(|text| {
        !text.trim().is_empty()
            && text.chars().count() <= 240
            && !text.chars().any(char::is_control)
    });
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(FeedbackError::RateLimited {
            seconds: retry_seconds,
            message,
        });
    }
    Err(FeedbackError::Rejected {
        status: status.as_u16(),
        message,
    })
}

async fn read_json<T: serde::de::DeserializeOwned>(
    mut response: Response,
) -> Result<T, FeedbackError> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(FeedbackError::Protocol);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FeedbackError::Network)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(FeedbackError::Protocol);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| FeedbackError::Protocol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        body::Bytes,
        http::HeaderMap,
        routing::{get, post},
    };
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    const ID: &str = "4a19e123-ae8c-417a-b49c-e91f550d6dc3";

    fn body() -> FeedbackBody<'static> {
        FeedbackBody {
            category: "bug",
            title: "下载列表描述",
            message: "在本地离线下载页面遇到了一个问题。",
            email: None,
            contact: "",
            policy_version: "2026-11-28",
            consent: true,
            platform: "Android Large Screen",
            version: "0.4.6.3",
            anonymous: true,
            share_bilibili_uid: None,
            bilibili_uid: None,
            tracking_key_hash: None,
            environment: None,
        }
    }

    async fn mock(router: Router) -> FeedbackClient {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        FeedbackClient::for_test(format!("http://{address}"))
    }

    #[tokio::test]
    async fn fetches_current_policy_and_submits_anonymous_json_without_a_cookie() {
        let client = mock(Router::new()
            .route(POLICY_PATH, get(|| async {
                ([(header::SET_COOKIE, "SESSDATA=must-not-be-reused; Path=/")],
                 Json(json!({"version":"2026-11-28","title":"声明","sections":[["隐私","详情"],["内容","限制"]]})))
            }))
            .route(FEEDBACK_PATH, post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert!(!headers.contains_key(header::COOKIE));
                assert!(!headers.contains_key(header::ORIGIN));
                assert_eq!(headers[header::CONTENT_TYPE], "application/json");
                assert_eq!(body["platform"], "Android Large Screen");
                assert_eq!(body["policyVersion"], "2026-11-28");
                assert_eq!(body["anonymous"], true);
                for key in ["contact", "email", "bilibiliUid", "shareBilibiliUid", "trackingKeyHash", "environment", "accountSession"] {
                    assert!(body.get(key).is_none());
                }
                (StatusCode::CREATED, Json(json!({"id":ID})))
            }))).await;
        let policy = client.policy().await.unwrap();
        assert_eq!(policy.version, "2026-11-28");
        assert_eq!(policy.sections.len(), 2);
        let request = client.prepare_submission(&body(), vec![]).unwrap();
        let receipt = client.submit(request).await.unwrap();
        assert_eq!(receipt.id, ID);
    }

    #[tokio::test]
    async fn submits_only_selected_metadata_and_renames_images_in_multipart() {
        let client = mock(Router::new().route(
            FEEDBACK_PATH,
            post(|headers: HeaderMap, bytes: Bytes| async move {
                assert!(!headers.contains_key(header::COOKIE));
                let boundary = headers[header::CONTENT_TYPE]
                    .to_str()
                    .unwrap()
                    .strip_prefix("multipart/form-data; boundary=")
                    .unwrap();
                assert!(bytes.ends_with(format!("--{boundary}--\r\n").as_bytes()));
                let text = String::from_utf8_lossy(&bytes);
                let json = text
                    .split("name=\"feedback\"\r\n\r\n")
                    .nth(1)
                    .unwrap()
                    .split("\r\n")
                    .next()
                    .unwrap();
                let value: Value = serde_json::from_str(json).unwrap();
                assert_eq!(value["anonymous"], false);
                assert_eq!(value["shareBilibiliUid"], true);
                assert_eq!(value["bilibiliUid"], "42");
                assert_eq!(value["trackingKeyHash"], "a".repeat(64));
                assert_eq!(value["environment"]["apiLevel"], 34);
                assert!(value.get("accountSession").is_none());
                assert!(text.contains(
                    "name=\"images\"; filename=\"image-1.png\"\r\nContent-Type: image/png"
                ));
                assert!(
                    bytes
                        .windows(8)
                        .any(|window| window == b"\x89PNG\r\n\x1a\n")
                );
                assert!(!text.contains("private.png"));
                Json(json!({"id":ID}))
            }),
        ))
        .await;
        let environment = serde_json::from_value(json!({"system":"Android 14","apiLevel":34,"webview":"Android WebView 130.0","largeScreen":false})).unwrap();
        let mut data = body();
        data.anonymous = false;
        data.share_bilibili_uid = Some(true);
        data.bilibili_uid = Some("42");
        let digest = "a".repeat(64);
        data.tracking_key_hash = Some(&digest);
        data.environment = Some(&environment);
        let image = serde_json::from_value(json!({"name":"private.png","mimeType":"image/png","base64":STANDARD.encode(b"\x89PNG\r\n\x1a\nPNG data")})).unwrap();
        let request = client.prepare_submission(&data, vec![image]).unwrap();
        assert_eq!(client.submit(request).await.unwrap().id, ID);
    }

    #[tokio::test]
    async fn refuses_redirects_and_reports_policy_changes() {
        let client = mock(
            Router::new()
                .route(
                    POLICY_PATH,
                    get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/redirect")]) }),
                )
                .route("/redirect", get(|| async { StatusCode::IM_A_TEAPOT }))
                .route(
                    FEEDBACK_PATH,
                    post(|| async {
                        (
                            StatusCode::CONFLICT,
                            Json(json!({"code":"feedback_policy_changed"})),
                        )
                    }),
                ),
        )
        .await;
        assert!(matches!(
            client.policy().await,
            Err(FeedbackError::Rejected { status: 302, .. })
        ));
        let request = client.prepare_submission(&body(), vec![]).unwrap();
        assert!(matches!(
            client.submit(request).await,
            Err(FeedbackError::PolicyChanged)
        ));
    }

    #[test]
    fn validates_optional_email_and_requires_a_reply_channel_for_copyright() {
        for valid in ["a@example.com", "user.name+label@a-b.example.com"] {
            assert!(valid_email(valid), "{valid}");
        }
        for invalid in [
            "a@localhost",
            "a b@example.com",
            "a@sub..example.com",
            "a@-example.com",
            "a@example-.com",
            ".a@example.com",
            "a.@example.com",
            "a..b@example.com",
            "a@b@example.com",
            "用户名@example.com",
            "a@测试.com",
        ] {
            assert!(!valid_email(invalid), "{invalid}");
        }
        assert!(!valid_email(&format!("{}@example.com", "a".repeat(65))));
        assert!(!valid_email(&format!("x@{}.com", "a".repeat(64))));
        let mut data = body();
        data.category = "copyright";
        data.share_bilibili_uid = Some(true);
        data.bilibili_uid = Some("42");
        assert!(matches!(data.validate(), Err(FeedbackError::Invalid(_))));
        data.email = Some("reply@example.com");
        assert!(data.validate().is_ok());
        data.email = None;
        data.contact = "QQ 123456";
        assert!(data.validate().is_ok());
    }

    #[tokio::test]
    async fn preserves_rate_limit_message_and_retry_delay() {
        let client = mock(Router::new().route(
            FEEDBACK_PATH,
            post(|| async {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(header::RETRY_AFTER, "120")],
                    Json(json!({"code":"feedback_rate_limited","message":"反馈次数已达上限，请稍后再试。"})),
                )
            }),
        ))
        .await;
        let request = client.prepare_submission(&body(), vec![]).unwrap();
        assert!(matches!(
            client.submit(request).await,
            Err(FeedbackError::RateLimited { seconds: Some(120), message: Some(message) })
                if message == "反馈次数已达上限，请稍后再试。"
        ));
    }
}
