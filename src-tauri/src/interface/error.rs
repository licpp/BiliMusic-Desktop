use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<&'static str>,
}

impl CommandError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            retry_at: None,
            http_status: None,
            upstream_code: None,
            stage: None,
        }
    }

    pub fn provider(error: impl std::fmt::Display) -> Self {
        Self::new("provider_error", error.to_string(), true)
    }

    pub fn bilibili(error: crate::infrastructure::providers::bilibili::ProviderError) -> Self {
        use crate::infrastructure::providers::bilibili::ProviderError;
        let message = error.to_string();
        match error {
            ProviderError::RateLimited(restriction)
            | ProviderError::VerificationRequired(restriction) => {
                let rate_limited = restriction.retry_at.is_some();
                let code = if rate_limited {
                    "bili_rate_limited"
                } else {
                    "bili_verification_required"
                };
                let mut result = Self::new(code, message, rate_limited);
                result.retry_at = restriction.retry_at;
                result.http_status = restriction.http_status;
                result.upstream_code = restriction.upstream_code;
                result.stage = Some(restriction.stage().as_str());
                result
            }
            ProviderError::Api { code: 62002, .. } => {
                Self::new("source_expired", "B 站视频已失效", false)
            }
            ProviderError::Api { code: -101, .. } | ProviderError::NotAuthenticated => {
                Self::new("bili_auth_required", "请先登录 B 站账号", false)
            }
            ProviderError::WriteUnconfirmed => Self::new("bili_write_unconfirmed", message, false),
            ProviderError::AccountChanged => Self::new("account_changed", message, false),
            ProviderError::Network(error) => Self::new(
                "provider_error",
                format!("网络请求失败: {}", error.without_url()),
                true,
            ),
            error => Self::provider(error),
        }
    }

    pub fn audio_source(error: crate::infrastructure::providers::bilibili::ProviderError) -> Self {
        Self::bilibili(error)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message, false)
    }

    pub fn database(error: impl std::fmt::Display) -> Self {
        Self::new("database_error", error.to_string(), true)
    }

    pub fn recommendation_unavailable() -> Self {
        Self::new(
            "recommendation_unavailable",
            "推荐数据库不可用，请重启应用后重试",
            true,
        )
    }

    pub fn recommendation_not_found() -> Self {
        Self::new("recommendation_not_found", "推荐源或歌曲不存在", false)
    }

    pub fn recommendation_source_changed() -> Self {
        Self::new(
            "recommendation_source_changed",
            "推荐源已变更，请重试",
            false,
        )
    }

    pub fn recommendation_refresh_busy() -> Self {
        Self::new("recommendation_refresh_busy", "推荐正在刷新，请稍候", true)
    }

    pub fn netease_unavailable() -> Self {
        Self::new(
            "netease_unavailable",
            "网易云客户端初始化失败，请重启应用后重试",
            true,
        )
    }

    pub fn netease_login_in_progress() -> Self {
        Self::new(
            "netease_login_in_progress",
            "网易云登录窗口已经打开，请先完成或取消当前登录",
            false,
        )
    }

    pub fn netease_login_cancelled() -> Self {
        Self::new("netease_login_cancelled", "已取消网易云登录", false)
    }

    pub fn netease_login_timeout() -> Self {
        Self::new(
            "netease_login_timeout",
            "网易云登录等待超时，请重新打开登录窗口",
            true,
        )
    }

    pub fn netease_login_window(error: impl std::fmt::Display) -> Self {
        Self::new(
            "netease_login_window_error",
            format!("无法打开网易云登录窗口: {error}"),
            true,
        )
    }

    pub fn netease(error: crate::infrastructure::providers::netease::NeteaseError) -> Self {
        use crate::infrastructure::providers::netease::NeteaseError;
        match error {
            NeteaseError::Network(error) => Self::new(
                "provider_error",
                format!("网易云连接失败: {}", error.without_url()),
                true,
            ),
            NeteaseError::Unavailable => Self::new(
                "netease_unavailable",
                "网易云服务暂时不可用，请稍后重试",
                true,
            ),
            NeteaseError::QrUnknown => Self::new(
                "netease_login_attempt_unknown",
                "网易云登录状态已失效，请重新生成二维码",
                false,
            ),
            NeteaseError::AuthRequired => Self::new(
                "netease_auth_required",
                "网易云登录已失效，请重新登录",
                false,
            ),
            NeteaseError::RateLimited { retry_at } => {
                let mut result = Self::new(
                    "netease_rate_limited",
                    "网易云请求过于频繁，请稍后重试",
                    true,
                );
                result.retry_at = retry_at;
                result
            }
            NeteaseError::RiskBlocked => Self::new(
                "netease_risk_blocked",
                "网易云触发了风控验证，请稍后再试",
                false,
            ),
            NeteaseError::VerificationRequired => Self::new(
                "netease_verification_required",
                "网易云要求安全验证，请稍后重试或改用网页登录",
                false,
            ),
            NeteaseError::Protocol => Self::new(
                "netease_protocol_error",
                "网易云返回了无法识别的数据，请稍后重试",
                false,
            ),
            NeteaseError::AccountMismatch => Self::new(
                "netease_account_mismatch",
                "网易云账号信息不完整，请重新登录",
                false,
            ),
        }
    }

    pub fn recommendation(
        error: crate::infrastructure::recommendation_store::RecommendationStoreError,
    ) -> Self {
        use crate::infrastructure::recommendation_store::RecommendationStoreError;
        match error {
            RecommendationStoreError::Database(error) => {
                Self::new("database_error", error.to_string(), true)
            }
            RecommendationStoreError::Busy => Self::new("database_error", "推荐数据库正忙", true),
            RecommendationStoreError::NotFound => Self::recommendation_not_found(),
            RecommendationStoreError::DuplicateSource => {
                Self::new("netease_source_exists", "该网易云账号已经添加", false)
            }
            RecommendationStoreError::SourceChanged => Self::recommendation_source_changed(),
            RecommendationStoreError::BindingStale => Self::new(
                "recommendation_binding_stale",
                "推荐匹配已变更，请重试",
                false,
            ),
            RecommendationStoreError::ManualBindingProtected => Self::new(
                "recommendation_binding_conflict",
                "自动匹配不会覆盖手动选择",
                false,
            ),
            RecommendationStoreError::InvalidState => {
                Self::new("invalid_input", "推荐状态无效", false)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::providers::bilibili::ProviderError;

    #[test]
    fn a_confirmed_unavailable_video_is_distinct_from_an_ambiguous_lookup_failure() {
        let api = |code| ProviderError::Api {
            code,
            message: String::new(),
        };
        assert_eq!(
            CommandError::audio_source(api(62002)).code,
            "source_expired"
        );
        for code in [-404, -412, 6002105] {
            assert_eq!(CommandError::audio_source(api(code)).code, "provider_error");
        }
    }

    #[test]
    fn a_netease_safety_gate_is_terminal_for_the_client() {
        use crate::infrastructure::providers::netease::NeteaseError;
        // The QR dialog stops polling when the rejection carries
        // retryable=false, so this contract is part of the fix, not cosmetics.
        let gate = CommandError::netease(NeteaseError::VerificationRequired);
        assert_eq!(gate.code, "netease_verification_required");
        assert!(!gate.retryable);
        assert!(gate.message.contains("安全验证"));
        assert!(CommandError::netease(NeteaseError::Unavailable).retryable);
    }

    #[test]
    fn web_login_lifecycle_errors_have_stable_codes_and_retry_policy() {
        let cancelled = CommandError::netease_login_cancelled();
        assert_eq!(cancelled.code, "netease_login_cancelled");
        assert!(!cancelled.retryable);
        let busy = CommandError::netease_login_in_progress();
        assert_eq!(busy.code, "netease_login_in_progress");
        assert!(!busy.retryable);
        let timeout = CommandError::netease_login_timeout();
        assert_eq!(timeout.code, "netease_login_timeout");
        assert!(timeout.retryable);
    }
}
