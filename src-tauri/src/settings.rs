use serde::{Deserialize, Serialize};

const MAX_TMDB_API_KEY_CHARS: usize = 200;
const MAX_WEBDAV_URL_CHARS: usize = 500;
const MAX_WEBDAV_USERNAME_CHARS: usize = 200;
const MAX_WEBDAV_PASSWORD_CHARS: usize = 500;

/// 应用设置。字段保持扁平，底层按 key 存储，便于后续新增设置项。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub tmdb_api_key: String,
    pub webdav_url: String,
    pub webdav_username: String,
    pub webdav_password: String,
    pub webdav_enabled: bool,
    pub last_synced_at: Option<String>,
}

impl AppSettings {
    pub fn validate(self) -> Result<Self, String> {
        let tmdb_api_key = self.tmdb_api_key.trim().to_owned();
        if tmdb_api_key.chars().count() > MAX_TMDB_API_KEY_CHARS {
            return Err(format!(
                "TMDB API Key 不能超过 {MAX_TMDB_API_KEY_CHARS} 个字符"
            ));
        }

        let webdav_url = self.webdav_url.trim().to_owned();
        if webdav_url.chars().count() > MAX_WEBDAV_URL_CHARS {
            return Err(format!(
                "WebDAV 服务器地址不能超过 {MAX_WEBDAV_URL_CHARS} 个字符"
            ));
        }
        if !webdav_url.is_empty() {
            let lower = webdav_url.to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                return Err("WebDAV 服务器地址仅支持 http 或 https 链接".to_owned());
            }
        }

        let webdav_username = self.webdav_username.trim().to_owned();
        if webdav_username.chars().count() > MAX_WEBDAV_USERNAME_CHARS {
            return Err(format!(
                "WebDAV 用户名不能超过 {MAX_WEBDAV_USERNAME_CHARS} 个字符"
            ));
        }

        if self.webdav_password.chars().count() > MAX_WEBDAV_PASSWORD_CHARS {
            return Err(format!(
                "WebDAV 密码不能超过 {MAX_WEBDAV_PASSWORD_CHARS} 个字符"
            ));
        }

        if self.webdav_enabled {
            if webdav_url.is_empty() {
                return Err("启用 WebDAV 自动同步时，请填写服务器地址".to_owned());
            }
            if webdav_username.is_empty() {
                return Err("启用 WebDAV 自动同步时，请填写用户名".to_owned());
            }
        }

        let last_synced_at = self
            .last_synced_at
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());

        Ok(Self {
            tmdb_api_key,
            webdav_url,
            webdav_username,
            webdav_password: self.webdav_password,
            webdav_enabled: self.webdav_enabled,
            last_synced_at,
        })
    }
}
