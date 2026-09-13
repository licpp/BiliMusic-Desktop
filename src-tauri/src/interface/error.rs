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

    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input",
            message: message.into(),
            retryable: false,
        }
    }
}
