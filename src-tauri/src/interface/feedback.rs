use super::error::CommandError;
use crate::infrastructure::{
    database::{Database, account_session},
    diagnostics::now_ms,
    feedback::{
        FeedbackBody, FeedbackClient, FeedbackEnvironment, FeedbackError, FeedbackImageInput,
        FeedbackPolicy, FeedbackReceipt, FeedbackStatus, feedback_hash_hex, submission_fingerprint,
    },
    providers::bilibili::{AccountProfile, BilibiliProvider, ProviderError},
    repositories::{
        auth::AuthRepository,
        feedback_tracking::{self, PendingFeedback, TrackedFeedback},
    },
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    digest::{SHA256, digest},
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::future::Future;
use tauri::{AppHandle, State, Webview};

static SUBMIT_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackAccount {
    uid: String,
    account_session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    category: String,
    title: String,
    message: String,
    email: Option<String>,
    #[serde(default)]
    contact: String,
    consent: bool,
    policy_version: String,
    #[serde(default)]
    images: Vec<FeedbackImageInput>,
    account_session: String,
    #[serde(default = "anonymous_default")]
    anonymous: bool,
    environment: Option<FeedbackEnvironment>,
}

fn anonymous_default() -> bool {
    true
}

#[tauri::command]
pub async fn get_feedback_policy(webview: Webview) -> Result<FeedbackPolicy, CommandError> {
    require_main_window(&webview)?;
    FeedbackClient::new()
        .map_err(command_error)?
        .policy()
        .await
        .map_err(command_error)
}

#[tauri::command]
pub fn feedback_account(
    webview: Webview,
    database: State<'_, Database>,
) -> Result<Option<FeedbackAccount>, CommandError> {
    require_main_window(&webview)?;
    let c = database.0.lock().map_err(CommandError::database)?;
    current_feedback_account(&database, &c)
}

#[tauri::command]
pub async fn submit_app_feedback(
    app: AppHandle,
    webview: Webview,
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    input: FeedbackInput,
) -> Result<FeedbackReceipt, CommandError> {
    require_main_window(&webview)?;
    let _submission = SUBMIT_GATE
        .try_lock()
        .map_err(|_| CommandError::new("feedback_busy", "正在提交反馈，请稍候。", true))?;
    let platform =
        if cfg!(target_os = "android") && app.config().identifier == "app.bilimusic.large" {
            "Android Large Screen"
        } else if cfg!(target_os = "android") {
            "Android"
        } else if cfg!(target_os = "ios") {
            "iOS"
        } else if cfg!(target_env = "ohos") {
            "HarmonyOS"
        } else if cfg!(target_os = "macos") {
            "macOS"
        } else if cfg!(target_os = "windows") {
            "Windows"
        } else {
            "Linux"
        };
    submit(
        &FeedbackClient::new().map_err(command_error)?,
        &database,
        input,
        platform,
        provider.account_profile(),
    )
    .await
}

async fn submit(
    client: &FeedbackClient,
    database: &Database,
    input: FeedbackInput,
    platform: &'static str,
    verify_profile: impl Future<Output = Result<AccountProfile, ProviderError>>,
) -> Result<FeedbackReceipt, CommandError> {
    let account =
        with_feedback_account(database, &input.account_session, |_, account| Ok(account))?;
    let uid = (!input.anonymous).then_some(account.uid.as_str());
    let copyright = input.category == "copyright";
    let mut body = FeedbackBody {
        category: &input.category,
        title: input.title.trim(),
        message: input.message.trim(),
        email: input
            .email
            .as_deref()
            .map(str::trim)
            .filter(|value| copyright && !value.is_empty()),
        contact: if copyright { input.contact.trim() } else { "" },
        policy_version: &input.policy_version,
        consent: input.consent,
        platform,
        version: concat!(
            env!("CARGO_PKG_VERSION"),
            ".",
            env!("BILIMUSIC_BUILD_NUMBER")
        ),
        anonymous: input.anonymous,
        share_bilibili_uid: uid.map(|_| true),
        bilibili_uid: uid,
        tracking_key_hash: None,
        environment: input.environment.as_ref(),
    };
    body.validate().map_err(command_error)?;
    let fingerprint = if input.anonymous {
        None
    } else {
        Some(submission_fingerprint(&body, &input.images).map_err(command_error)?)
    };
    let verified_profile = verify_profile.await;
    // A profile switch replaces the connection under this lock. Recheck after
    // the remote login check so a stale draft cannot reach the feedback service.
    with_feedback_account(database, &input.account_session, |_, _| Ok(()))?;
    let profile = verified_profile.map_err(|error| match error {
        ProviderError::Api { code: -101, .. } | ProviderError::NotAuthenticated => {
            feedback_login_required()
        }
        ProviderError::AccountChanged => feedback_account_changed(),
        error => CommandError::bilibili(error),
    })?;
    let uid = profile
        .user_id
        .filter(|uid| profile.logged_in && *uid > 0)
        .ok_or_else(feedback_login_required)?;
    if uid.to_string() != account.uid {
        return Err(feedback_account_changed());
    }
    let pending = if let Some(fingerprint) = &fingerprint {
        Some(with_feedback_account(
            database,
            &input.account_session,
            |c, _| {
                if let Some(pending) =
                    feedback_tracking::pending(c, fingerprint).map_err(CommandError::database)?
                {
                    return Ok(pending);
                }
                Ok(PendingFeedback {
                    local_id: uuid::Uuid::new_v4().to_string(),
                    tracking_key: new_tracking_key()?,
                    is_new: true,
                })
            },
        )?)
    } else {
        None
    };
    let key_hash = pending
        .as_ref()
        .map(|pending| feedback_hash_hex(digest(&SHA256, pending.tracking_key.as_bytes())));
    body.tracking_key_hash = key_hash.as_deref();
    let request = client
        .prepare_submission(&body, input.images)
        .map_err(command_error)?;
    with_feedback_account(database, &input.account_session, |c, _| {
        if let (Some(pending), Some(fingerprint)) = (
            pending.as_ref().filter(|item| item.is_new),
            fingerprint.as_deref(),
        ) {
            feedback_tracking::insert_pending(c, pending, fingerprint, body.title)
                .map_err(CommandError::database)?;
        }
        Ok(())
    })?;
    let result = client.submit(request).await;
    with_feedback_account(database, &input.account_session, |c, _| {
        if let Some(pending) = &pending {
            record_submission_outcome(c, pending, &result)?;
        }
        result.map_err(command_error)
    })
}

fn new_tracking_key() -> Result<String, CommandError> {
    let mut bytes = [0; 32];
    SystemRandom::new().fill(&mut bytes).map_err(|_| {
        CommandError::new("feedback_unavailable", "暂时无法生成反馈查询凭证。", true)
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn record_submission_outcome(
    c: &rusqlite::Connection,
    pending: &PendingFeedback,
    result: &Result<FeedbackReceipt, FeedbackError>,
) -> Result<(), CommandError> {
    match result {
        Ok(receipt) => record_receipt(c, &pending.local_id, &receipt.id),
        Err(
            FeedbackError::Uncertain
            | FeedbackError::Rejected {
                status: 500..=599, ..
            },
        ) => Ok(()),
        Err(_) if pending.is_new => {
            feedback_tracking::forget_pending(c, &pending.local_id).map_err(CommandError::database)
        }
        Err(_) => Ok(()),
    }
}

fn record_receipt(c: &rusqlite::Connection, local_id: &str, id: &str) -> Result<(), CommandError> {
    if !feedback_tracking::confirm(c, local_id, id).map_err(CommandError::database)? {
        return Err(command_error(FeedbackError::Protocol));
    }
    Ok(())
}

#[tauri::command]
pub fn list_tracked_feedback(
    webview: Webview,
    database: State<'_, Database>,
    account_session: String,
) -> Result<Vec<TrackedFeedback>, CommandError> {
    require_main_window(&webview)?;
    tracked_feedback(&database, &account_session)
}

fn tracked_feedback(
    database: &Database,
    session: &str,
) -> Result<Vec<TrackedFeedback>, CommandError> {
    with_feedback_account(database, session, |c, _| {
        feedback_tracking::list(c).map_err(CommandError::database)
    })
}

#[tauri::command]
pub async fn get_tracked_feedback_status(
    webview: Webview,
    database: State<'_, Database>,
    account_session: String,
    local_id: String,
) -> Result<FeedbackStatus, CommandError> {
    require_main_window(&webview)?;
    tracked_feedback_status(
        &FeedbackClient::new().map_err(command_error)?,
        &database,
        &account_session,
        &local_id,
    )
    .await
}

async fn tracked_feedback_status(
    client: &FeedbackClient,
    database: &Database,
    session: &str,
    local_id: &str,
) -> Result<FeedbackStatus, CommandError> {
    let key = with_feedback_account(database, session, |c, _| {
        if uuid::Uuid::parse_str(local_id).is_err() {
            return Err(command_error(FeedbackError::NotFound));
        }
        feedback_tracking::key(c, local_id)
            .map_err(CommandError::database)?
            .ok_or_else(|| command_error(FeedbackError::NotFound))
    })?;
    let result = client.status(&key).await;
    with_feedback_account(database, session, |c, _| {
        let status = result.map_err(command_error)?;
        record_receipt(c, local_id, &status.id)?;
        Ok(status)
    })
}

fn with_feedback_account<T>(
    database: &Database,
    expected_session: &str,
    action: impl FnOnce(&rusqlite::Connection, FeedbackAccount) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    let account = current_feedback_account(database, &c)?.ok_or_else(feedback_login_required)?;
    if account.account_session != expected_session {
        return Err(feedback_account_changed());
    }
    action(&c, account)
}

fn feedback_login_required() -> CommandError {
    CommandError::new(
        "feedback_login_required",
        "请先登录 B 站账号后再提交反馈。",
        false,
    )
}

fn feedback_account_changed() -> CommandError {
    CommandError::new(
        "feedback_account_changed",
        "B 站账号已变更，请重新确认反馈信息。",
        false,
    )
}

fn current_feedback_account(
    database: &Database,
    c: &rusqlite::Connection,
) -> Result<Option<FeedbackAccount>, CommandError> {
    let profile = std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default();
    let Some(uid) = profile.parse::<i64>().ok().filter(|uid| *uid > 0) else {
        return Ok(None);
    };
    if !AuthRepository::get_cookie(c, "bilibili")
        .map_err(CommandError::database)?
        .is_some_and(|cookie| !cookie.trim().is_empty())
    {
        return Ok(None);
    }
    Ok(Some(FeedbackAccount {
        uid: uid.to_string(),
        account_session: account_session(c).map_err(CommandError::database)?,
    }))
}

fn require_main_window(webview: &Webview) -> Result<(), CommandError> {
    if webview.label() != "main" {
        return Err(CommandError::new(
            "feedback_unavailable",
            "请在 BiliMusic 主界面提交反馈。",
            false,
        ));
    }
    Ok(())
}

fn command_error(error: FeedbackError) -> CommandError {
    match error {
        FeedbackError::Invalid(message) => CommandError::validation(message),
        FeedbackError::Network => CommandError::new(
            "feedback_network",
            "无法连接反馈服务，请检查网络后重试。",
            true,
        ),
        FeedbackError::Uncertain => CommandError::new(
            "feedback_submit_uncertain",
            "未收到提交确认，反馈可能已经送达。",
            false,
        ),
        FeedbackError::NotFound => {
            CommandError::new("feedback_not_found", "暂时查不到这条反馈。", false)
        }
        FeedbackError::Protocol => CommandError::new(
            "feedback_unavailable",
            "反馈服务暂不可用，请稍后重试。",
            true,
        ),
        FeedbackError::PolicyChanged => CommandError::new(
            "feedback_policy_changed",
            "使用与隐私说明已更新，请重新阅读并确认。",
            false,
        ),
        FeedbackError::RateLimited { seconds, message } => {
            let mut error = CommandError::new(
                "feedback_rate_limited",
                message.unwrap_or_else(|| "提交较频繁，请稍后再试。".into()),
                true,
            );
            error.retry_at =
                seconds.map(|seconds| now_ms().saturating_add(seconds.saturating_mul(1000)));
            error.http_status = Some(429);
            error
        }
        FeedbackError::Rejected { status, message } => {
            let code = if status >= 500 || status == 404 {
                "feedback_unavailable"
            } else {
                "feedback_rejected"
            };
            let mut error = CommandError::new(
                code,
                message.unwrap_or_else(|| "反馈未提交，请稍后重试。".into()),
                status >= 500 || status == 404,
            );
            error.http_status = Some(status);
            error
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    use serde_json::{Value, json};
    use std::{path::PathBuf, time::Duration};
    use tokio::net::TcpListener;

    fn test_database() -> (Database, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("bilimusic-feedback-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let database = Database(
            std::sync::Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            directory.clone(),
        );
        (database, directory)
    }

    fn snapshot(database: &Database) -> Option<FeedbackAccount> {
        current_feedback_account(database, &database.0.lock().unwrap()).unwrap()
    }

    fn profile(uid: i64) -> AccountProfile {
        AccountProfile {
            logged_in: true,
            user_id: Some(uid),
            name: None,
            avatar_url: None,
            level: None,
            senior_member: None,
            vip_active: None,
            vip_type: None,
            vip_theme: None,
            vip_label: None,
        }
    }

    fn draft(account_session: &str) -> Value {
        json!({
            "category":"bug", "title":"测试标题", "message":"这是一个提交账号会话相关的测试反馈。",
            "consent":true, "policyVersion":"2026-11-28", "accountSession":account_session,
        })
    }

    async fn test_client() -> (FeedbackClient, TcpListener) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = FeedbackClient::for_test(format!("http://{}", listener.local_addr().unwrap()));
        (client, listener)
    }

    #[tokio::test]
    async fn session_is_required_even_when_the_user_keeps_uid_private() {
        let (database, directory) = test_database();
        let mut value = draft("invalid-session");
        assert!(snapshot(&database).is_none());
        value.as_object_mut().unwrap().remove("accountSession");
        assert!(serde_json::from_value::<FeedbackInput>(value).is_err());
        let (client, listener) = test_client().await;
        let result = submit(
            &client,
            &database,
            serde_json::from_value(draft("invalid-session")).unwrap(),
            "macOS",
            async { panic!("verify B 站 login with an invalid local session") },
        )
        .await
        .unwrap_err();
        assert_eq!(result.code, "feedback_login_required");
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn switching_back_to_the_same_uid_invalidates_consent_during_verification() {
        let (database, directory) = test_database();
        database.switch(Some(42), Some("SESSDATA=private")).unwrap();
        let old = snapshot(&database).unwrap();
        assert_eq!(old.uid, "42");
        let (client, listener) = test_client().await;
        let result = submit(
            &client,
            &database,
            serde_json::from_value(draft(&old.account_session)).unwrap(),
            "macOS",
            async {
                database.switch(None, None).unwrap();
                database
                    .switch(Some(42), Some("SESSDATA=new-private"))
                    .unwrap();
                Ok(profile(42))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(result.code, "feedback_account_changed");
        assert_ne!(
            old.account_session,
            snapshot(&database).unwrap().account_session
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn expired_bilibili_login_cannot_send_feedback_without_uid() {
        let (database, directory) = test_database();
        database.switch(Some(42), Some("SESSDATA=expired")).unwrap();
        let account = snapshot(&database).unwrap();
        let (client, listener) = test_client().await;
        let result = submit(
            &client,
            &database,
            serde_json::from_value(draft(&account.account_session)).unwrap(),
            "macOS",
            async {
                Err(ProviderError::Api {
                    code: -101,
                    message: String::new(),
                })
            },
        )
        .await
        .unwrap_err();
        assert_eq!(result.code, "feedback_login_required");
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn hides_identity_and_contacts_for_anonymous_feedback_and_keeps_copyright_contacts() {
        let (database, directory) = test_database();
        database.switch(Some(42), Some("SESSDATA=private")).unwrap();
        let account = snapshot(&database).unwrap();
        let session_for_server = account.account_session.clone();
        let (client, listener) = test_client().await;
        let router = Router::new().route(
            "/api/v1/app/feedback",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let server_session = session_for_server.clone();
                async move {
                    assert!(!headers.contains_key("cookie"));
                    assert!(!headers.contains_key("authorization"));
                    let text = body.to_string();
                    assert!(!text.contains("SESSDATA"));
                    assert!(!text.contains(&server_session));
                    for field in [
                        "accountSession",
                        "trackingKey",
                        "bilibiliUid",
                        "shareBilibiliUid",
                        "trackingKeyHash",
                    ] {
                        assert!(body.get(field).is_none());
                    }
                    assert_eq!(body["anonymous"], true);
                    if body["category"] == "copyright" {
                        assert_eq!(body["email"], "tester+feedback@example.com");
                        assert_eq!(body["contact"], "QQ 123456");
                    } else {
                        assert!(body.get("email").is_none());
                        assert!(body.get("contact").is_none());
                    }
                    Json(json!({"id":"4a19e123-ae8c-417a-b49c-e91f550d6dc3"}))
                }
            }),
        );
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut private = draft(&account.account_session);
        private["email"] = json!("does-not-send@example.com");
        private["contact"] = json!("does not send");
        let mut shared = draft(&account.account_session);
        shared["category"] = json!("copyright");
        shared["anonymous"] = json!(true);
        shared["email"] = json!(" tester+feedback@example.com  ");
        shared["contact"] = json!(" QQ 123456 ");
        shared["uid"] = json!("666");
        for value in [private, shared] {
            submit(
                &client,
                &database,
                serde_json::from_value(value).unwrap(),
                "macOS",
                async { Ok(profile(42)) },
            )
            .await
            .unwrap();
        }
        assert!(
            tracked_feedback(&database, &account.account_session)
                .unwrap()
                .is_empty()
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn lost_receipt_recovers_with_the_persisted_capability_and_reuses_it_on_retry() {
        use std::sync::{Arc, Mutex};
        const RECEIPT: &str = "4a19e123-ae8c-417a-b49c-e91f550d6dc3";
        let (database, directory) = test_database();
        database.switch(Some(42), Some("SESSDATA=private")).unwrap();
        let account = snapshot(&database).unwrap();
        let (client, listener) = test_client().await;
        let submitted_hashes = Arc::new(Mutex::new(Vec::<String>::new()));
        let downloads = submitted_hashes.clone();
        let statuses = submitted_hashes.clone();
        let router = Router::new().route("/api/v1/app/feedback", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let hashes = downloads.clone();
            async move {
                for field in ["trackingKey", "accountSession", "email", "contact"] {
                    assert!(body.get(field).is_none());
                }
                assert!(!headers.contains_key("cookie"));
                assert_eq!(body["anonymous"], false);
                assert_eq!(body["bilibiliUid"], "42");
                assert_eq!(body["shareBilibiliUid"], true);
                hashes.lock().unwrap().push(body["trackingKeyHash"].as_str().unwrap().into());
                (StatusCode::CREATED, "interrupted receipt")
            }
        })).route("/api/v1/app/feedback/status", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let hashes = statuses.clone();
            async move {
                let key = body["trackingKey"].as_str().unwrap();
                assert_eq!(body.as_object().unwrap().len(), 1);
                assert!(!headers.contains_key("cookie"));
                assert_eq!(key.len(), 43);
                assert_eq!(URL_SAFE_NO_PAD.decode(key).unwrap().len(), 32);
                let hash = feedback_hash_hex(digest(&SHA256, key.as_bytes()));
                for sent in hashes.lock().unwrap().iter() {
                    assert_eq!(sent, &hash);
                }
                Json(json!({"id":RECEIPT,"status":"closed","createdAt":"2026-11-28T00:00:00.000Z",
                    "completedAt":"2026-11-28T00:01:00.000Z",
                    "replies":[{"id":"r1","body":"感谢反馈","createdAt":"2026-11-28T00:01:00.000Z"}],
                    "trackingKey":key,"internalNote":"private"}))
            }
        }));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut value = draft(&account.account_session);
        value["anonymous"] = json!(false);
        value["bilibiliUid"] = json!("666");
        value["email"] = json!("does-not-send@example.com");
        for _ in 0..2 {
            let failure = submit(
                &client,
                &database,
                serde_json::from_value(value.clone()).unwrap(),
                "macOS",
                async { Ok(profile(42)) },
            )
            .await
            .unwrap_err();
            assert_eq!(failure.code, "feedback_submit_uncertain");
        }
        assert_eq!(submitted_hashes.lock().unwrap().len(), 2);
        let mut list = tracked_feedback(&database, &account.account_session).unwrap();
        assert_eq!(list.len(), 1);
        let local = list.pop().unwrap();
        assert!(local.id.is_none());
        let local_wire = serde_json::to_value(&local).unwrap();
        assert_eq!(local_wire.as_object().unwrap().len(), 3);
        database.switch(Some(43), Some("SESSDATA=other")).unwrap();
        let other = snapshot(&database).unwrap();
        assert!(
            tracked_feedback(&database, &other.account_session)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            tracked_feedback(&database, &account.account_session)
                .err()
                .unwrap()
                .code,
            "feedback_account_changed"
        );
        let denied =
            tracked_feedback_status(&client, &database, &other.account_session, &local.local_id)
                .await
                .unwrap_err();
        assert_eq!(denied.code, "feedback_not_found");
        database.switch(Some(42), Some("SESSDATA=private")).unwrap();
        let renewed = snapshot(&database).unwrap();
        let status = tracked_feedback_status(
            &client,
            &database,
            &renewed.account_session,
            &local.local_id,
        )
        .await
        .unwrap();
        let wire = serde_json::to_value(status).unwrap();
        assert_eq!(wire["status"], "closed");
        assert_eq!(wire["replies"][0]["body"], "感谢反馈");
        assert!(wire.get("trackingKey").is_none());
        assert!(wire.get("internalNote").is_none());
        assert_eq!(
            tracked_feedback(&database, &renewed.account_session).unwrap()[0]
                .id
                .as_deref(),
            Some(RECEIPT)
        );
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn status_not_found_is_distinct_from_switching_accounts_during_lookup() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let (database, directory) = test_database();
        let database = Arc::new(database);
        database.switch(Some(42), Some("SESSDATA=test")).unwrap();
        let account = snapshot(&database).unwrap();
        let local = PendingFeedback {
            local_id: uuid::Uuid::new_v4().to_string(),
            tracking_key: new_tracking_key().unwrap(),
            is_new: true,
        };
        with_feedback_account(&database, &account.account_session, |connection, _| {
            feedback_tracking::insert_pending(connection, &local, "pending", "测试待确认反馈")
                .unwrap();
            Ok(())
        })
        .unwrap();
        let (client, listener) = test_client().await;
        let switch_on_lookup = Arc::new(AtomicBool::new(false));
        let mock_database = Arc::clone(&database);
        let switch_on_request = Arc::clone(&switch_on_lookup);
        let router = Router::new().route(
            "/api/v1/app/feedback/status",
            post(move || {
                let mock_database = Arc::clone(&mock_database);
                let switch = switch_on_request.load(Ordering::Relaxed);
                async move {
                    if switch {
                        mock_database
                            .switch(Some(43), Some("SESSDATA=next"))
                            .unwrap();
                    }
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({"code":"feedback_not_found"})),
                    )
                }
            }),
        );
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let lookup = || {
            tracked_feedback_status(
                &client,
                &database,
                &account.account_session,
                &local.local_id,
            )
        };
        assert_eq!(lookup().await.unwrap_err().code, "feedback_not_found");
        switch_on_lookup.store(true, Ordering::Relaxed);
        assert_eq!(lookup().await.unwrap_err().code, "feedback_account_changed");
        let other = snapshot(&database).unwrap();
        assert!(
            tracked_feedback(&database, &other.account_session)
                .unwrap()
                .is_empty()
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
