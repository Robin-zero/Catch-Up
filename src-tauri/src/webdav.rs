use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use futures::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

use crate::{
    database::{Database, PurgedEntry, SyncEntry},
    settings::AppSettings,
};

const SYNC_FILE_NAME: &str = "catchup-sync.json";
const FALLBACK_DIRECTORY_NAME: &str = "CatchUp";
const SNAPSHOT_VERSION: u32 = 1;
const SYNC_TIMEOUT_SECONDS: u64 = 20;
const COVER_DIRECTORY_NAME: &str = "covers";
const COVER_REMOTE_DIRECTORY: &str = "catchup-covers";
const COVER_MARKER_PREFIX: &str = "catchup-cover:";
const COVER_MANIFEST_FILE: &str = "webdav-covers.json";
const MAX_COVER_BYTES: usize = 10 * 1024 * 1024;
/// 封面并发上传数量：太高容易被网盘限流，太低又拖慢首次同步。
const COVER_UPLOAD_CONCURRENCY: usize = 4;
/// 429/5xx/网络错误的最大重试次数（不含首次请求）。
const RETRY_LIMIT: u32 = 2;
const RETRY_BASE_DELAY_MS: u64 = 300;

/// 同步进度：`phase` 为 prepare / covers / snapshot。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: &'static str,
    pub current: u32,
    pub total: u32,
}

pub type ProgressFn<'a> = &'a (dyn Fn(SyncProgress) + Send + Sync);

fn report_progress(
    progress: Option<ProgressFn<'_>>,
    phase: &'static str,
    current: u32,
    total: u32,
) {
    if let Some(progress) = progress {
        progress(SyncProgress {
            phase,
            current,
            total,
        });
    }
}

/// 可重试错误：把「临时失败」与「配置/权限问题」区分开，避免无意义的重试。
struct RetryableError {
    message: String,
    retryable: bool,
}

impl RetryableError {
    fn new(message: String, retryable: bool) -> Self {
        Self { message, retryable }
    }
}

/// 429 与 5xx 通常是临时限流或服务端抖动，值得退避重试。
fn is_retryable_status(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

async fn with_retry<T, F, Fut>(mut operation: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, RetryableError>>,
{
    let mut delay = Duration::from_millis(RETRY_BASE_DELAY_MS);
    let mut attempt = 0u32;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !error.retryable || attempt >= RETRY_LIMIT {
                    return Err(error.message);
                }
                attempt += 1;
                tokio::time::sleep(delay).await;
                delay = delay.saturating_mul(3);
            }
        }
    }
}


#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// 合并后条目总数（包含回收站中的条目）。
    pub merged: u32,
    /// 本地变更上传条数。
    pub uploaded: u32,
    /// 远端较新采用条数。
    pub downloaded: u32,
    pub last_synced_at: String,
    /// 不影响整体同步、但需要提示用户的问题（例如个别封面没有上传成功）。
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub version: u32,
    pub exported_at: String,
    #[serde(default)]
    pub entries: Vec<SyncEntry>,
    #[serde(default)]
    pub purged: Vec<PurgedEntry>,
}

#[derive(Debug, Clone, PartialEq)]
struct MergeResult {
    entries: Vec<SyncEntry>,
    purged: Vec<PurgedEntry>,
    downloaded: u32,
    uploaded: u32,
}

fn compare_timestamps(left: &str, right: &str) -> Ordering {
    match (
        DateTime::parse_from_rfc3339(left),
        DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

fn merge_libraries(
    local_entries: &[SyncEntry],
    local_purged: &[PurgedEntry],
    remote_entries: &[SyncEntry],
    remote_purged: &[PurgedEntry],
) -> MergeResult {
    let mut local_map: HashMap<&str, &SyncEntry> = HashMap::new();
    for entry in local_entries {
        local_map.insert(entry.id.as_str(), entry);
    }

    let mut remote_map: HashMap<&str, &SyncEntry> = HashMap::new();
    for entry in remote_entries {
        remote_map
            .entry(entry.id.as_str())
            .and_modify(|existing| {
                if compare_timestamps(&entry.updated_at, &existing.updated_at).is_gt() {
                    *existing = entry;
                }
            })
            .or_insert(entry);
    }

    let mut purged_map: HashMap<String, PurgedEntry> = HashMap::new();
    for record in local_purged.iter().chain(remote_purged.iter()) {
        purged_map
            .entry(record.id.clone())
            .and_modify(|existing| {
                if compare_timestamps(&record.purged_at, &existing.purged_at).is_gt() {
                    *existing = record.clone();
                }
            })
            .or_insert_with(|| record.clone());
    }

    let mut entries = Vec::new();
    let mut downloaded = 0u32;
    let mut uploaded = 0u32;

    for (id, local) in &local_map {
        match remote_map.get(id) {
            Some(remote) => {
                if compare_timestamps(&local.updated_at, &remote.updated_at).is_ge() {
                    entries.push((*local).clone());
                } else {
                    downloaded += 1;
                    uploaded += 1;
                    entries.push((*remote).clone());
                }
            }
            None => {
                uploaded += 1;
                entries.push((*local).clone());
            }
        }
    }

    for (id, remote) in &remote_map {
        if !local_map.contains_key(id) {
            downloaded += 1;
            entries.push((*remote).clone());
        }
    }

    // 墓碑时间不早于条目更新时间时，条目在两侧都应被删除且不再复活。
    entries.retain(|entry| match purged_map.get(&entry.id) {
        Some(record) => compare_timestamps(&record.purged_at, &entry.updated_at).is_lt(),
        None => true,
    });
    entries.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut purged = purged_map.into_values().collect::<Vec<_>>();
    purged.sort_by(|left, right| left.id.cmp(&right.id));

    MergeResult {
        entries,
        purged,
        downloaded,
        uploaded,
    }
}

/// 用于判断远端快照是否真的发生变化：忽略导出时间与条目顺序。
fn snapshot_content_key(entries: &[SyncEntry], purged: &[PurgedEntry]) -> String {
    let mut entries = entries.to_vec();
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    let mut purged = purged.to_vec();
    purged.sort_by(|left, right| left.id.cmp(&right.id));
    serde_json::to_string(&(entries, purged)).unwrap_or_default()
}

fn normalize_sync_url(raw_url: &str) -> Result<String, String> {
    let url = raw_url.trim();
    if url.is_empty() {
        return Err("请填写 WebDAV 服务器地址".to_owned());
    }

    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("WebDAV 服务器地址仅支持 http 或 https 链接".to_owned());
    }

    let normalized = url.trim_end_matches('/');
    if normalized.to_ascii_lowercase().ends_with(".json") {
        return Ok(normalized.to_owned());
    }
    Ok(format!("{normalized}/{SYNC_FILE_NAME}"))
}

fn prepare_sync_url(settings: &AppSettings) -> Result<String, String> {
    if !settings.webdav_enabled || settings.webdav_url.trim().is_empty() {
        return Err("请先在设置中启用并填写 WebDAV 地址".to_owned());
    }
    normalize_sync_url(&settings.webdav_url)
}

/// 用户直接把地址填成了具体的 .json 文件，此时完全按用户给的路径写入。
fn is_explicit_sync_file(raw_url: &str) -> bool {
    raw_url
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .ends_with(".json")
}

/// 部分服务端（例如坚果云根目录）不允许直接在配置目录创建文件，
/// 此时把快照放进由程序拼接的子目录，用户不需要在地址里额外加一层。
fn fallback_snapshot_url(url: &str) -> Option<String> {
    let directory = parent_collection_url(url)?;
    let last = directory.rsplit('/').next().unwrap_or_default();
    if last.eq_ignore_ascii_case(FALLBACK_DIRECTORY_NAME) {
        return None;
    }
    Some(format!(
        "{directory}/{FALLBACK_DIRECTORY_NAME}/{SYNC_FILE_NAME}"
    ))
}

async fn get_status(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
) -> Result<u16, String> {
    let mut request = client.get(url);
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    Ok(response.status().as_u16())
}

fn authorization_header(settings: &AppSettings) -> Option<String> {
    let username = settings.webdav_username.trim();
    if username.is_empty() {
        return None;
    }
    let credentials = format!("{username}:{}", settings.webdav_password);
    Some(format!(
        "Basic {}",
        BASE64_STANDARD.encode(credentials.as_bytes())
    ))
}

fn describe_request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("连接 WebDAV 超时（{SYNC_TIMEOUT_SECONDS} 秒），请检查网络后重试。");
    }
    if error.is_connect() {
        return "无法连接 WebDAV，请检查服务器地址与网络后重试。".to_owned();
    }
    format!("请求 WebDAV 失败：{error}")
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(SYNC_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("无法初始化 WebDAV 网络请求：{error}"))
}

/// 用一次只读请求验证地址、账号与访问权限；不要求已启用自动同步。
pub async fn test_connection(settings: &AppSettings) -> Result<String, String> {
    let url = normalize_sync_url(&settings.webdav_url)?;
    let client = build_client()?;
    let mut status = get_status(&client, &url, settings).await?;
    if status == 404 && !is_explicit_sync_file(&settings.webdav_url) {
        if let Some(fallback_url) = fallback_snapshot_url(&url) {
            status = get_status(&client, &fallback_url, settings).await?;
        }
    }
    match status {
        200..=299 => Ok("连接成功，已找到同步数据。".to_owned()),
        404 => Ok("连接成功，远端暂无同步数据。".to_owned()),
        401 | 403 => Err(format!(
            "WebDAV 认证失败（HTTP {status}），请检查用户名与密码。"
        )),
        _ => Err(format!(
            "连接 WebDAV 失败（HTTP {status}），请检查地址与访问权限。"
        )),
    }
}

async fn fetch_snapshot(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
) -> Result<(SyncSnapshot, bool), String> {
    let mut request = client.get(url);
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Ok((
            SyncSnapshot {
                version: SNAPSHOT_VERSION,
                ..SyncSnapshot::default()
            },
            false,
        ));
    }
    if !status.is_success() {
        return Err(format!(
            "读取 WebDAV 同步数据失败（HTTP {}），请检查地址与访问权限。",
            status.as_u16()
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 WebDAV 返回内容失败：{error}"))?;
    if body.trim().is_empty() {
        return Ok((
            SyncSnapshot {
                version: SNAPSHOT_VERSION,
                ..SyncSnapshot::default()
            },
            true,
        ));
    }
    let snapshot = serde_json::from_str(&body)
        .map_err(|error| format!("解析 WebDAV 同步数据失败：{error}"))?;
    Ok((snapshot, true))
}

/// 同步数据所在目录（去掉文件名后的地址）。
fn parent_collection_url(url: &str) -> Option<String> {
    let (base, _) = url.rsplit_once('/')?;
    (!base.is_empty()).then(|| base.to_owned())
}

fn snapshot_write_error(status: u16, directory: &str) -> String {
    match status {
        401 | 403 => format!(
            "写入 WebDAV 同步数据失败（HTTP {status}），请检查用户名、密码与目录权限。"
        ),
        404 | 409 => format!(
            "写入 WebDAV 同步数据失败（HTTP {status}）：目标目录不存在或不允许直接写入（{directory}）。请在 WebDAV 中创建该目录，或把地址改成一个可写的子目录后重试。"
        ),
        _ => format!("写入 WebDAV 同步数据失败（HTTP {status}），请检查地址与写入权限。"),
    }
}

async fn create_collection(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
) -> Result<u16, String> {
    let method = reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL 是合法方法");
    let mut request = client.request(method, url);
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    Ok(response.status().as_u16())
}

async fn send_snapshot_once(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
    body: &str,
) -> Result<u16, RetryableError> {
    let mut request = client
        .put(url)
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_owned());
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request.send().await.map_err(|error| {
        RetryableError::new(
            describe_request_error(&error),
            error.is_timeout() || error.is_connect(),
        )
    })?;
    let status = response.status().as_u16();
    if is_retryable_status(status) {
        return Err(RetryableError::new(
            format!("写入 WebDAV 同步数据失败（HTTP {status}）"),
            true,
        ));
    }
    Ok(status)
}

async fn send_snapshot(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
    body: &str,
) -> Result<u16, String> {
    with_retry(|| send_snapshot_once(client, url, settings, body)).await
}

async fn put_snapshot(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
    snapshot: &SyncSnapshot,
    allow_fallback: bool,
) -> Result<(), String> {
    let body = serde_json::to_string(snapshot)
        .map_err(|error| format!("生成 WebDAV 同步数据失败：{error}"))?;
    let status = send_snapshot(client, url, settings, &body).await?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    if !matches!(status, 404 | 409) {
        return Err(snapshot_write_error(
            status,
            parent_collection_url(url).as_deref().unwrap_or(url),
        ));
    }

    // 404/409 通常意味着目标目录不存在：创建后重试一次。
    let directory = parent_collection_url(url).unwrap_or_else(|| url.to_owned());
    if create_collection(client, &directory, settings).await.is_ok() {
        let retry = send_snapshot(client, url, settings, &body).await?;
        if (200..300).contains(&retry) {
            return Ok(());
        }
    }

    // 部分服务端（例如坚果云根目录）不允许在配置目录里直接创建文件，
    // 退回程序自动拼接的子目录，用户无需修改设置。
    if allow_fallback {
        if let Some(fallback_url) = fallback_snapshot_url(url) {
            let fallback_directory = parent_collection_url(&fallback_url)
                .unwrap_or_else(|| fallback_url.clone());
            if create_collection(client, &fallback_directory, settings)
                .await
                .is_ok()
            {
                let fallback_status = send_snapshot(client, &fallback_url, settings, &body).await?;
                if (200..300).contains(&fallback_status) {
                    return Ok(());
                }
                return Err(snapshot_write_error(
                    fallback_status,
                    &fallback_directory,
                ));
            }
        }
    }

    Err(snapshot_write_error(status, &directory))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverManifest {
    /// 按封面目录地址记录已上传的文件，文件名由 UUID 生成且不会复用。
    #[serde(default)]
    uploaded: BTreeMap<String, BTreeSet<String>>,
}

fn covers_base_url(sync_url: &str) -> Option<String> {
    let (base, _) = sync_url.rsplit_once('/')?;
    (!base.is_empty()).then(|| format!("{base}/{COVER_REMOTE_DIRECTORY}"))
}

fn is_safe_cover_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':'])
}

fn cover_marker(name: &str) -> String {
    format!("{COVER_MARKER_PREFIX}{name}")
}

fn marked_cover_name(value: &str) -> Option<&str> {
    value
        .strip_prefix(COVER_MARKER_PREFIX)
        .filter(|name| is_safe_cover_name(name))
}

fn cover_content_type(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

fn load_cover_manifest(path: &Path) -> CoverManifest {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cover_manifest(path: &Path, manifest: &CoverManifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建封面缓存目录：{error}"))?;
    }
    let body = serde_json::to_string(manifest)
        .map_err(|error| format!("生成封面同步记录失败：{error}"))?;
    std::fs::write(path, body).map_err(|error| format!("写入封面同步记录失败：{error}"))
}

async fn download_cover(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    covers_directory: &Path,
    name: &str,
) -> Result<PathBuf, String> {
    let path = covers_directory.join(name);
    if path.is_file() {
        return Ok(path);
    }

    let url = format!("{covers_url}/{name}");
    let mut request = client.get(url);
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载封面失败（HTTP {}）", status.as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| describe_request_error(&error))?;
    if bytes.len() > MAX_COVER_BYTES {
        return Err("封面图片不能超过 10MB".to_owned());
    }
    std::fs::create_dir_all(covers_directory)
        .map_err(|error| format!("无法创建封面缓存目录：{error}"))?;
    std::fs::write(&path, &bytes).map_err(|error| format!("写入封面缓存失败：{error}"))?;
    Ok(path)
}

fn collection_ready(status: u16) -> bool {
    // 405 表示目录已存在，部分服务端也用它代替 201。
    (200..300).contains(&status) || status == 405
}

async fn ensure_cover_collection(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
) -> Result<(), String> {
    let status = create_collection(client, covers_url, settings).await?;
    if collection_ready(status) {
        return Ok(());
    }
    // 409：父目录还不存在，先创建父目录再重试一次。
    if status == 409 {
        if let Some(parent) = parent_collection_url(covers_url) {
            if create_collection(client, &parent, settings).await.is_ok() {
                let retry = create_collection(client, covers_url, settings).await?;
                if collection_ready(retry) {
                    return Ok(());
                }
                return Err(format!("创建 WebDAV 封面目录失败（HTTP {retry}）"));
            }
        }
    }
    Err(format!("创建 WebDAV 封面目录失败（HTTP {status}）"))
}

async fn upload_cover_once(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    name: &str,
    bytes: &[u8],
) -> Result<(), RetryableError> {
    let url = format!("{covers_url}/{name}");
    let mut request = client
        .put(url)
        .header(CONTENT_TYPE, cover_content_type(name))
        .body(bytes.to_vec());
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request.send().await.map_err(|error| {
        RetryableError::new(
            describe_request_error(&error),
            error.is_timeout() || error.is_connect(),
        )
    })?;
    let status = response.status().as_u16();
    if is_retryable_status(status) {
        return Err(RetryableError::new(
            format!("上传封面失败（HTTP {status}）"),
            true,
        ));
    }
    if !(200..300).contains(&status) {
        return Err(RetryableError::new(
            format!("上传封面失败（HTTP {status}）"),
            false,
        ));
    }
    Ok(())
}

async fn upload_cover(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    with_retry(|| upload_cover_once(client, covers_url, settings, name, bytes)).await
}

/// 把远端条目里的封面标记下载到本地，并替换成可用的本地路径。
async fn hydrate_cover_markers(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    covers_directory: &Path,
    manifest: &mut CoverManifest,
    entries: &mut [SyncEntry],
) {
    for entry in entries {
        let Some(name) = entry
            .cover_url
            .as_deref()
            .and_then(marked_cover_name)
            .map(str::to_owned)
        else {
            continue;
        };
        if let Ok(path) =
            download_cover(client, covers_url, settings, covers_directory, &name).await
        {
            entry.cover_url = Some(path.to_string_lossy().into_owned());
            manifest
                .uploaded
                .entry(covers_url.to_owned())
                .or_default()
                .insert(name);
        }
        // 下载失败时保留标记，下次同步继续重试。
    }
}

/// 把本地封面文件上传到 WebDAV，并把条目中的封面替换成可跨设备识别的标记。
/// 个别封面失败不影响整体同步，失败原因通过返回值交给界面提示。
async fn publish_local_covers(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    covers_directory: &Path,
    manifest: &mut CoverManifest,
    entries: &mut [SyncEntry],
    progress: Option<ProgressFn<'_>>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    // 条目索引 -> 封面文件名：上传成功后统一改写成跨设备标记。
    let mut planned: Vec<(usize, String)> = Vec::new();
    // 同名封面只上传一次。
    let mut pending: BTreeMap<String, PathBuf> = BTreeMap::new();

    for (index, entry) in entries.iter().enumerate() {
        let Some(value) = entry.cover_url.clone() else {
            continue;
        };
        if marked_cover_name(&value).is_some()
            || value.starts_with("http://")
            || value.starts_with("https://")
        {
            continue;
        }

        let path = PathBuf::from(&value);
        let Ok(relative) = path.strip_prefix(covers_directory) else {
            continue;
        };
        if relative.components().count() != 1 {
            continue;
        }
        let Some(name) = relative.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_safe_cover_name(name) || !path.is_file() {
            continue;
        }

        let uploaded = manifest
            .uploaded
            .get(covers_url)
            .is_some_and(|names| names.contains(name));
        if !uploaded && !pending.contains_key(name) {
            match std::fs::metadata(&path) {
                Ok(metadata) if metadata.len() as usize > MAX_COVER_BYTES => {
                    warnings.push(format!("封面超过 10MB，已跳过：{name}"));
                    continue;
                }
                Ok(_) => {
                    pending.insert(name.to_owned(), path.clone());
                }
                Err(error) => {
                    warnings.push(format!("读取本地封面失败：{name}（{error}）"));
                    continue;
                }
            }
        }

        planned.push((index, name.to_owned()));
    }

    if !pending.is_empty() {
        if let Err(error) = ensure_cover_collection(client, covers_url, settings).await {
            warnings.push(error);
            return warnings;
        }

        let total = pending.len() as u32;
        report_progress(progress, "covers", 0, total);
        let mut uploads = futures::stream::iter(pending.into_iter().map(|(name, path)| {
            let client = client.clone();
            let settings = settings.clone();
            let covers_url = covers_url.to_owned();
            async move {
                let warning = match std::fs::read(&path) {
                    Ok(bytes) if bytes.len() > MAX_COVER_BYTES => {
                        Some(format!("封面超过 10MB，已跳过：{name}"))
                    }
                    Ok(bytes) => {
                        match upload_cover(&client, &covers_url, &settings, &name, &bytes).await {
                            Ok(()) => None,
                            Err(error) => Some(format!("{error}：{name}")),
                        }
                    }
                    Err(error) => Some(format!("读取本地封面失败：{name}（{error}）")),
                };
                (name, warning)
            }
        }))
        .buffer_unordered(COVER_UPLOAD_CONCURRENCY);

        let mut completed = 0u32;
        while let Some((name, warning)) = uploads.next().await {
            completed += 1;
            match warning {
                None => {
                    manifest
                        .uploaded
                        .entry(covers_url.to_owned())
                        .or_default()
                        .insert(name);
                }
                Some(warning) => warnings.push(warning),
            }
            report_progress(progress, "covers", completed, total);
        }
    }

    let uploaded_names = manifest
        .uploaded
        .get(covers_url)
        .cloned()
        .unwrap_or_default();
    for (index, name) in planned {
        if uploaded_names.contains(&name) {
            entries[index].cover_url = Some(cover_marker(&name));
        }
    }

    warnings
}

/// 快照里仍然被引用的远端封面名（封面标记）。
fn collect_marker_names(entries: &[SyncEntry]) -> BTreeSet<String> {
    entries
        .iter()
        .filter_map(|entry| {
            entry
                .cover_url
                .as_deref()
                .and_then(marked_cover_name)
                .map(str::to_owned)
        })
        .collect()
}

/// 仍然被条目引用的本地封面文件名。
fn collect_local_cover_names(
    entries: &[SyncEntry],
    covers_directory: &Path,
) -> BTreeSet<String> {
    entries
        .iter()
        .filter_map(|entry| entry.cover_url.as_deref())
        .filter(|value| {
            !value.starts_with("http://")
                && !value.starts_with("https://")
                && marked_cover_name(value).is_none()
        })
        .filter_map(|value| {
            Path::new(value)
                .strip_prefix(covers_directory)
                .ok()
                .and_then(|relative| relative.file_name())
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        })
        .collect()
}

fn stale_remote_covers(
    manifest: &CoverManifest,
    covers_url: &str,
    referenced: &BTreeSet<String>,
) -> Vec<String> {
    manifest
        .uploaded
        .get(covers_url)
        .map(|names| {
            names
                .iter()
                .filter(|name| !referenced.contains(*name))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

async fn delete_cover(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    name: &str,
) -> Result<u16, String> {
    let mut request = client.delete(format!("{covers_url}/{name}"));
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    Ok(response.status().as_u16())
}

/// 删除不再被任何条目引用的旧封面：远端文件与本地缓存。
async fn remove_stale_covers(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    covers_directory: &Path,
    manifest: &mut CoverManifest,
    referenced_remote: &BTreeSet<String>,
    referenced_local: &BTreeSet<String>,
) -> Vec<String> {
    let mut warnings = Vec::new();

    for name in stale_remote_covers(manifest, covers_url, referenced_remote) {
        match delete_cover(client, covers_url, settings, &name).await {
            Ok(status) if (200..300).contains(&status) || status == 404 => {
                if let Some(names) = manifest.uploaded.get_mut(covers_url) {
                    names.remove(&name);
                }
            }
            Ok(status) => warnings.push(format!("删除旧封面失败（HTTP {status}）：{name}")),
            Err(error) => warnings.push(format!("{error}：{name}")),
        }
    }

    if let Ok(entries) = std::fs::read_dir(covers_directory) {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if referenced_local.contains(&name) {
                continue;
            }
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Err(error) = std::fs::remove_file(&path) {
                warnings.push(format!("删除本地旧封面失败：{name}（{error}）"));
            }
        }
    }

    warnings
}

pub async fn sync_now(
    database: &Database,
    data_directory: &Path,
    progress: Option<ProgressFn<'_>>,
) -> Result<SyncReport, String> {
    // 同一时刻只允许一个同步过程，避免并发请求互相覆盖。
    static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SYNC_LOCK.lock().await;
    report_progress(progress, "prepare", 0, 0);

    let settings = database.get_settings()?;
    let primary_url = prepare_sync_url(&settings)?;
    // 用户显式填了 .json 文件路径时，尊重原路径，不再追加子目录。
    let explicit_file = is_explicit_sync_file(&settings.webdav_url);
    // 封面始终放在配置目录下的 catchup-covers，快照换位置不需要重传封面。
    let covers_base = covers_base_url(&primary_url);

    // 读取本地数据后立即释放数据库锁，网络请求期间不持有 MutexGuard。
    let (mut local_entries, local_purged) = database.read_sync_state()?;

    let client = build_client()?;
    let (mut remote, mut remote_exists) = fetch_snapshot(&client, &primary_url, &settings).await?;
    let mut url = primary_url;
    if !remote_exists && !explicit_file {
        // 配置目录里没有快照时，检查程序自动拼接的子目录（兼容不允许在根目录建文件的服务端）。
        if let Some(fallback_url) = fallback_snapshot_url(&url) {
            let (fallback_remote, fallback_exists) =
                fetch_snapshot(&client, &fallback_url, &settings).await?;
            if fallback_exists {
                url = fallback_url;
                remote = fallback_remote;
                remote_exists = true;
            }
        }
    }
    // 在封面水合（把标记换成本地路径）之前记录远端内容，用于判断是否真的需要写入。
    let remote_content_key = snapshot_content_key(&remote.entries, &remote.purged);

    let covers_directory = data_directory.join(COVER_DIRECTORY_NAME);
    let manifest_path = data_directory.join(COVER_MANIFEST_FILE);
    let mut manifest = load_cover_manifest(&manifest_path);
    let original_manifest = manifest.clone();

    if let Some(covers_url) = covers_base.as_deref() {
        hydrate_cover_markers(
            &client,
            covers_url,
            &settings,
            &covers_directory,
            &mut manifest,
            &mut remote.entries,
        )
        .await;
        // 上一轮下载失败遗留的标记也在本次同步中重试。
        hydrate_cover_markers(
            &client,
            covers_url,
            &settings,
            &covers_directory,
            &mut manifest,
            &mut local_entries,
        )
        .await;
    }

    let merge = merge_libraries(
        &local_entries,
        &local_purged,
        &remote.entries,
        &remote.purged,
    );

    database.apply_sync_merge(&merge.entries, &merge.purged)?;

    let mut snapshot_entries = merge.entries;
    let mut warnings = if let Some(covers_url) = covers_base.as_deref() {
        publish_local_covers(
            &client,
            covers_url,
            &settings,
            &covers_directory,
            &mut manifest,
            &mut snapshot_entries,
            progress,
        )
        .await
    } else {
        Vec::new()
    };
    if manifest != original_manifest {
        let _ = save_cover_manifest(&manifest_path, &manifest);
    }

    let exported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true);
    let snapshot = SyncSnapshot {
        version: SNAPSHOT_VERSION,
        exported_at: exported_at.clone(),
        entries: snapshot_entries,
        purged: merge.purged,
    };
    // 内容没有变化时跳过写入，避免每次自动同步都产生一次无谓的 PUT。
    let content_changed = !remote_exists
        || snapshot_content_key(&snapshot.entries, &snapshot.purged) != remote_content_key;
    if content_changed {
        report_progress(progress, "snapshot", 0, 0);
        put_snapshot(&client, &url, &settings, &snapshot, !explicit_file).await?;
    }

    // 快照写入成功后再清理旧封面，避免远端仍引用时先删了文件。
    if let Some(covers_url) = covers_base.as_deref() {
        let referenced_remote = collect_marker_names(&snapshot.entries);
        // 用合并落库后的最新状态判断本地封面是否仍被引用，避免并发编辑时误删。
        let (latest_entries, _) = database.read_sync_state()?;
        let referenced_local = collect_local_cover_names(&latest_entries, &covers_directory);
        warnings.extend(
            remove_stale_covers(
                &client,
                covers_url,
                &settings,
                &covers_directory,
                &mut manifest,
                &referenced_remote,
                &referenced_local,
            )
            .await,
        );
        if manifest != original_manifest {
            let _ = save_cover_manifest(&manifest_path, &manifest);
        }
    }

    database.set_last_synced_at(&exported_at)?;

    Ok(SyncReport {
        merged: snapshot.entries.len() as u32,
        uploaded: merge.uploaded,
        downloaded: merge.downloaded,
        last_synced_at: exported_at,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use chrono::DateTime;
    use serde_json::{json, Value};

    use crate::database::{EntryStatus, MediaType};

    use super::*;

    fn sync_entry(id: &str, updated_at: &str) -> SyncEntry {
        SyncEntry {
            id: id.to_owned(),
            title: format!("条目 {id}"),
            media_type: MediaType::Drama,
            current_progress: 1,
            total_progress: Some(10),
            status: EntryStatus::Tracking,
            season: None,
            rating: None,
            platform: None,
            cover_url: None,
            overview: None,
            created_at: "2026-01-01T00:00:00.000000000Z".to_owned(),
            updated_at: updated_at.to_owned(),
            deleted_at: None,
        }
    }

    fn purged(id: &str, purged_at: &str) -> PurgedEntry {
        PurgedEntry {
            id: id.to_owned(),
            purged_at: purged_at.to_owned(),
        }
    }

    fn settings(enabled: bool, url: &str) -> AppSettings {
        AppSettings {
            tmdb_api_key: String::new(),
            webdav_url: url.to_owned(),
            webdav_username: "alice".to_owned(),
            webdav_password: "secret".to_owned(),
            webdav_enabled: enabled,
            last_synced_at: None,
            theme: "system".to_owned(),
            library_view: "list".to_owned(),
            ..AppSettings::default()
        }
    }

    #[test]
    fn merge_prefers_newer_remote_entry_for_the_same_id() {
        let local = sync_entry("a", "2026-01-01T00:00:00.000000000Z");
        let mut remote = sync_entry("a", "2026-02-01T00:00:00.000000000Z");
        remote.title = "远端更新".to_owned();

        let result = merge_libraries(&[local], &[], &[remote], &[]);

        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].title, "远端更新");
        assert_eq!(result.downloaded, 1);
        assert_eq!(result.uploaded, 1);
    }

    #[test]
    fn merge_keeps_local_entry_when_timestamps_are_equal() {
        let mut local = sync_entry("a", "2026-02-01T00:00:00.000000000Z");
        local.title = "本地优先".to_owned();
        let mut remote = sync_entry("a", "2026-02-01T00:00:00.000000000Z");
        remote.title = "远端同名".to_owned();

        let result = merge_libraries(&[local], &[], &[remote], &[]);

        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].title, "本地优先");
        assert_eq!(result.downloaded, 0);
        assert_eq!(result.uploaded, 0);
    }

    #[test]
    fn merge_adopts_entries_that_only_exist_remotely() {
        let remote = sync_entry("remote", "2026-03-01T00:00:00.000000000Z");

        let result = merge_libraries(&[], &[], std::slice::from_ref(&remote), &[]);

        assert_eq!(result.entries, vec![remote]);
        assert_eq!(result.downloaded, 1);
        assert_eq!(result.uploaded, 0);
    }

    #[test]
    fn merge_counts_local_only_entries_as_uploads() {
        let local = sync_entry("local", "2026-03-01T00:00:00.000000000Z");

        let result = merge_libraries(std::slice::from_ref(&local), &[], &[], &[]);

        assert_eq!(result.entries, vec![local]);
        assert_eq!(result.uploaded, 1);
        assert_eq!(result.downloaded, 0);
    }

    #[test]
    fn merge_filters_entries_deleted_by_a_purge_tombstone() {
        let older = sync_entry("old", "2026-01-01T00:00:00.000000000Z");
        let same = sync_entry("same", "2026-04-01T00:00:00.000000000Z");
        let newer = sync_entry("newer", "2026-05-01T00:00:00.000000000Z");
        let tombstones = vec![
            purged("old", "2026-01-02T00:00:00.000000000Z"),
            purged("same", "2026-04-01T00:00:00.000000000Z"),
        ];

        let result = merge_libraries(&[], &[], &[older, same, newer.clone()], &tombstones);

        assert_eq!(result.entries, vec![newer]);
        assert_eq!(result.purged.len(), 2);
    }

    #[test]
    fn remote_purge_tombstone_removes_local_entry() {
        let local = sync_entry("local", "2026-01-01T00:00:00.000000000Z");
        let tombstone = purged("local", "2026-01-02T00:00:00.000000000Z");

        let result = merge_libraries(&[local], &[], &[], &[tombstone]);

        assert!(result.entries.is_empty());
        assert_eq!(result.purged.len(), 1);
    }

    #[test]
    fn entries_restored_after_purge_are_kept() {
        let mut restored = sync_entry("restored", "2026-06-01T00:00:00.000000000Z");
        restored.title = "恢复后的条目".to_owned();
        let tombstone = purged("restored", "2026-05-01T00:00:00.000000000Z");

        let result = merge_libraries(
            std::slice::from_ref(&restored),
            std::slice::from_ref(&tombstone),
            &[],
            &[],
        );

        assert_eq!(result.entries, vec![restored]);
        assert_eq!(result.purged, vec![tombstone]);
    }

    #[test]
    fn snapshot_round_trip_keeps_deleted_at_and_purged_records() {
        let mut deleted = sync_entry("deleted", "2026-07-01T00:00:00.000000000Z");
        deleted.deleted_at = Some("2026-07-02T00:00:00.000000000Z".to_owned());
        let snapshot = SyncSnapshot {
            version: SNAPSHOT_VERSION,
            exported_at: "2026-07-03T00:00:00.000000000Z".to_owned(),
            entries: vec![deleted],
            purged: vec![purged("gone", "2026-07-04T00:00:00.000000000Z")],
        };

        let encoded = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            encoded["entries"][0]["deletedAt"],
            json!("2026-07-02T00:00:00.000000000Z")
        );
        assert_eq!(
            encoded["purged"][0]["purgedAt"],
            json!("2026-07-04T00:00:00.000000000Z")
        );
        let decoded: SyncSnapshot = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, snapshot);
    }

    #[test]
    fn snapshot_omits_deleted_at_when_the_entry_is_active() {
        let snapshot = SyncSnapshot {
            version: SNAPSHOT_VERSION,
            exported_at: String::new(),
            entries: vec![sync_entry("active", "2026-01-01T00:00:00.000000000Z")],
            purged: Vec::new(),
        };

        let value = serde_json::to_value(&snapshot).unwrap();
        assert!(value["entries"][0].get("deletedAt").is_none());
        assert_eq!(value["version"], json!(1));
    }

    #[test]
    fn sync_url_handles_trailing_slashes_and_json_paths() {
        assert_eq!(
            prepare_sync_url(&settings(true, "https://dav.example.com/catchup")).unwrap(),
            "https://dav.example.com/catchup/catchup-sync.json"
        );
        assert_eq!(
            prepare_sync_url(&settings(true, "https://dav.example.com/catchup/")).unwrap(),
            "https://dav.example.com/catchup/catchup-sync.json"
        );
        assert_eq!(
            prepare_sync_url(&settings(true, "https://dav.example.com/custom.json")).unwrap(),
            "https://dav.example.com/custom.json"
        );
        assert_eq!(
            prepare_sync_url(&settings(true, "https://dav.example.com/custom.JSON")).unwrap(),
            "https://dav.example.com/custom.JSON"
        );
    }

    #[test]
    fn sync_requires_enabled_settings_with_a_url() {
        assert_eq!(
            prepare_sync_url(&settings(false, "https://dav.example.com")).unwrap_err(),
            "请先在设置中启用并填写 WebDAV 地址"
        );
        assert_eq!(
            prepare_sync_url(&settings(true, "  ")).unwrap_err(),
            "请先在设置中启用并填写 WebDAV 地址"
        );
        assert_eq!(
            prepare_sync_url(&settings(true, "ftp://dav.example.com")).unwrap_err(),
            "WebDAV 服务器地址仅支持 http 或 https 链接"
        );
    }

    #[test]
    fn basic_auth_is_encoded_from_username_and_password() {
        let header = authorization_header(&settings(true, "https://dav.example.com")).unwrap();
        assert_eq!(header, "Basic YWxpY2U6c2VjcmV0");

        let mut anonymous = settings(true, "https://dav.example.com");
        anonymous.webdav_username = "   ".to_owned();
        assert!(authorization_header(&anonymous).is_none());
    }

    #[test]
    fn report_serializes_in_camel_case_with_rfc3339_time() {
        let report = SyncReport {
            merged: 3,
            uploaded: 1,
            downloaded: 2,
            last_synced_at: "2026-11-20T08:00:00.000000000Z".to_owned(),
            warnings: vec!["上传封面失败（HTTP 404）：cover-1.jpg".to_owned()],
        };
        let value: Value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["merged"], json!(3));
        assert_eq!(value["uploaded"], json!(1));
        assert_eq!(value["downloaded"], json!(2));
        assert_eq!(
            value["warnings"][0],
            json!("上传封面失败（HTTP 404）：cover-1.jpg")
        );
        DateTime::parse_from_rfc3339(value["lastSyncedAt"].as_str().unwrap()).unwrap();
        assert!(value.get("last_synced_at").is_none());
    }

    #[test]
    fn snapshot_write_error_explains_missing_directory() {
        let message = snapshot_write_error(404, "https://dav.example.com/dav/CatchUp");
        assert!(message.contains("目标目录不存在"));
        assert!(message.contains("https://dav.example.com/dav/CatchUp"));
        assert!(snapshot_write_error(403, "https://dav.example.com/dav").contains("权限"));
    }

    #[test]
    fn parent_collection_url_drops_the_file_name() {
        assert_eq!(
            parent_collection_url("https://dav.example.com/dav/CatchUp/catchup-sync.json")
                .as_deref(),
            Some("https://dav.example.com/dav/CatchUp")
        );
        assert_eq!(
            parent_collection_url("https://dav.example.com/dav/catchup-sync.json").as_deref(),
            Some("https://dav.example.com/dav")
        );
        assert_eq!(parent_collection_url("catchup-sync.json"), None);
    }

    #[test]
    fn fallback_directory_is_appended_only_when_needed() {
        assert_eq!(
            fallback_snapshot_url("https://dav.example.com/dav/catchup-sync.json").as_deref(),
            Some("https://dav.example.com/dav/CatchUp/catchup-sync.json")
        );
        assert_eq!(
            fallback_snapshot_url("https://dav.example.com/dav/CatchUp/catchup-sync.json"),
            None
        );
        assert_eq!(fallback_snapshot_url("catchup-sync.json"), None);
    }

    #[test]
    fn explicit_json_path_is_respected() {
        assert!(is_explicit_sync_file("https://dav.example.com/dav/custom.json"));
        assert!(is_explicit_sync_file(" https://dav.example.com/dav/custom.JSON/ "));
        assert!(!is_explicit_sync_file("https://dav.example.com/dav/"));
        assert!(!is_explicit_sync_file("https://dav.example.com/dav"));
    }

    #[test]
    fn cover_directory_lives_next_to_the_snapshot() {
        assert_eq!(
            covers_base_url("https://dav.example.com/catchup/catchup-sync.json").as_deref(),
            Some("https://dav.example.com/catchup/catchup-covers")
        );
        assert_eq!(covers_base_url("catchup-sync.json"), None);
    }

    #[test]
    fn cover_markers_reject_unsafe_file_names() {
        assert_eq!(
            marked_cover_name("catchup-cover:cover-1.jpg"),
            Some("cover-1.jpg")
        );
        assert_eq!(marked_cover_name("catchup-cover:../secret.jpg"), None);
        assert_eq!(marked_cover_name("catchup-cover:C:\\secret.jpg"), None);
        assert_eq!(marked_cover_name("https://example.com/a.jpg"), None);
        assert_eq!(cover_marker("a.png"), "catchup-cover:a.png");
    }

    #[test]
    fn cover_content_types_follow_the_extension() {
        assert_eq!(cover_content_type("cover-1.PNG"), "image/png");
        assert_eq!(cover_content_type("cover-1.webp"), "image/webp");
        assert_eq!(cover_content_type("cover-1"), "image/jpeg");
    }

    #[test]
    fn stale_remote_covers_are_unreferenced_manifest_entries() {
        let mut manifest = CoverManifest::default();
        manifest
            .uploaded
            .entry("https://dav.example.com/covers".to_owned())
            .or_default()
            .extend(["a.jpg".to_owned(), "b.jpg".to_owned()]);
        let referenced = BTreeSet::from(["a.jpg".to_owned()]);

        assert_eq!(
            stale_remote_covers(&manifest, "https://dav.example.com/covers", &referenced),
            vec!["b.jpg".to_owned()]
        );
        assert!(
            stale_remote_covers(&manifest, "https://other.example.com/covers", &referenced)
                .is_empty()
        );
    }

    #[test]
    fn local_cover_names_only_include_files_inside_the_covers_directory() {
        let directory = tempfile::tempdir().unwrap();
        let covers = directory.path().join("covers");
        let mut inside = sync_entry("inside", "2026-01-01T00:00:00.000000000Z");
        inside.cover_url = Some(covers.join("cover-1.jpg").to_string_lossy().into_owned());
        let mut outside = sync_entry("outside", "2026-01-01T00:00:00.000000000Z");
        outside.cover_url =
            Some(directory.path().join("other.jpg").to_string_lossy().into_owned());
        let mut marker = sync_entry("marker", "2026-01-01T00:00:00.000000000Z");
        marker.cover_url = Some("catchup-cover:cover-3.jpg".to_owned());

        let names = collect_local_cover_names(&[inside, outside, marker], &covers);

        assert_eq!(names, BTreeSet::from(["cover-1.jpg".to_owned()]));
    }

    #[test]
    fn cover_manifest_round_trips_on_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(COVER_MANIFEST_FILE);
        let mut manifest = CoverManifest::default();
        manifest
            .uploaded
            .entry("https://dav.example.com/covers".to_owned())
            .or_default()
            .insert("cover-1.jpg".to_owned());

        save_cover_manifest(&path, &manifest).unwrap();

        assert_eq!(load_cover_manifest(&path), manifest);
    }

    #[test]
    fn missing_or_corrupted_manifest_falls_back_to_empty() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(COVER_MANIFEST_FILE);
        assert_eq!(load_cover_manifest(&path), CoverManifest::default());

        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load_cover_manifest(&path), CoverManifest::default());
    }

    #[test]
    fn retry_covers_rate_limits_and_server_errors_only() {
        for status in [429, 500, 502, 503, 504] {
            assert!(is_retryable_status(status), "{status} 应该重试");
        }
        for status in [400, 401, 403, 404, 409, 412, 422] {
            assert!(!is_retryable_status(status), "{status} 不应该重试");
        }
    }

    #[test]
    fn snapshot_content_key_ignores_order_and_exported_time() {
        let first = sync_entry("a", "2026-01-01T00:00:00.000000000Z");
        let second = sync_entry("b", "2026-02-01T00:00:00.000000000Z");

        let left = snapshot_content_key(&[first.clone(), second.clone()], &[]);
        let right = snapshot_content_key(&[second, first], &[]);

        assert_eq!(left, right);
    }

    #[test]
    fn snapshot_content_key_detects_meaningful_changes() {
        let entry = sync_entry("a", "2026-01-01T00:00:00.000000000Z");
        let base = snapshot_content_key(std::slice::from_ref(&entry), &[]);

        let mut renamed = entry.clone();
        renamed.title = "改名后".to_owned();
        assert_ne!(base, snapshot_content_key(&[renamed], &[]));

        let tombstone = purged("b", "2026-03-01T00:00:00.000000000Z");
        assert_ne!(base, snapshot_content_key(&[entry], &[tombstone]));
    }
}
