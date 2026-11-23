use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl CommandError {
    pub fn provider(error: impl std::fmt::Display) -> Self {
        Self {
            code: "provider_error",
            message: error.to_string(),
            retryable: true,
        }
    }

    pub fn audio_source(error: crate::infrastructure::providers::bilibili::ProviderError) -> Self {
        use crate::infrastructure::providers::bilibili::ProviderError;
        if matches!(&error, ProviderError::Api { code: 62002, .. }) {
            return Self {
                code: "source_expired",
                message: "B 站视频已失效".into(),
                retryable: false,
            };
        }
        Self::provider(error)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input",
            message: message.into(),
            retryable: false,
        }
    }

    pub fn database(error: impl std::fmt::Display) -> Self {
        Self {
            code: "database_error",
            message: error.to_string(),
            retryable: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::providers::bilibili::ProviderError;

    #[test]
    fn a_confirmed_unavailable_video_is_distinct_from_an_ambiguous_lookup_failure() {
        let api = |code| ProviderError::Api { code, message: String::new() };
        assert_eq!(CommandError::audio_source(api(62002)).code, "source_expired");
        for code in [-404, -412, 6002105] {
            assert_eq!(CommandError::audio_source(api(code)).code, "provider_error");
        }
    }
}
