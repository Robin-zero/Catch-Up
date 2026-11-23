use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// 单张封面允许的最大体积（10MB），避免误传超大图片撑爆数据目录。
const MAX_COVER_BYTES: usize = 10 * 1024 * 1024;

fn covers_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("covers");
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建封面目录：{error}"))?;
    Ok(directory)
}

fn normalize_extension(extension: Option<String>) -> String {
    match extension
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
    {
        Some(value) if matches!(value.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") => {
            value
        }
        _ => "jpg".to_owned(),
    }
}

fn write_cover(app: &AppHandle, bytes: &[u8], extension: &str) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("封面图片内容为空".to_owned());
    }
    if bytes.len() > MAX_COVER_BYTES {
        return Err("封面图片不能超过 10MB".to_owned());
    }
    let directory = covers_directory(app)?;
    let path = directory.join(format!("cover-{}.{}", Uuid::new_v4(), extension));
    std::fs::write(&path, bytes).map_err(|error| format!("无法保存封面图片：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 把前端选中的本地图片（base64）保存到应用数据目录，返回本地绝对路径。
#[tauri::command]
pub fn save_cover_image(
    app: AppHandle,
    data: String,
    extension: Option<String>,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "封面图片数据无效".to_owned())?;
    write_cover(&app, &bytes, &normalize_extension(extension))
}

/// 下载刮削得到的封面并缓存到本地，返回本地绝对路径。
#[tauri::command]
pub async fn cache_cover_from_url(app: AppHandle, url: String) -> Result<String, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("封面链接必须以 http:// 或 https:// 开头".to_owned());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("无法初始化下载客户端：{error}"))?;
    let response = client
        .get(trimmed)
        .send()
        .await
        .map_err(|error| format!("下载封面失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载封面失败：HTTP {}", response.status()));
    }

    let extension = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split('/').nth(1))
        .and_then(|value| value.split(';').next())
        .map(str::to_owned);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取封面内容失败：{error}"))?;

    write_cover(&app, &bytes, &normalize_extension(extension))
}
