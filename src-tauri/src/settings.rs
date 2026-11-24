use serde::{Deserialize, Serialize};

const MAX_TMDB_API_KEY_CHARS: usize = 200;
const MAX_WEBDAV_URL_CHARS: usize = 500;
const MAX_WEBDAV_USERNAME_CHARS: usize = 200;
const MAX_WEBDAV_PASSWORD_CHARS: usize = 500;
const MAX_AI_BASE_URL_CHARS: usize = 500;
const MAX_AI_API_KEY_CHARS: usize = 500;
const MAX_AI_MODEL_CHARS: usize = 200;

/// 默认使用 DeepSeek 的 OpenAI 兼容接口。
pub(crate) const DEFAULT_AI_BASE_URL: &str = "https://api.deepseek.com";
pub(crate) const DEFAULT_AI_MODEL: &str = "deepseek-flash";

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
    /// 主题模式：system / light / dark。
    pub theme: String,
    /// 内容库布局：list / grid。
    pub library_view: String,
    /// 是否启用 AI 补全（作为智能补全的兜底数据源）。
    pub ai_enabled: bool,
    /// OpenAI 兼容接口地址，如 https://api.openai.com/v1。
    pub ai_base_url: String,
    pub ai_api_key: String,
    pub ai_model: String,
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

        let theme = normalize_theme(&self.theme);
        let library_view = normalize_library_view(&self.library_view);

        let ai_base_url = self.ai_base_url.trim().to_owned();
        if ai_base_url.chars().count() > MAX_AI_BASE_URL_CHARS {
            return Err(format!(
                "AI 接口地址不能超过 {MAX_AI_BASE_URL_CHARS} 个字符"
            ));
        }
        if !ai_base_url.is_empty() {
            let lower = ai_base_url.to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                return Err("AI 接口地址仅支持 http 或 https 链接".to_owned());
            }
        }

        let ai_api_key = self.ai_api_key.trim().to_owned();
        if ai_api_key.chars().count() > MAX_AI_API_KEY_CHARS {
            return Err(format!("AI API Key 不能超过 {MAX_AI_API_KEY_CHARS} 个字符"));
        }

        let ai_model = self.ai_model.trim().to_owned();
        if ai_model.chars().count() > MAX_AI_MODEL_CHARS {
            return Err(format!("AI 模型名称不能超过 {MAX_AI_MODEL_CHARS} 个字符"));
        }
        if self.ai_enabled {
            if ai_base_url.is_empty() {
                return Err("启用 AI 补全时，请填写接口地址".to_owned());
            }
            if ai_model.is_empty() {
                return Err("启用 AI 补全时，请填写模型名称".to_owned());
            }
        }

        Ok(Self {
            tmdb_api_key,
            webdav_url,
            webdav_username,
            webdav_password: self.webdav_password,
            webdav_enabled: self.webdav_enabled,
            last_synced_at,
            theme,
            library_view,
            ai_enabled: self.ai_enabled,
            ai_base_url,
            ai_api_key,
            ai_model,
        })
    }
}

pub(crate) fn normalize_theme(raw: &str) -> String {
    match raw.trim() {
        "light" => "light".to_owned(),
        "dark" => "dark".to_owned(),
        _ => "system".to_owned(),
    }
}

pub(crate) fn normalize_library_view(raw: &str) -> String {
    match raw.trim() {
        "grid" => "grid".to_owned(),
        _ => "list".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_settings_are_trimmed_and_optional_when_disabled() {
        let settings = AppSettings {
            ai_base_url: " https://api.deepseek.com/v1 ".to_owned(),
            ai_api_key: " key ".to_owned(),
            ai_model: " deepseek-chat ".to_owned(),
            ..AppSettings::default()
        }
        .validate()
        .unwrap();

        assert_eq!(settings.ai_base_url, "https://api.deepseek.com/v1");
        assert_eq!(settings.ai_api_key, "key");
        assert_eq!(settings.ai_model, "deepseek-chat");
        assert!(!settings.ai_enabled);
    }

    #[test]
    fn enabled_ai_requires_base_url_and_model() {
        assert_eq!(
            AppSettings {
                ai_enabled: true,
                ..AppSettings::default()
            }
            .validate()
            .unwrap_err(),
            "启用 AI 补全时，请填写接口地址"
        );
        assert_eq!(
            AppSettings {
                ai_enabled: true,
                ai_base_url: "https://api.openai.com/v1".to_owned(),
                ..AppSettings::default()
            }
            .validate()
            .unwrap_err(),
            "启用 AI 补全时，请填写模型名称"
        );
        assert_eq!(
            AppSettings {
                ai_base_url: "ftp://example.com".to_owned(),
                ..AppSettings::default()
            }
            .validate()
            .unwrap_err(),
            "AI 接口地址仅支持 http 或 https 链接"
        );
    }
}
