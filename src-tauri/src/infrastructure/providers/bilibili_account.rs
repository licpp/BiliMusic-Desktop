use super::{
    AccountProfile, BilibiliProvider, ProviderError, QrLogin, QrLoginStatus, RequestPriority,
    envelope_data, normalize_url, requests, response_json, safe_network_error, session_uid,
};
use reqwest::{Url, header::SET_COOKIE};
use serde::Deserialize;

#[derive(Deserialize)]
struct QrGenerateData {
    url: String,
    qrcode_key: String,
}

#[derive(Deserialize)]
struct QrPollData {
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct NavData {
    #[serde(default, rename = "isLogin")]
    is_login: bool,
    #[serde(default)]
    mid: i64,
    #[serde(default)]
    uname: String,
    #[serde(default)]
    face: String,
    #[serde(default, rename = "level_info")]
    level: Option<NavLevel>,
    #[serde(default)]
    is_senior_member: Option<i64>,
    #[serde(default, rename = "vipStatus")]
    vip_status: Option<i64>,
    #[serde(default, rename = "vipType")]
    vip_type: Option<i64>,
    #[serde(default)]
    vip_label: Option<NavVipLabel>,
    #[serde(default)]
    vip: Option<NavVip>,
}

#[derive(Deserialize)]
struct NavLevel {
    current_level: Option<i64>,
}

#[derive(Deserialize, Default)]
struct NavVip {
    #[serde(default)]
    status: Option<i64>,
    #[serde(default, rename = "type")]
    kind: Option<i64>,
    #[serde(default)]
    label: Option<NavVipLabel>,
}

#[derive(Deserialize, Default)]
struct NavVipLabel {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    label_theme: Option<String>,
}

impl BilibiliProvider {
    pub async fn qr_login_generate(&self) -> Result<QrLogin, ProviderError> {
        let data: QrGenerateData = self
            .get_data(
                Url::parse("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
                    .expect("static login URL"),
            )
            .await?;
        Ok(QrLogin {
            key: data.qrcode_key,
            url: data.url,
        })
    }

    pub async fn qr_login_poll(&self, key: &str) -> Result<QrLoginStatus, ProviderError> {
        let mut url = Url::parse("https://passport.bilibili.com/x/passport-login/web/qrcode/poll")
            .expect("static login URL");
        url.query_pairs_mut().append_pair("qrcode_key", key);
        let (epoch, session) = self.request_session().await;
        let lease = self
            .requests
            .acquire(
                requests::Stage::Account,
                session_uid(session.as_deref()),
                RequestPriority::Background,
                true,
            )
            .await?;
        self.check_request_epoch(epoch)?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(safe_network_error)?;
        let cookies = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .filter_map(|value| value.split(';').next())
            .collect::<Vec<_>>()
            .join("; ");
        let (status, headers, json) = response_json(response, &lease, false).await?;
        let data: QrPollData = envelope_data(&lease, status, &headers, json, false)?;
        self.check_request_epoch(epoch)?;
        let status = match data.code {
            0 => "authenticated",
            86090 => "confirmed",
            86101 => "waiting",
            86038 => "expired",
            _ => "error",
        };
        let cookie_header = if data.code == 0 && !cookies.is_empty() {
            Some(cookies)
        } else {
            None
        };
        Ok(QrLoginStatus {
            status: status.into(),
            message: data.message,
            cookie_header,
        })
    }

    pub async fn account_profile(&self) -> Result<AccountProfile, ProviderError> {
        self.account_profile_with_priority(RequestPriority::Foreground)
            .await
    }

    pub async fn account_profile_with_priority(
        &self,
        priority: RequestPriority,
    ) -> Result<AccountProfile, ProviderError> {
        if self.session_cookie.read().await.is_none() {
            return Ok(AccountProfile {
                logged_in: false,
                user_id: None,
                name: None,
                avatar_url: None,
                level: None,
                senior_member: None,
                vip_active: None,
                vip_type: None,
                vip_theme: None,
                vip_label: None,
            });
        }
        let data: NavData = self
            .get_data_with_priority(self.api_url("/x/web-interface/nav"), priority)
            .await?;
        Ok(account_profile_from_nav(data))
    }
}

fn account_profile_from_nav(data: NavData) -> AccountProfile {
    let vip_status = data
        .vip_status
        .or_else(|| data.vip.as_ref().and_then(|vip| vip.status));
    let vip_active = vip_status
        .filter(|_| data.is_login)
        .map(|status| status == 1);
    let active = vip_active == Some(true);
    let vip_type = data
        .vip_type
        .or_else(|| data.vip.as_ref().and_then(|vip| vip.kind))
        .filter(|_| data.is_login && active);
    let label_source = data
        .vip_label
        .as_ref()
        .or_else(|| data.vip.as_ref().and_then(|vip| vip.label.as_ref()));
    let vip_theme = if data.is_login && active {
        label_source
            .and_then(|label| label.label_theme.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    let vip_label = if data.is_login && active {
        label_source
            .and_then(|label| label.text.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    AccountProfile {
        logged_in: data.is_login,
        user_id: data.is_login.then_some(data.mid),
        name: data.is_login.then_some(data.uname),
        avatar_url: data.is_login.then_some(normalize_url(&data.face)),
        level: data
            .level
            .filter(|_| data.is_login)
            .and_then(|level| level.current_level),
        senior_member: data
            .is_senior_member
            .filter(|_| data.is_login)
            .map(|value| value == 1),
        vip_active,
        vip_type,
        vip_theme,
        vip_label,
    }
}

#[cfg(test)]
mod nav_profile_tests {
    use super::{BilibiliProvider, NavData, account_profile_from_nav};

    #[tokio::test]
    async fn failed_database_commit_preserves_the_provider_session() {
        let active = BilibiliProvider::new().unwrap();
        active
            .set_session_cookie(Some("SESSDATA=original".into()))
            .await;
        let original = active.request_session().await;
        let result = active
            .commit_session_cookie(Some("SESSDATA=candidate".into()), || Err("write failed"))
            .await;
        assert_eq!(result, Err("write failed"));
        assert_eq!(active.request_session().await, original);
        active
            .commit_session_cookie(Some("SESSDATA=candidate".into()), || Ok::<_, ()>(()))
            .await
            .unwrap();
        let (epoch, cookie) = active.request_session().await;
        assert_ne!(epoch, original.0);
        assert_eq!(cookie.as_deref(), Some("SESSDATA=candidate"));
    }

    #[test]
    fn parses_vip_tiers_and_senior_member_from_nav() {
        let ten_year: NavData = serde_json::from_str(
            r#"{
                    "isLogin": true,
                    "mid": 42,
                    "uname": "音乐旅人",
                    "face": "http://i0.hdslb.com/a.jpg",
                    "level_info": { "current_level": 6 },
                    "is_senior_member": 1,
                    "vipStatus": 1,
                    "vipType": 2,
                    "vip_label": { "text": "十年大会员", "label_theme": "ten_annual_vip" }
                }"#,
        )
        .expect("ten year nav");
        let profile = account_profile_from_nav(ten_year);
        assert_eq!(profile.level, Some(6));
        assert_eq!(profile.senior_member, Some(true));
        assert_eq!(profile.vip_active, Some(true));
        assert_eq!(profile.vip_type, Some(2));
        assert_eq!(profile.vip_theme.as_deref(), Some("ten_annual_vip"));
        assert_eq!(profile.vip_label.as_deref(), Some("十年大会员"));

        let expired: NavData = serde_json::from_str(
            r#"{
                    "isLogin": true,
                    "mid": 43,
                    "uname": "旧会员",
                    "face": "https://i0.hdslb.com/b.jpg",
                    "level_info": { "current_level": 5 },
                    "vipStatus": 0,
                    "vipType": 2,
                    "vip_label": { "text": "年度大会员", "label_theme": "annual_vip" }
                }"#,
        )
        .expect("expired nav");
        let expired_profile = account_profile_from_nav(expired);
        assert_eq!(expired_profile.vip_active, Some(false));
        assert_eq!(expired_profile.vip_type, None);
        assert_eq!(expired_profile.vip_theme, None);
        assert_eq!(expired_profile.vip_label, None);
    }
}
