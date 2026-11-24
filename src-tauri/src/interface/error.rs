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
}
