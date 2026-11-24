use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

use crate::{
    database::{Database, PurgedEntry, SyncEntry},
    settings::AppSettings,
};

const SYNC_FILE_NAME: &str = "catchup-sync.json";
const SNAPSHOT_VERSION: u32 = 1;
const SYNC_TIMEOUT_SECONDS: u64 = 20;
const COVER_DIRECTORY_NAME: &str = "covers";
const COVER_REMOTE_DIRECTORY: &str = "catchup-covers";
const COVER_MARKER_PREFIX: &str = "catchup-cover:";
const COVER_MANIFEST_FILE: &str = "webdav-covers.json";
const MAX_COVER_BYTES: usize = 10 * 1024 * 1024;

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

fn prepare_sync_url(settings: &AppSettings) -> Result<String, String> {
    let url = settings.webdav_url.trim();
    if !settings.webdav_enabled || url.is_empty() {
        return Err("请先在设置中启用并填写 WebDAV 地址".to_owned());
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

async fn fetch_snapshot(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
) -> Result<SyncSnapshot, String> {
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
        return Ok(SyncSnapshot {
            version: SNAPSHOT_VERSION,
            ..SyncSnapshot::default()
        });
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
        return Ok(SyncSnapshot {
            version: SNAPSHOT_VERSION,
            ..SyncSnapshot::default()
        });
    }
    serde_json::from_str(&body).map_err(|error| format!("解析 WebDAV 同步数据失败：{error}"))
}

async fn put_snapshot(
    client: &reqwest::Client,
    url: &str,
    settings: &AppSettings,
    snapshot: &SyncSnapshot,
) -> Result<(), String> {
    let body = serde_json::to_string(snapshot)
        .map_err(|error| format!("生成 WebDAV 同步数据失败：{error}"))?;
    let mut request = client
        .put(url)
        .header(CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "写入 WebDAV 同步数据失败（HTTP {}），请检查地址与写入权限。",
            status.as_u16()
        ));
    }
    Ok(())
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
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
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

async fn ensure_cover_collection(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
) -> Result<(), String> {
    let method = reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL 是合法方法");
    let mut request = client.request(method, covers_url);
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    // 405 表示目录已存在，部分服务端也用它代替 201。
    if status.is_success() || status.as_u16() == 405 {
        Ok(())
    } else {
        Err(format!(
            "创建 WebDAV 封面目录失败（HTTP {}）",
            status.as_u16()
        ))
    }
}

async fn upload_cover(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    name: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let url = format!("{covers_url}/{name}");
    let mut request = client
        .put(url)
        .header(CONTENT_TYPE, cover_content_type(name))
        .body(bytes);
    if let Some(header) = authorization_header(settings) {
        request = request.header(AUTHORIZATION, header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("上传封面失败（HTTP {}）", status.as_u16()));
    }
    Ok(())
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
        if let Ok(path) = download_cover(client, covers_url, settings, covers_directory, &name).await
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
async fn publish_local_covers(
    client: &reqwest::Client,
    covers_url: &str,
    settings: &AppSettings,
    covers_directory: &Path,
    manifest: &mut CoverManifest,
    entries: &mut [SyncEntry],
) {
    let mut collection_ready = false;

    for entry in entries {
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
        if !uploaded {
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if bytes.len() > MAX_COVER_BYTES {
                continue;
            }
            if !collection_ready {
                if ensure_cover_collection(client, covers_url, settings)
                    .await
                    .is_err()
                {
                    return;
                }
                collection_ready = true;
            }
            if upload_cover(client, covers_url, settings, name, bytes)
                .await
                .is_err()
            {
                continue;
            }
            manifest
                .uploaded
                .entry(covers_url.to_owned())
                .or_default()
                .insert(name.to_owned());
        }

        entry.cover_url = Some(cover_marker(name));
    }
}

pub async fn sync_now(
    database: &Database,
    data_directory: &Path,
) -> Result<SyncReport, String> {
    // 同一时刻只允许一个同步过程，避免并发请求互相覆盖。
    static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SYNC_LOCK.lock().await;

    let settings = database.get_settings()?;
    let url = prepare_sync_url(&settings)?;

    // 读取本地数据后立即释放数据库锁，网络请求期间不持有 MutexGuard。
    let (mut local_entries, local_purged) = database.read_sync_state()?;

    let client = build_client()?;
    let mut remote = fetch_snapshot(&client, &url, &settings).await?;

    let covers_directory = data_directory.join(COVER_DIRECTORY_NAME);
    let manifest_path = data_directory.join(COVER_MANIFEST_FILE);
    let mut manifest = load_cover_manifest(&manifest_path);
    let original_manifest = manifest.clone();
    let covers_base = covers_base_url(&url);

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
    if let Some(covers_url) = covers_base.as_deref() {
        publish_local_covers(
            &client,
            covers_url,
            &settings,
            &covers_directory,
            &mut manifest,
            &mut snapshot_entries,
        )
        .await;
    }
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
    put_snapshot(&client, &url, &settings, &snapshot).await?;

    database.set_last_synced_at(&exported_at)?;

    Ok(SyncReport {
        merged: snapshot.entries.len() as u32,
        uploaded: merge.uploaded,
        downloaded: merge.downloaded,
        last_synced_at: exported_at,
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
        };
        let value: Value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["merged"], json!(3));
        assert_eq!(value["uploaded"], json!(1));
        assert_eq!(value["downloaded"], json!(2));
        DateTime::parse_from_rfc3339(value["lastSyncedAt"].as_str().unwrap()).unwrap();
        assert!(value.get("last_synced_at").is_none());
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
}
