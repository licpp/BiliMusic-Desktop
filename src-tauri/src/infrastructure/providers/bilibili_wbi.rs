use super::*;
use serde_json::Value;

// WBI hashes the sorted RFC 3986 query.
pub(super) fn signed_query(
    mut fields: std::collections::BTreeMap<&str, String>,
    timestamp: u64,
    salt: &str,
) -> String {
    fn encode(value: &str) -> String {
        let mut result = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                result.push(byte as char);
            } else {
                result.push_str(&format!("%{byte:02X}"));
            }
        }
        result
    }
    fields.insert("wts", timestamp.to_string());
    let query = fields
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let hash = format!("{:x}", md5::compute(format!("{query}{salt}")));
    format!("{query}&w_rid={hash}")
}

impl BilibiliProvider {
    pub(super) async fn wbi_salt(&self, require_login: bool) -> Result<String, ProviderError> {
        let nav = self
            .read_json(
                self.api_url("/x/web-interface/nav"),
                requests::Stage::Search,
                RequestPriority::Foreground,
                Some(Url::parse(WEB_ORIGIN).unwrap()),
                |lease, status, headers, envelope| {
                    let code = envelope["code"]
                        .as_i64()
                        .ok_or(ProviderError::UnexpectedResponse)?;
                    let data = &envelope["data"];
                    // The ordinary visitor response contains signing metadata even when not logged in.
                    let code = if !require_login && code == -101 && data["wbi_img"].is_object() {
                        0
                    } else {
                        code
                    };
                    inspect_code(
                        lease,
                        status,
                        headers,
                        code,
                        Some(data),
                        envelope["message"].as_str().unwrap_or_default().into(),
                    )?;
                    Ok(data.clone())
                },
            )
            .await?;
        if require_login && nav["isLogin"].as_bool() != Some(true) {
            return Err(ProviderError::NotAuthenticated);
        }
        let keys = ["img_url", "sub_url"]
            .map(|k| {
                nav["wbi_img"][k]
                    .as_str()
                    .unwrap_or("")
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .split('.')
                    .next()
                    .unwrap_or("")
                    .to_owned()
            })
            .join("");
        const MIX: [usize; 64] = [
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42,
            19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60,
            51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
        ];
        if keys.len() != 64 || !keys.is_ascii() {
            return Err(ProviderError::Api {
                code: -1,
                message: "无法获取 B 站请求签名，请重试".into(),
            });
        }
        let salt: String = MIX
            .iter()
            .take(32)
            .map(|i| keys.as_bytes()[*i] as char)
            .collect();
        Ok(salt)
    }
}
