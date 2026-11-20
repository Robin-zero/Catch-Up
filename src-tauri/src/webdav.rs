use std::{cmp::Ordering, collections::HashMap, time::Duration};

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

pub async fn sync_now(database: &Database) -> Result<SyncReport, String> {
    // 同一时刻只允许一个同步过程，避免并发请求互相覆盖。
    static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SYNC_LOCK.lock().await;

    let settings = database.get_settings()?;
    let url = prepare_sync_url(&settings)?;

    // 读取本地数据后立即释放数据库锁，网络请求期间不持有 MutexGuard。
    let (local_entries, local_purged) = database.read_sync_state()?;

    let client = build_client()?;
    let remote = fetch_snapshot(&client, &url, &settings).await?;
    let merge = merge_libraries(
        &local_entries,
        &local_purged,
        &remote.entries,
        &remote.purged,
    );

    database.apply_sync_merge(&merge.entries, &merge.purged)?;

    let exported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true);
    let snapshot = SyncSnapshot {
        version: SNAPSHOT_VERSION,
        exported_at: exported_at.clone(),
        entries: merge.entries,
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
}
