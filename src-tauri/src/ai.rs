use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::database::MediaType;
use crate::settings::AppSettings;
use crate::tmdb::ScrapeCandidate;

const AI_TIMEOUT_SECONDS: u64 = 30;
const OVERVIEW_LIMIT: usize = 800;
const PLATFORM_LIMIT: usize = 60;

const SYSTEM_PROMPT: &str = "你是影视、动漫元数据助手。根据用户给出的作品名称与类型，返回真实存在的元数据。\
只输出一个 JSON 对象，不要输出 Markdown 代码块或解释文字。字段如下：\
title（中文标题，字符串）、originalTitle（原名，字符串或 null）、year（首播或出版年份，整数或 null）、\
rating（0 到 10 的评分，数字或 null）、overview（不超过 150 字的中文简介，字符串或 null）、\
platform（主要播出或阅读平台，字符串或 null）、posterUrl（公开可访问的 http/https 封面图片地址，字符串或 null）。\
不确定的字段一律填 null，禁止编造不存在的信息。";

/// 调用 OpenAI 兼容的 Chat Completions 接口，返回 AI 推断出的候选元数据。
pub async fn complete(
    settings: &AppSettings,
    query: &str,
    media_type: Option<MediaType>,
) -> Result<Option<ScrapeCandidate>, String> {
    let base_url = settings.ai_base_url.trim();
    let model = settings.ai_model.trim();
    if base_url.is_empty() || model.is_empty() {
        return Ok(None);
    }

    let body = serde_json::json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            {
                "role": "user",
                "content": format!(
                    "作品名称：{query}\n类型：{}\n请只返回 JSON。",
                    media_label(media_type)
                )
            }
        ]
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(AI_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("无法初始化 AI 请求：{error}"))?;
    let mut request = client
        .post(chat_completions_url(base_url))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    let api_key = settings.ai_api_key.trim();
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(describe_http_status(status));
    }
    let text = response
        .text()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let payload: ChatResponse =
        serde_json::from_str(&text).map_err(|error| format!("解析 AI 返回内容失败：{error}"))?;
    let content = payload
        .choices
        .into_iter()
        .find_map(|choice| choice.message.and_then(|message| message.content))
        .ok_or_else(|| "AI 未返回可用内容".to_owned())?;

    map_ai_content(&content, media_type)
}

/// 用最小的请求验证接口地址、API Key 与模型是否可用。
pub async fn test_connection(settings: &AppSettings) -> Result<String, String> {
    let base_url = settings.ai_base_url.trim();
    let model = settings.ai_model.trim();
    if base_url.is_empty() {
        return Err("请填写 AI 接口地址".to_owned());
    }
    if model.is_empty() {
        return Err("请填写 AI 模型名称".to_owned());
    }

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }]
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(AI_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("无法初始化 AI 请求：{error}"))?;
    let mut request = client
        .post(chat_completions_url(base_url))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    let api_key = settings.ai_api_key.trim();
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(describe_http_status(status));
    }

    Ok(format!("连接成功，模型 {model} 可用。"))
}

fn chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_owned()
    } else {
        format!("{base}/chat/completions")
    }
}

fn media_label(media_type: Option<MediaType>) -> &'static str {
    match media_type {
        Some(MediaType::Drama) => "剧集",
        Some(MediaType::Anime) => "番剧",
        Some(MediaType::Variety) => "综艺",
        Some(MediaType::Movie) => "电影",
        Some(MediaType::ShortDrama) => "短剧",
        None => "影视作品",
    }
}

fn candidate_kind(media_type: Option<MediaType>) -> &'static str {
    match media_type {
        Some(MediaType::Movie) => "movie",
        Some(MediaType::Anime) => "anime",
        _ => "tv",
    }
}

#[derive(Debug, Default, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatChoice {
    #[serde(default)]
    message: Option<ChatMessage>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiPayload {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    original_title: Option<String>,
    #[serde(default)]
    year: Option<Value>,
    #[serde(default)]
    rating: Option<Value>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    poster_url: Option<String>,
}

fn map_ai_content(
    content: &str,
    media_type: Option<MediaType>,
) -> Result<Option<ScrapeCandidate>, String> {
    let json =
        extract_json_object(content).ok_or_else(|| "AI 返回内容中缺少 JSON 对象".to_owned())?;
    let payload: AiPayload =
        serde_json::from_str(json).map_err(|error| format!("解析 AI 返回内容失败：{error}"))?;

    let Some(title) = non_empty(payload.title) else {
        return Ok(None);
    };
    let year = coerce_year(payload.year);
    let candidate = ScrapeCandidate {
        source_id: stable_id(&format!("{title}|{}", year.unwrap_or_default())),
        title,
        original_title: non_empty(payload.original_title),
        year,
        poster_url: http_url(payload.poster_url),
        rating: coerce_rating(payload.rating),
        overview: truncate(non_empty(payload.overview), OVERVIEW_LIMIT),
        kind: candidate_kind(media_type).to_owned(),
        source: Some("AI".to_owned()),
        total_episodes: None,
        platform: truncate(non_empty(payload.platform), PLATFORM_LIMIT),
    };
    Ok(Some(candidate))
}

fn extract_json_object(content: &str) -> Option<&str> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    (end > start).then(|| &content[start..=end])
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn http_url(value: Option<String>) -> Option<String> {
    let text = non_empty(value)?;
    let lower = text.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")).then_some(text)
}

fn coerce_year(value: Option<Value>) -> Option<u32> {
    let year = match value? {
        Value::Number(number) => number.as_i64()?,
        Value::String(text) => text.trim().get(0..4)?.parse::<i64>().ok()?,
        _ => return None,
    };
    (1000..=2100).contains(&year).then_some(year as u32)
}

fn coerce_rating(value: Option<Value>) -> Option<f64> {
    let rating = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (0.0..=10.0)
        .contains(&rating)
        .then(|| (rating * 10.0).round() / 10.0)
}

fn truncate(value: Option<String>, limit: usize) -> Option<String> {
    let text = value?;
    if text.chars().count() <= limit {
        return Some(text);
    }
    let mut shortened = text.chars().take(limit).collect::<String>();
    shortened.push('…');
    Some(shortened)
}

fn stable_id(text: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn describe_request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("AI 请求超时（{AI_TIMEOUT_SECONDS} 秒），请稍后重试。");
    }
    if error.is_connect() {
        return "无法连接 AI 接口，请检查地址与网络后重试。".to_owned();
    }
    format!("请求 AI 失败：{error}")
}

fn describe_http_status(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => format!("AI 接口拒绝访问（HTTP {status}），请检查 API Key。"),
        404 => format!("AI 接口不存在（HTTP {status}），请检查接口地址与模型名称。"),
        429 => format!("AI 接口请求过于频繁（HTTP {status}），请稍后再试。"),
        _ => format!("AI 请求失败（HTTP {status}），请稍后重试。"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_endpoint_accepts_base_or_full_path() {
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://example.com/v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn maps_json_wrapped_in_code_fences() {
        let content = "```json\n{\"title\":\"葬送的芙莉莲\",\"originalTitle\":\"Sousou no Frieren\",\"year\":2023,\"rating\":\"9.1\",\"overview\":\"勇者一行击败魔王后的故事。\",\"platform\":\"哔哩哔哩\",\"posterUrl\":\"https://lain.bgm.tv/pic/cover/l/frieren.jpg\"}\n```";

        let candidate = map_ai_content(content, Some(MediaType::Anime))
            .unwrap()
            .unwrap();

        assert_eq!(candidate.title, "葬送的芙莉莲");
        assert_eq!(
            candidate.original_title.as_deref(),
            Some("Sousou no Frieren")
        );
        assert_eq!(candidate.year, Some(2023));
        assert_eq!(candidate.rating, Some(9.1));
        assert_eq!(candidate.platform.as_deref(), Some("哔哩哔哩"));
        assert_eq!(
            candidate.poster_url.as_deref(),
            Some("https://lain.bgm.tv/pic/cover/l/frieren.jpg")
        );
        assert_eq!(candidate.source.as_deref(), Some("AI"));
        assert_eq!(candidate.kind, "anime");
    }

    #[test]
    fn rejects_missing_title_and_invalid_values() {
        assert!(map_ai_content("{\"title\":\"  \"}", None)
            .unwrap()
            .is_none());

        let candidate = map_ai_content(
            "{\"title\":\"某剧\",\"year\":\"3000\",\"rating\":42,\"posterUrl\":\"ftp://x/a.jpg\"}",
            Some(MediaType::Drama),
        )
        .unwrap()
        .unwrap();
        assert_eq!(candidate.year, None);
        assert_eq!(candidate.rating, None);
        assert_eq!(candidate.poster_url, None);
        assert_eq!(candidate.kind, "tv");
    }

    #[test]
    fn content_without_json_is_an_error() {
        let error = map_ai_content("抱歉，我不知道。", None).unwrap_err();
        assert_eq!(error, "AI 返回内容中缺少 JSON 对象");
    }
}
