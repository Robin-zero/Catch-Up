use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use rusqlite::{params, types::Type, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::settings::{normalize_library_view, normalize_theme, AppSettings};

const DATABASE_VERSION: u32 = 5;
const TRASH_RETENTION_DAYS: i64 = 30;
const ENTRY_COLUMNS: &str = "
    id, title, media_type, current_progress, total_progress, status,
    season, rating, platform, cover_url, overview, created_at, updated_at
";
const ENTRIES_V2_DEFINITION: &str = "
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    media_type TEXT NOT NULL CHECK (
        media_type IN ('drama', 'anime', 'variety', 'novel', 'movie', 'short_drama')
    ),
    current_progress INTEGER NOT NULL CHECK (
        typeof(current_progress) = 'integer' AND current_progress >= 0
    ),
    total_progress INTEGER CHECK (
        total_progress IS NULL
        OR (typeof(total_progress) = 'integer' AND total_progress > 0)
    ),
    status TEXT NOT NULL CHECK (
        status IN ('tracking', 'completed', 'dropped', 'to_watch')
    ),
    season INTEGER CHECK (
        season IS NULL
        OR (typeof(season) = 'integer' AND season BETWEEN 1 AND 999)
    ),
    rating REAL CHECK (
        rating IS NULL
        OR (
            typeof(rating) IN ('real', 'integer')
            AND rating >= 0
            AND rating <= 10
            AND abs(rating * 10 - round(rating * 10)) < 0.000001
        )
    ),
    platform TEXT CHECK (
        platform IS NULL
        OR (typeof(platform) = 'text' AND length(trim(platform)) BETWEEN 1 AND 60)
    ),
    cover_url TEXT CHECK (
        cover_url IS NULL
        OR (
            typeof(cover_url) = 'text'
            AND length(cover_url) <= 500
            AND (cover_url LIKE 'http://%' OR cover_url LIKE 'https://%')
        )
    ),
    overview TEXT CHECK (
        overview IS NULL
        OR (typeof(overview) = 'text' AND length(overview) <= 2000)
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    CHECK (total_progress IS NULL OR current_progress <= total_progress)
";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Drama,
    Anime,
    Variety,
    Novel,
    Movie,
    #[serde(rename = "short_drama")]
    ShortDrama,
}

impl MediaType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Drama => "drama",
            Self::Anime => "anime",
            Self::Variety => "variety",
            Self::Novel => "novel",
            Self::Movie => "movie",
            Self::ShortDrama => "short_drama",
        }
    }

    /// 进度单位：小说按“章”，其余内容按“集”。
    pub fn unit(self) -> &'static str {
        match self {
            Self::Novel => "章",
            _ => "集",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "drama" => Ok(Self::Drama),
            "anime" => Ok(Self::Anime),
            "variety" => Ok(Self::Variety),
            "novel" => Ok(Self::Novel),
            "movie" => Ok(Self::Movie),
            "short_drama" => Ok(Self::ShortDrama),
            _ => Err(format!("数据库包含未知媒体类型：{value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    Tracking,
    Completed,
    Dropped,
    #[serde(rename = "to_watch")]
    ToWatch,
}

impl EntryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tracking => "tracking",
            Self::Completed => "completed",
            Self::Dropped => "dropped",
            Self::ToWatch => "to_watch",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "tracking" => Ok(Self::Tracking),
            "completed" => Ok(Self::Completed),
            "dropped" => Ok(Self::Dropped),
            "to_watch" => Ok(Self::ToWatch),
            _ => Err(format!("数据库包含未知追更状态：{value}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub id: String,
    pub title: String,
    pub media_type: MediaType,
    pub current_progress: i64,
    pub total_progress: Option<i64>,
    pub status: EntryStatus,
    pub season: Option<u32>,
    pub rating: Option<f64>,
    pub platform: Option<String>,
    pub cover_url: Option<String>,
    pub overview: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub title: String,
    pub media_type: MediaType,
    pub current_progress: i64,
    pub total_progress: Option<i64>,
    pub status: EntryStatus,
    pub season: Option<u32>,
    pub rating: Option<f64>,
    pub platform: Option<String>,
    pub cover_url: Option<String>,
    pub overview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
    pub entries: Vec<MediaEntry>,
}

/// 同步用的条目结构：比前端 `MediaEntry` 多一个回收站墓碑字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    pub id: String,
    pub title: String,
    pub media_type: MediaType,
    pub current_progress: i64,
    pub total_progress: Option<i64>,
    pub status: EntryStatus,
    pub season: Option<u32>,
    pub rating: Option<f64>,
    pub platform: Option<String>,
    pub cover_url: Option<String>,
    pub overview: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

/// 彻底删除的墓碑记录，用于阻止远端旧数据复活。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgedEntry {
    pub id: String,
    pub purged_at: String,
}

struct ValidatedInput {
    title: String,
    media_type: MediaType,
    current_progress: i64,
    total_progress: Option<i64>,
    status: EntryStatus,
    season: Option<u32>,
    rating: Option<f64>,
    platform: Option<String>,
    cover_url: Option<String>,
    overview: Option<String>,
}

impl EntryInput {
    fn validate(self) -> Result<ValidatedInput, String> {
        let title = self.title.trim().to_owned();
        if title.is_empty() {
            return Err("标题不能为空".to_owned());
        }
        if self.current_progress < 0 {
            return Err("当前进度不能为负数".to_owned());
        }
        if self.total_progress.is_some_and(|total| total <= 0) {
            return Err("总进度必须为空或正整数".to_owned());
        }
        if self
            .total_progress
            .is_some_and(|total| self.current_progress > total)
        {
            return Err("当前进度不能超过总进度".to_owned());
        }

        let status = if self.status == EntryStatus::Dropped || self.status == EntryStatus::ToWatch {
            self.status
        } else if self.total_progress == Some(self.current_progress) {
            EntryStatus::Completed
        } else {
            self.status
        };

        Ok(ValidatedInput {
            title,
            media_type: self.media_type,
            current_progress: self.current_progress,
            total_progress: self.total_progress,
            status,
            season: validate_season(self.season)?,
            rating: validate_rating(self.rating)?,
            platform: optional_trimmed(self.platform, "平台", 60)?,
            cover_url: validate_cover_url(self.cover_url)?,
            overview: optional_trimmed(self.overview, "简介", 2000)?,
        })
    }
}

fn validate_season(season: Option<u32>) -> Result<Option<u32>, String> {
    match season {
        Some(value) if !(1..=999).contains(&value) => Err("季数必须在 1 到 999 之间".to_owned()),
        other => Ok(other),
    }
}

fn validate_rating(rating: Option<f64>) -> Result<Option<f64>, String> {
    match rating {
        None => Ok(None),
        Some(value) => {
            if !value.is_finite() || !(0.0..=10.0).contains(&value) {
                return Err("评分必须在 0 到 10 之间".to_owned());
            }
            Ok(Some((value * 10.0).round() / 10.0))
        }
    }
}

fn validate_cover_url(cover_url: Option<String>) -> Result<Option<String>, String> {
    let trimmed = optional_trimmed(cover_url, "封面地址", 500)?;
    if let Some(url) = &trimmed {
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err("封面地址仅支持 http 或 https 链接".to_owned());
        }
    }
    Ok(trimmed)
}

fn optional_trimmed(
    value: Option<String>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > max_chars {
                return Err(format!("{field}不能超过 {max_chars} 个字符"));
            }
            Ok(Some(trimmed.to_owned()))
        }
    }
}

pub(crate) fn parse_media_type_field(raw: &str) -> Result<MediaType, String> {
    match raw.trim() {
        "drama" | "剧集" | "电视剧" => Ok(MediaType::Drama),
        "anime" | "番剧" | "动漫" | "动画" => Ok(MediaType::Anime),
        "variety" | "综艺" => Ok(MediaType::Variety),
        "novel" | "小说" => Ok(MediaType::Novel),
        "movie" | "电影" => Ok(MediaType::Movie),
        "short_drama" | "短剧" => Ok(MediaType::ShortDrama),
        other => Err(format!("未知类型：{other}")),
    }
}

pub(crate) fn parse_optional_count(raw: &str, field: &str) -> Result<Option<i64>, String> {
    let cleaned = raw
        .trim()
        .trim_start_matches('第')
        .trim_end_matches(['集', '章', '部'])
        .trim();
    if cleaned.is_empty() {
        return Ok(None);
    }
    cleaned
        .parse::<i64>()
        .map(Some)
        .map_err(|_| format!("{field}格式不正确"))
}

pub(crate) fn parse_optional_season(raw: &str) -> Result<Option<u32>, String> {
    let cleaned = raw.trim();
    let cleaned = cleaned.strip_prefix('第').unwrap_or(cleaned).trim();
    let cleaned = cleaned.strip_suffix('季').unwrap_or(cleaned).trim();
    if cleaned.is_empty() {
        return Ok(None);
    }
    cleaned
        .parse::<u32>()
        .map(Some)
        .map_err(|_| "季数格式不正确".to_owned())
}

pub(crate) fn parse_optional_rating(raw: &str) -> Result<Option<f64>, String> {
    let cleaned = raw.trim().trim_end_matches('分').trim();
    if cleaned.is_empty() {
        return Ok(None);
    }
    cleaned
        .parse::<f64>()
        .map(Some)
        .map_err(|_| "评分格式不正确".to_owned())
}

pub(crate) fn parse_progress_field(raw: &str) -> Result<(i64, Option<i64>), String> {
    match raw.split_once('/') {
        Some((current, total)) => {
            let current = parse_optional_count(current, "当前进度")?.unwrap_or(0);
            let total = parse_optional_count(total, "总进度")?;
            Ok((current, total))
        }
        None => Ok((parse_optional_count(raw, "当前进度")?.unwrap_or(0), None)),
    }
}

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建应用数据目录 {}：{error}", parent.display()))?;
        }

        let connection = Connection::open(path)
            .map_err(|error| format!("无法打开 CatchUp 数据库 {}：{error}", path.display()))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("无法配置数据库等待时间：{error}"))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|error| format!("无法启用数据库外键约束：{error}"))?;

        let database = Self {
            connection: Mutex::new(connection),
        };
        database.migrate()?;
        database.purge_expired_trash()?;
        Ok(database)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "数据库锁已失效，请重启应用".to_owned())
    }

    fn migrate(&self) -> Result<(), String> {
        let mut connection = self.lock()?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| format!("无法读取数据库版本：{error}"))?;

        if version > DATABASE_VERSION {
            return Err(format!(
                "数据库版本 {version} 高于当前应用支持的版本 {DATABASE_VERSION}，请升级应用"
            ));
        }
        if version == DATABASE_VERSION {
            return Ok(());
        }

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动数据库迁移：{error}"))?;

        transaction
            .execute_batch("DROP TABLE IF EXISTS entries_v2;")
            .map_err(|error| format!("无法清理旧迁移表：{error}"))?;

        let entries_exists = table_exists(&transaction, "entries")
            .map_err(|error| format!("无法检查数据库表：{error}"))?;
        let already_v2 = entries_exists
            && table_columns(&transaction, "entries")
                .map_err(|error| format!("无法读取数据库表结构：{error}"))?
                .iter()
                .any(|column| column == "deleted_at");

        if !entries_exists {
            transaction
                .execute_batch(&format!("CREATE TABLE entries ({ENTRIES_V2_DEFINITION});"))
                .map_err(|error| format!("无法初始化数据库表：{error}"))?;
        } else if !already_v2 {
            transaction
                .execute_batch(&format!(
                    "CREATE TABLE entries_v2 ({ENTRIES_V2_DEFINITION});"
                ))
                .map_err(|error| format!("无法创建新版数据库表：{error}"))?;
            transaction
                .execute_batch(
                    "
                    INSERT INTO entries_v2 (
                        id, title, media_type, current_progress, total_progress, status,
                        season, rating, platform, cover_url, overview, created_at, updated_at,
                        deleted_at
                    )
                    SELECT
                        id, title, media_type, current_progress, total_progress, status,
                        NULL, NULL, NULL, NULL, NULL, created_at, updated_at, NULL
                    FROM entries;

                    DROP TABLE entries;
                    ALTER TABLE entries_v2 RENAME TO entries;
                    ",
                )
                .map_err(|error| format!("无法升级数据库表：{error}"))?;
        } else if !entries_status_allows_to_watch(&transaction)
            .map_err(|error| format!("无法检查数据库表结构：{error}"))?
        {
            // v4 → v5：重建 entries 表，把状态约束扩展为支持“待看”。
            transaction
                .execute_batch("DROP TABLE IF EXISTS entries_v5;")
                .map_err(|error| format!("无法清理旧迁移表：{error}"))?;
            transaction
                .execute_batch(&format!(
                    "CREATE TABLE entries_v5 ({ENTRIES_V2_DEFINITION});"
                ))
                .map_err(|error| format!("无法创建新版数据库表：{error}"))?;
            transaction
                .execute_batch(
                    "
                    INSERT INTO entries_v5 (
                        id, title, media_type, current_progress, total_progress, status,
                        season, rating, platform, cover_url, overview, created_at, updated_at,
                        deleted_at
                    )
                    SELECT
                        id, title, media_type, current_progress, total_progress, status,
                        season, rating, platform, cover_url, overview, created_at, updated_at,
                        deleted_at
                    FROM entries;

                    DROP TABLE entries;
                    ALTER TABLE entries_v5 RENAME TO entries;
                    ",
                )
                .map_err(|error| format!("无法升级数据库表：{error}"))?;
        }

        transaction
            .execute_batch(
                "
                CREATE INDEX IF NOT EXISTS entries_updated_at_id_idx
                    ON entries (updated_at DESC, id ASC);
                CREATE INDEX IF NOT EXISTS entries_deleted_at_idx
                    ON entries (deleted_at DESC);
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS purged_entries (
                    id TEXT PRIMARY KEY,
                    purged_at TEXT NOT NULL
                );
                ",
            )
            .map_err(|error| format!("无法创建数据库索引或设置表：{error}"))?;
        transaction
            .pragma_update(None, "user_version", DATABASE_VERSION)
            .map_err(|error| format!("无法写入数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成数据库迁移：{error}"))
    }

    fn purge_expired_trash(&self) -> Result<(), String> {
        let now = timestamp();
        let cutoff = (Utc::now() - ChronoDuration::days(TRASH_RETENTION_DAYS))
            .to_rfc3339_opts(SecondsFormat::Nanos, true);
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动回收站清理事务：{error}"))?;
        transaction
            .execute(
                "
                INSERT INTO purged_entries (id, purged_at)
                SELECT id, CASE WHEN ?1 > updated_at THEN ?1 ELSE updated_at END
                FROM entries
                WHERE deleted_at IS NOT NULL AND deleted_at < ?2
                ON CONFLICT(id) DO UPDATE SET purged_at = CASE
                    WHEN excluded.purged_at > purged_entries.purged_at
                    THEN excluded.purged_at ELSE purged_entries.purged_at END
                ",
                params![now, cutoff],
            )
            .map_err(|error| format!("无法记录过期条目清理记录：{error}"))?;
        transaction
            .execute(
                "DELETE FROM entries WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
                params![cutoff],
            )
            .map_err(|error| format!("无法清理过期回收站条目：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成回收站清理：{error}"))
    }

    pub fn list_entries(&self) -> Result<Vec<MediaEntry>, String> {
        let connection = self.lock()?;
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM entries \
             WHERE deleted_at IS NULL ORDER BY updated_at DESC, id ASC"
        );
        query_entries(&connection, &sql, "追更列表")
    }

    pub fn list_trash(&self) -> Result<Vec<MediaEntry>, String> {
        let connection = self.lock()?;
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM entries \
             WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id ASC"
        );
        query_entries(&connection, &sql, "回收站列表")
    }

    pub fn create_entry(&self, input: EntryInput) -> Result<MediaEntry, String> {
        let input = input.validate()?;
        let now = timestamp();
        let entry = MediaEntry {
            id: Uuid::new_v4().to_string(),
            title: input.title,
            media_type: input.media_type,
            current_progress: input.current_progress,
            total_progress: input.total_progress,
            status: input.status,
            season: input.season,
            rating: input.rating,
            platform: input.platform,
            cover_url: input.cover_url,
            overview: input.overview,
            created_at: now.clone(),
            updated_at: now,
        };

        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动创建条目事务：{error}"))?;
        insert_entry(&transaction, &entry).map_err(|error| format!("创建追更条目失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成创建条目：{error}"))?;

        Ok(entry)
    }

    pub fn import_excel(
        &self,
        base64_data: &str,
        default_media_type: Option<MediaType>,
    ) -> Result<ImportReport, String> {
        let bytes = crate::excel::decode_base64(base64_data)?;
        let default_media_type = default_media_type.unwrap_or(MediaType::Drama);
        let rows = crate::excel::parse_workbook(&bytes, default_media_type)?;

        let mut candidates = Vec::new();
        let mut errors = Vec::new();
        let mut skipped = 0u32;
        for (line_number, parsed) in rows {
            match parsed.and_then(|input| input.validate()) {
                Ok(validated) => candidates.push((line_number, validated)),
                Err(error) => {
                    skipped += 1;
                    errors.push(format!("第 {line_number} 行：{error}"));
                }
            }
        }

        self.insert_imported(candidates, skipped, errors)
    }

    fn insert_imported(
        &self,
        candidates: Vec<(usize, ValidatedInput)>,
        initial_skipped: u32,
        initial_errors: Vec<String>,
    ) -> Result<ImportReport, String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动导入事务：{error}"))?;
        let mut entries = Vec::new();
        let mut seen = HashSet::new();
        let mut skipped = initial_skipped;
        let mut errors = initial_errors;

        for (line_number, input) in candidates {
            let key = (
                input.title.clone(),
                input.media_type.as_str().to_owned(),
                input.season,
            );
            if !seen.insert(key) {
                skipped += 1;
                errors.push(format!(
                    "第 {line_number} 行：本批次已有相同标题、类型与季的条目，已跳过"
                ));
                continue;
            }
            if entry_exists(&transaction, &input.title, input.media_type, input.season)
                .map_err(|error| format!("检查重复条目失败：{error}"))?
            {
                skipped += 1;
                errors.push(format!(
                    "第 {line_number} 行：已存在同名、同类型与季的条目，已跳过"
                ));
                continue;
            }

            let now = timestamp();
            let entry = MediaEntry {
                id: Uuid::new_v4().to_string(),
                title: input.title,
                media_type: input.media_type,
                current_progress: input.current_progress,
                total_progress: input.total_progress,
                status: input.status,
                season: input.season,
                rating: input.rating,
                platform: input.platform,
                cover_url: input.cover_url,
                overview: input.overview,
                created_at: now.clone(),
                updated_at: now,
            };
            insert_entry(&transaction, &entry)
                .map_err(|error| format!("导入第 {line_number} 行失败：{error}"))?;
            entries.push(entry);
        }

        transaction
            .commit()
            .map_err(|error| format!("无法完成导入：{error}"))?;

        Ok(ImportReport {
            imported: entries.len() as u32,
            skipped,
            errors,
            entries,
        })
    }

    pub fn update_entry(&self, id: &str, input: EntryInput) -> Result<MediaEntry, String> {
        let input = input.validate()?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动更新条目事务：{error}"))?;
        let affected = transaction
            .execute(
                "
                UPDATE entries
                SET title = ?2, media_type = ?3, current_progress = ?4,
                    total_progress = ?5, status = ?6, season = ?7, rating = ?8,
                    platform = ?9, cover_url = ?10, overview = ?11, updated_at = ?12
                WHERE id = ?1 AND deleted_at IS NULL
                ",
                params![
                    id,
                    input.title,
                    input.media_type.as_str(),
                    input.current_progress,
                    input.total_progress,
                    input.status.as_str(),
                    input.season,
                    input.rating,
                    input.platform,
                    input.cover_url,
                    input.overview,
                    timestamp(),
                ],
            )
            .map_err(|error| format!("更新追更条目失败：{error}"))?;
        if affected == 0 {
            return Err(format!("要更新的条目不存在（ID：{id}）"));
        }

        let updated = find_entry(&transaction, id)
            .map_err(|error| format!("读取更新后的条目失败：{error}"))?
            .ok_or_else(|| format!("要更新的条目不存在（ID：{id}）"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成更新条目：{error}"))?;
        Ok(updated)
    }

    pub fn delete_entry(&self, id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动删除条目事务：{error}"))?;
        let now = timestamp();
        let affected = transaction
            .execute(
                "
                UPDATE entries SET deleted_at = ?2, updated_at = ?2
                WHERE id = ?1 AND deleted_at IS NULL
                ",
                params![id, now],
            )
            .map_err(|error| format!("删除追更条目失败：{error}"))?;
        if affected == 0 {
            return Err(format!("要删除的条目不存在（ID：{id}）"));
        }
        transaction
            .commit()
            .map_err(|error| format!("无法完成删除条目：{error}"))
    }

    pub fn restore_entry(&self, id: &str) -> Result<MediaEntry, String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动恢复条目事务：{error}"))?;
        let affected = transaction
            .execute(
                "
                UPDATE entries SET deleted_at = NULL, updated_at = ?2
                WHERE id = ?1 AND deleted_at IS NOT NULL
                ",
                params![id, timestamp()],
            )
            .map_err(|error| format!("恢复追更条目失败：{error}"))?;
        if affected == 0 {
            return Err(format!("要恢复的条目不存在（ID：{id}）"));
        }

        let restored = find_entry(&transaction, id)
            .map_err(|error| format!("读取恢复后的条目失败：{error}"))?
            .ok_or_else(|| format!("要恢复的条目不存在（ID：{id}）"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成恢复条目：{error}"))?;
        Ok(restored)
    }

    pub fn purge_entry(&self, id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动彻底删除事务：{error}"))?;
        let updated_at = transaction
            .query_row(
                "SELECT updated_at FROM entries WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("读取待彻底删除条目失败：{error}"))?
            .ok_or_else(|| format!("要彻底删除的条目不存在（ID：{id}）"))?;
        let purged_at = later_timestamp(timestamp(), updated_at);
        transaction
            .execute("DELETE FROM entries WHERE id = ?1", params![id])
            .map_err(|error| format!("彻底删除追更条目失败：{error}"))?;
        transaction
            .execute(
                "
                INSERT INTO purged_entries (id, purged_at) VALUES (?1, ?2)
                ON CONFLICT(id) DO UPDATE SET purged_at = CASE
                    WHEN excluded.purged_at > purged_entries.purged_at
                    THEN excluded.purged_at ELSE purged_entries.purged_at END
                ",
                params![id, purged_at],
            )
            .map_err(|error| format!("记录彻底删除信息失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成彻底删除：{error}"))
    }

    pub fn empty_trash(&self) -> Result<(), String> {
        let now = timestamp();
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动清空回收站事务：{error}"))?;
        transaction
            .execute(
                "
                INSERT INTO purged_entries (id, purged_at)
                SELECT id, CASE WHEN ?1 > updated_at THEN ?1 ELSE updated_at END
                FROM entries WHERE deleted_at IS NOT NULL
                ON CONFLICT(id) DO UPDATE SET purged_at = CASE
                    WHEN excluded.purged_at > purged_entries.purged_at
                    THEN excluded.purged_at ELSE purged_entries.purged_at END
                ",
                params![now],
            )
            .map_err(|error| format!("记录清空回收站信息失败：{error}"))?;
        transaction
            .execute("DELETE FROM entries WHERE deleted_at IS NOT NULL", [])
            .map_err(|error| format!("清空回收站失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成清空回收站：{error}"))
    }

    pub fn adjust_progress(&self, id: &str, delta: i32) -> Result<MediaEntry, String> {
        if delta != 1 && delta != -1 {
            return Err("进度增量只能是 +1 或 -1".to_owned());
        }

        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动进度更新事务：{error}"))?;
        let current = find_entry(&transaction, id)
            .map_err(|error| format!("读取当前进度失败：{error}"))?
            .ok_or_else(|| format!("要调整进度的条目不存在（ID：{id}）"))?;

        let next_progress = current
            .current_progress
            .checked_add(i64::from(delta))
            .ok_or_else(|| "当前进度已达到支持的上限".to_owned())?;
        if next_progress < 0 {
            return Err("当前进度已经为 0，不能继续减少".to_owned());
        }
        if current
            .total_progress
            .is_some_and(|total| next_progress > total)
        {
            return Err("当前进度已达到总进度，不能继续增加".to_owned());
        }

        let next_status = if current.status == EntryStatus::Dropped {
            EntryStatus::Dropped
        } else if delta < 0 {
            EntryStatus::Tracking
        } else if current.total_progress == Some(next_progress) {
            EntryStatus::Completed
        } else {
            EntryStatus::Tracking
        };
        let affected = transaction
            .execute(
                "
                UPDATE entries
                SET current_progress = current_progress + ?2, status = ?3, updated_at = ?4
                WHERE id = ?1 AND current_progress = ?5 AND deleted_at IS NULL
                ",
                params![
                    id,
                    delta,
                    next_status.as_str(),
                    timestamp(),
                    current.current_progress,
                ],
            )
            .map_err(|error| format!("调整进度失败：{error}"))?;
        if affected != 1 {
            return Err("进度已被其他操作修改，请重试".to_owned());
        }

        let updated = find_entry(&transaction, id)
            .map_err(|error| format!("读取调整后的进度失败：{error}"))?
            .ok_or_else(|| format!("要调整进度的条目不存在（ID：{id}）"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交进度更新失败：{error}"))?;
        Ok(updated)
    }

    pub fn set_entry_status(&self, id: &str, status: EntryStatus) -> Result<MediaEntry, String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动状态更新事务：{error}"))?;
        let affected = transaction
            .execute(
                "
                UPDATE entries SET status = ?2, updated_at = ?3
                WHERE id = ?1 AND deleted_at IS NULL
                ",
                params![id, status.as_str(), timestamp()],
            )
            .map_err(|error| format!("更新追更状态失败：{error}"))?;
        if affected == 0 {
            return Err(format!("要更新状态的条目不存在（ID：{id}）"));
        }

        let updated = find_entry(&transaction, id)
            .map_err(|error| format!("读取更新后的状态失败：{error}"))?
            .ok_or_else(|| format!("要更新状态的条目不存在（ID：{id}）"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成状态更新：{error}"))?;
        Ok(updated)
    }

    pub(crate) fn read_sync_state(&self) -> Result<(Vec<SyncEntry>, Vec<PurgedEntry>), String> {
        let connection = self.lock()?;
        let sql = format!(
            "SELECT {ENTRY_COLUMNS}, deleted_at FROM entries ORDER BY updated_at DESC, id ASC"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("无法准备同步数据查询：{error}"))?;
        let entries = statement
            .query_map([], sync_entry_from_row)
            .map_err(|error| format!("无法查询同步数据：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取同步数据：{error}"))?;

        let mut purged_statement = connection
            .prepare("SELECT id, purged_at FROM purged_entries ORDER BY id ASC")
            .map_err(|error| format!("无法准备彻底删除记录查询：{error}"))?;
        let purged = purged_statement
            .query_map([], |row| {
                Ok(PurgedEntry {
                    id: row.get(0)?,
                    purged_at: row.get(1)?,
                })
            })
            .map_err(|error| format!("无法查询彻底删除记录：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取彻底删除记录：{error}"))?;

        Ok((entries, purged))
    }

    /// 在单个事务中写入合并结果：先删除墓碑对应的条目，再 upsert 合并条目，
    /// 最后保留最新的墓碑时间。
    pub(crate) fn apply_sync_merge(
        &self,
        entries: &[SyncEntry],
        purged: &[PurgedEntry],
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动同步写入事务：{error}"))?;

        for record in purged {
            transaction
                .execute("DELETE FROM entries WHERE id = ?1", params![record.id])
                .map_err(|error| format!("同步删除条目失败：{error}"))?;
        }
        for entry in entries {
            upsert_sync_entry(&transaction, entry)
                .map_err(|error| format!("同步写入条目失败：{error}"))?;
        }
        for record in purged {
            transaction
                .execute(
                    "
                    INSERT INTO purged_entries (id, purged_at) VALUES (?1, ?2)
                    ON CONFLICT(id) DO UPDATE SET purged_at = CASE
                        WHEN excluded.purged_at > purged_entries.purged_at
                        THEN excluded.purged_at ELSE purged_entries.purged_at END
                    ",
                    params![record.id, record.purged_at],
                )
                .map_err(|error| format!("同步写入彻底删除记录失败：{error}"))?;
        }

        transaction
            .commit()
            .map_err(|error| format!("无法完成同步写入：{error}"))
    }

    pub(crate) fn set_last_synced_at(&self, value: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动同步时间写入事务：{error}"))?;
        transaction
            .execute(
                "
                INSERT INTO settings (key, value) VALUES ('last_synced_at', ?1)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                ",
                params![value],
            )
            .map_err(|error| format!("保存同步时间失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成同步时间保存：{error}"))
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT key, value FROM settings")
            .map_err(|error| format!("无法准备设置查询：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("无法查询设置：{error}"))?;

        let mut values = HashMap::new();
        for row in rows {
            let (key, value) = row.map_err(|error| format!("无法读取设置：{error}"))?;
            values.insert(key, value);
        }

        let text = |key: &str| values.get(key).cloned().unwrap_or_default();
        Ok(AppSettings {
            tmdb_api_key: text("tmdb_api_key"),
            webdav_url: text("webdav_url"),
            webdav_username: text("webdav_username"),
            webdav_password: text("webdav_password"),
            webdav_enabled: values
                .get("webdav_enabled")
                .is_some_and(|value| value == "true"),
            last_synced_at: values
                .get("last_synced_at")
                .filter(|value| !value.trim().is_empty())
                .cloned(),
            theme: normalize_theme(&text("theme")),
            library_view: normalize_library_view(&text("library_view")),
        })
    }

    pub fn save_settings(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let settings = settings.validate()?;
        let webdav_enabled = if settings.webdav_enabled {
            "true"
        } else {
            "false"
        };
        let last_synced_at = settings.last_synced_at.as_deref().unwrap_or("");
        let entries = [
            ("tmdb_api_key", settings.tmdb_api_key.as_str()),
            ("webdav_url", settings.webdav_url.as_str()),
            ("webdav_username", settings.webdav_username.as_str()),
            ("webdav_password", settings.webdav_password.as_str()),
            ("webdav_enabled", webdav_enabled),
            ("last_synced_at", last_synced_at),
            ("theme", settings.theme.as_str()),
            ("library_view", settings.library_view.as_str()),
        ];

        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法启动保存设置事务：{error}"))?;
        for (key, value) in entries {
            transaction
                .execute(
                    "
                    INSERT INTO settings (key, value) VALUES (?1, ?2)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    ",
                    params![key, value],
                )
                .map_err(|error| format!("保存设置失败：{error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("无法完成设置保存：{error}"))?;

        Ok(settings)
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true)
}

fn later_timestamp(first: String, second: String) -> String {
    if first >= second {
        first
    } else {
        second
    }
}

fn insert_entry(connection: &Connection, entry: &MediaEntry) -> rusqlite::Result<()> {
    connection.execute(
        "
        INSERT INTO entries (
            id, title, media_type, current_progress, total_progress, status,
            season, rating, platform, cover_url, overview, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ",
        params![
            &entry.id,
            &entry.title,
            entry.media_type.as_str(),
            entry.current_progress,
            entry.total_progress,
            entry.status.as_str(),
            entry.season,
            entry.rating,
            &entry.platform,
            &entry.cover_url,
            &entry.overview,
            &entry.created_at,
            &entry.updated_at,
        ],
    )?;
    Ok(())
}

fn entry_exists(
    connection: &Connection,
    title: &str,
    media_type: MediaType,
    season: Option<u32>,
) -> rusqlite::Result<bool> {
    connection.query_row(
        "
        SELECT EXISTS(
            SELECT 1 FROM entries
            WHERE deleted_at IS NULL AND title = ?1 AND media_type = ?2 AND season IS ?3
        )
        ",
        params![title, media_type.as_str(), season],
        |row| row.get(0),
    )
}

fn table_exists(connection: &Connection, name: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![name],
        |row| row.get(0),
    )
}

fn table_columns(connection: &Connection, name: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({name})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

fn entries_status_allows_to_watch(connection: &Connection) -> rusqlite::Result<bool> {
    let definition: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(definition.is_some_and(|text| text.contains("'to_watch'")))
}

fn query_entries(
    connection: &Connection,
    sql: &str,
    label: &str,
) -> Result<Vec<MediaEntry>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("无法准备{label}查询：{error}"))?;
    let rows = statement
        .query_map([], entry_from_row)
        .map_err(|error| format!("无法查询{label}：{error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取{label}：{error}"))
}

fn find_entry(connection: &Connection, id: &str) -> rusqlite::Result<Option<MediaEntry>> {
    let sql = format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id = ?1 AND deleted_at IS NULL");
    connection
        .query_row(&sql, params![id], entry_from_row)
        .optional()
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<MediaEntry> {
    let media_type = row.get::<_, String>(2)?;
    let status = row.get::<_, String>(5)?;
    Ok(MediaEntry {
        id: row.get(0)?,
        title: row.get(1)?,
        media_type: MediaType::parse(&media_type).map_err(|error| invalid_text_column(2, error))?,
        current_progress: row.get(3)?,
        total_progress: row.get(4)?,
        status: EntryStatus::parse(&status).map_err(|error| invalid_text_column(5, error))?,
        season: row.get(6)?,
        rating: row.get(7)?,
        platform: row.get(8)?,
        cover_url: row.get(9)?,
        overview: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn sync_entry_from_row(row: &Row<'_>) -> rusqlite::Result<SyncEntry> {
    let media_type = row.get::<_, String>(2)?;
    let status = row.get::<_, String>(5)?;
    Ok(SyncEntry {
        id: row.get(0)?,
        title: row.get(1)?,
        media_type: MediaType::parse(&media_type).map_err(|error| invalid_text_column(2, error))?,
        current_progress: row.get(3)?,
        total_progress: row.get(4)?,
        status: EntryStatus::parse(&status).map_err(|error| invalid_text_column(5, error))?,
        season: row.get(6)?,
        rating: row.get(7)?,
        platform: row.get(8)?,
        cover_url: row.get(9)?,
        overview: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        deleted_at: row.get(13)?,
    })
}

fn upsert_sync_entry(connection: &Connection, entry: &SyncEntry) -> rusqlite::Result<()> {
    connection.execute(
        "
        INSERT INTO entries (
            id, title, media_type, current_progress, total_progress, status,
            season, rating, platform, cover_url, overview, created_at, updated_at, deleted_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            media_type = excluded.media_type,
            current_progress = excluded.current_progress,
            total_progress = excluded.total_progress,
            status = excluded.status,
            season = excluded.season,
            rating = excluded.rating,
            platform = excluded.platform,
            cover_url = excluded.cover_url,
            overview = excluded.overview,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
        ",
        params![
            &entry.id,
            &entry.title,
            entry.media_type.as_str(),
            entry.current_progress,
            entry.total_progress,
            entry.status.as_str(),
            entry.season,
            entry.rating,
            &entry.platform,
            &entry.cover_url,
            &entry.overview,
            &entry.created_at,
            &entry.updated_at,
            &entry.deleted_at,
        ],
    )?;
    Ok(())
}

fn invalid_text_column(column: usize, error: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        std::io::Error::new(std::io::ErrorKind::InvalidData, error).into(),
    )
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, thread};

    use chrono::DateTime;
    use serde_json::{json, Value};
    use tempfile::{tempdir, TempDir};

    use super::*;

    fn test_database() -> (TempDir, Database) {
        let directory = tempdir().expect("create temporary directory");
        let path = directory.path().join("nested").join("catchup.sqlite3");
        let database = Database::open(path).expect("open test database");
        (directory, database)
    }

    fn input(title: &str) -> EntryInput {
        EntryInput {
            title: title.to_owned(),
            media_type: MediaType::Drama,
            current_progress: 0,
            total_progress: Some(10),
            status: EntryStatus::Tracking,
            season: None,
            rating: None,
            platform: None,
            cover_url: None,
            overview: None,
        }
    }

    fn assert_error<T>(result: Result<T, String>, expected: &str) {
        match result {
            Ok(_) => panic!("expected an error containing {expected}"),
            Err(error) => assert!(
                error.contains(expected),
                "expected error containing {expected:?}, got {error:?}"
            ),
        }
    }

    #[test]
    fn crud_trims_title_and_reports_missing_ids() {
        let (_directory, database) = test_database();
        let created = database.create_entry(input("  漫长的季节  ")).unwrap();
        assert_eq!(created.title, "漫长的季节");
        assert_eq!(created.current_progress, 0);
        assert_eq!(created.status, EntryStatus::Tracking);
        assert!(Uuid::parse_str(&created.id).is_ok());

        let updated = database
            .update_entry(
                &created.id,
                EntryInput {
                    title: "  重启人生  ".to_owned(),
                    media_type: MediaType::Anime,
                    current_progress: 3,
                    total_progress: Some(12),
                    status: EntryStatus::Completed,
                    season: None,
                    rating: None,
                    platform: None,
                    cover_url: None,
                    overview: None,
                },
            )
            .unwrap();
        assert_eq!(updated.title, "重启人生");
        assert_eq!(updated.media_type, MediaType::Anime);
        assert_eq!(updated.current_progress, 3);
        assert_eq!(updated.total_progress, Some(12));
        assert_eq!(updated.status, EntryStatus::Completed);
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.updated_at >= created.updated_at);
        assert_eq!(database.list_entries().unwrap(), vec![updated]);

        database.delete_entry(&created.id).unwrap();
        assert!(database.list_entries().unwrap().is_empty());
        assert_error(database.delete_entry(&created.id), "要删除的条目不存在");
        assert_error(
            database.update_entry(&created.id, input("不存在")),
            "要更新的条目不存在",
        );
        assert_error(
            database.adjust_progress(&created.id, 1),
            "要调整进度的条目不存在",
        );
        assert_error(
            database.set_entry_status(&created.id, EntryStatus::Completed),
            "要更新状态的条目不存在",
        );
    }

    #[test]
    fn rejects_blank_titles_and_invalid_progress() {
        let (_directory, database) = test_database();
        assert_error(database.create_entry(input(" \n\t ")), "标题不能为空");
        assert_error(
            database.create_entry(EntryInput {
                current_progress: -1,
                ..input("负数进度")
            }),
            "当前进度不能为负数",
        );
        assert_error(
            database.create_entry(EntryInput {
                total_progress: Some(0),
                ..input("零总进度")
            }),
            "总进度必须为空或正整数",
        );
        assert_error(
            database.create_entry(EntryInput {
                total_progress: Some(-2),
                ..input("负总进度")
            }),
            "总进度必须为空或正整数",
        );
        assert_error(
            database.create_entry(EntryInput {
                current_progress: 11,
                total_progress: Some(10),
                ..input("超过总进度")
            }),
            "当前进度不能超过总进度",
        );
        assert!(database.list_entries().unwrap().is_empty());

        let entry = database.create_entry(input("合法条目")).unwrap();
        assert_error(
            database.update_entry(&entry.id, input("   ")),
            "标题不能为空",
        );
        assert_error(
            database.update_entry(
                &entry.id,
                EntryInput {
                    current_progress: 20,
                    ..input("非法更新")
                },
            ),
            "当前进度不能超过总进度",
        );
        let stored = database.list_entries().unwrap().remove(0);
        assert_eq!(stored.title, "合法条目");
        assert_eq!(stored.current_progress, 0);
    }

    #[test]
    fn serializes_camel_case_contract_and_all_media_types() {
        let (_directory, database) = test_database();
        let cases = [
            (MediaType::Drama, "drama"),
            (MediaType::Anime, "anime"),
            (MediaType::Variety, "variety"),
            (MediaType::Novel, "novel"),
            (MediaType::Movie, "movie"),
            (MediaType::ShortDrama, "short_drama"),
        ];

        for (media_type, expected) in cases {
            let entry = database
                .create_entry(EntryInput {
                    media_type,
                    total_progress: None,
                    ..input(expected)
                })
                .unwrap();
            let value = serde_json::to_value(&entry).unwrap();
            assert_eq!(value["mediaType"], Value::String(expected.to_owned()));
            assert_eq!(value["currentProgress"], json!(0));
            assert_eq!(value["totalProgress"], Value::Null);
            assert_eq!(value["status"], json!("tracking"));
            assert_eq!(value["season"], Value::Null);
            assert_eq!(value["rating"], Value::Null);
            assert_eq!(value["platform"], Value::Null);
            assert_eq!(value["coverUrl"], Value::Null);
            assert_eq!(value["overview"], Value::Null);
            assert!(value.get("media_type").is_none());
            assert!(value.get("current_progress").is_none());
            assert!(value.get("total_progress").is_none());
            assert!(value.get("created_at").is_none());
            assert!(value.get("updated_at").is_none());
            assert!(value.get("cover_url").is_none());
            DateTime::parse_from_rfc3339(value["createdAt"].as_str().unwrap()).unwrap();
            DateTime::parse_from_rfc3339(value["updatedAt"].as_str().unwrap()).unwrap();
            assert_eq!(entry.created_at.len(), 30, "nanosecond RFC3339 timestamp");
        }

        let decoded: EntryInput = serde_json::from_value(json!({
            "title": "契约",
            "mediaType": "variety",
            "currentProgress": 2,
            "totalProgress": 8,
            "status": "completed"
        }))
        .unwrap();
        assert_eq!(decoded.media_type, MediaType::Variety);
        assert_eq!(decoded.current_progress, 2);
        assert_eq!(decoded.total_progress, Some(8));
        assert_eq!(decoded.status, EntryStatus::Completed);
        assert_eq!(decoded.season, None);
        assert_eq!(decoded.rating, None);
        assert_eq!(decoded.platform, None);
        assert_eq!(decoded.cover_url, None);
        assert_eq!(decoded.overview, None);
        assert_eq!(database.list_entries().unwrap().len(), 6);
    }

    #[test]
    fn short_drama_serializes_and_uses_episode_unit() {
        assert_eq!(MediaType::ShortDrama.unit(), "集");
        assert_eq!(MediaType::Drama.unit(), "集");
        assert_eq!(MediaType::Anime.unit(), "集");
        assert_eq!(MediaType::Variety.unit(), "集");
        assert_eq!(MediaType::Movie.unit(), "集");
        assert_eq!(MediaType::Novel.unit(), "章");
        assert_eq!(
            serde_json::to_value(MediaType::ShortDrama).unwrap(),
            Value::String("short_drama".to_owned())
        );

        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                media_type: MediaType::ShortDrama,
                current_progress: 3,
                total_progress: Some(20),
                ..input("短剧")
            })
            .unwrap();
        assert_eq!(entry.media_type.unit(), "集");
        assert_eq!(
            serde_json::to_value(&entry).unwrap()["mediaType"],
            json!("short_drama")
        );
    }

    #[test]
    fn rejects_fractional_progress_at_the_type_boundary() {
        let with_fractional_current = json!({
            "title": "小数",
            "mediaType": "drama",
            "currentProgress": 1.5,
            "totalProgress": 10,
            "status": "tracking"
        });
        assert!(serde_json::from_value::<EntryInput>(with_fractional_current).is_err());

        let with_fractional_total = json!({
            "title": "小数",
            "mediaType": "drama",
            "currentProgress": 1,
            "totalProgress": 10.5,
            "status": "tracking"
        });
        assert!(serde_json::from_value::<EntryInput>(with_fractional_total).is_err());
        assert!(serde_json::from_value::<i32>(json!(1.5)).is_err());
        assert!(serde_json::from_value::<i32>(json!(-1.5)).is_err());
    }

    #[test]
    fn create_and_update_enforce_completion_rules() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                current_progress: 10,
                ..input("自动完成")
            })
            .unwrap();
        assert_eq!(entry.status, EntryStatus::Completed);

        let manually_completed = database
            .update_entry(
                &entry.id,
                EntryInput {
                    current_progress: 4,
                    status: EntryStatus::Completed,
                    ..input("手动完成")
                },
            )
            .unwrap();
        assert_eq!(manually_completed.current_progress, 4);
        assert_eq!(manually_completed.status, EntryStatus::Completed);

        let reached_total = database
            .update_entry(
                &entry.id,
                EntryInput {
                    current_progress: 10,
                    status: EntryStatus::Tracking,
                    ..input("再次达到总进度")
                },
            )
            .unwrap();
        assert_eq!(reached_total.status, EntryStatus::Completed);

        let unknown_total = database
            .create_entry(EntryInput {
                total_progress: None,
                status: EntryStatus::Completed,
                ..input("未知总进度")
            })
            .unwrap();
        assert_eq!(unknown_total.status, EntryStatus::Completed);
        assert_eq!(unknown_total.current_progress, 0);
    }

    #[test]
    fn manual_status_changes_preserve_progress_and_created_at() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                current_progress: 10,
                ..input("重新追更")
            })
            .unwrap();
        assert_eq!(entry.status, EntryStatus::Completed);

        let tracking = database
            .set_entry_status(&entry.id, EntryStatus::Tracking)
            .unwrap();
        assert_eq!(tracking.status, EntryStatus::Tracking);
        assert_eq!(tracking.current_progress, 10);
        assert_eq!(tracking.total_progress, Some(10));
        assert_eq!(tracking.created_at, entry.created_at);

        let completed = database
            .set_entry_status(&entry.id, EntryStatus::Completed)
            .unwrap();
        assert_eq!(completed.status, EntryStatus::Completed);
        assert_eq!(completed.current_progress, 10);
        assert_eq!(completed.total_progress, Some(10));
        assert_eq!(completed.created_at, entry.created_at);
    }

    #[test]
    fn increment_updates_status_and_enforces_the_upper_limit() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                total_progress: Some(2),
                ..input("递增")
            })
            .unwrap();

        let first = database.adjust_progress(&entry.id, 1).unwrap();
        assert_eq!(first.current_progress, 1);
        assert_eq!(first.status, EntryStatus::Tracking);
        let second = database.adjust_progress(&entry.id, 1).unwrap();
        assert_eq!(second.current_progress, 2);
        assert_eq!(second.status, EntryStatus::Completed);
        assert_error(database.adjust_progress(&entry.id, 1), "不能继续增加");
        assert_eq!(
            database
                .adjust_progress(&entry.id, -1)
                .unwrap()
                .current_progress,
            1
        );

        let manually_completed = database
            .create_entry(EntryInput {
                total_progress: Some(3),
                status: EntryStatus::Completed,
                ..input("完成后递增")
            })
            .unwrap();
        let tracking = database.adjust_progress(&manually_completed.id, 1).unwrap();
        assert_eq!(tracking.current_progress, 1);
        assert_eq!(tracking.status, EntryStatus::Tracking);
    }

    #[test]
    fn decrement_retracks_and_enforces_zero() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                current_progress: 1,
                total_progress: Some(3),
                status: EntryStatus::Completed,
                ..input("递减")
            })
            .unwrap();

        let decremented = database.adjust_progress(&entry.id, -1).unwrap();
        assert_eq!(decremented.current_progress, 0);
        assert_eq!(decremented.status, EntryStatus::Tracking);
        assert_error(database.adjust_progress(&entry.id, -1), "已经为 0");
        assert_eq!(database.list_entries().unwrap()[0].current_progress, 0);
    }

    #[test]
    fn unknown_total_allows_rapid_increments_and_manual_completion() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                total_progress: None,
                ..input("无限进度")
            })
            .unwrap();

        for expected in 1..=100 {
            let updated = database.adjust_progress(&entry.id, 1).unwrap();
            assert_eq!(updated.current_progress, expected);
        }
        let completed = database
            .set_entry_status(&entry.id, EntryStatus::Completed)
            .unwrap();
        assert_eq!(completed.current_progress, 100);
        assert_eq!(completed.status, EntryStatus::Completed);

        let tracking = database.adjust_progress(&entry.id, 1).unwrap();
        assert_eq!(tracking.current_progress, 101);
        assert_eq!(tracking.status, EntryStatus::Tracking);
        assert_eq!(tracking.total_progress, None);
    }

    #[test]
    fn adjust_progress_rejects_non_unit_deltas_without_changes() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                total_progress: None,
                ..input("非法增量")
            })
            .unwrap();

        for delta in [0, 2, -2, i32::MAX, i32::MIN] {
            assert_error(
                database.adjust_progress(&entry.id, delta),
                "增量只能是 +1 或 -1",
            );
        }
        let stored = database.list_entries().unwrap().remove(0);
        assert_eq!(stored.current_progress, 0);
        assert_eq!(stored.updated_at, entry.updated_at);
    }

    #[test]
    fn database_reopens_with_persisted_entries() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        let created = {
            let database = Database::open(&path).unwrap();
            let entry = database.create_entry(input("持久化")).unwrap();
            database.adjust_progress(&entry.id, 1).unwrap()
        };

        let reopened = Database::open(&path).unwrap();
        let entries = reopened.list_entries().unwrap();
        assert_eq!(entries, vec![created.clone()]);
        assert_eq!(entries[0].current_progress, 1);
        assert_eq!(entries[0].created_at, created.created_at);
    }

    #[test]
    fn migrations_are_idempotent_and_preserve_data() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        let database = Database::open(&path).unwrap();
        let entry = database.create_entry(input("迁移")).unwrap();
        database.migrate().unwrap();
        database.migrate().unwrap();

        let version: u32 = database
            .lock()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_VERSION);
        assert_eq!(database.list_entries().unwrap(), vec![entry.clone()]);
        drop(database);

        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.list_entries().unwrap(), vec![entry]);
    }

    #[test]
    fn purge_tombstones_survive_reopen_and_migration_is_idempotent() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        let purged_id = {
            let database = Database::open(&path).unwrap();
            let entry = database.create_entry(input("彻底删除并记录")).unwrap();
            database.delete_entry(&entry.id).unwrap();
            database.purge_entry(&entry.id).unwrap();
            database.migrate().unwrap();
            database.migrate().unwrap();

            let version: u32 = database
                .lock()
                .unwrap()
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, DATABASE_VERSION);
            let has_table: bool = database
                .lock()
                .unwrap()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'purged_entries')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(has_table);
            let (_, purged) = database.read_sync_state().unwrap();
            assert_eq!(purged.len(), 1);
            assert_eq!(purged[0].id, entry.id);
            entry.id
        };

        let reopened = Database::open(&path).unwrap();
        let (entries, purged) = reopened.read_sync_state().unwrap();
        assert!(entries.is_empty());
        assert_eq!(purged.len(), 1);
        assert_eq!(purged[0].id, purged_id);
        assert!(!purged[0].purged_at.is_empty());
    }

    #[test]
    fn empty_trash_records_a_tombstone_for_each_removed_entry() {
        let (_directory, database) = test_database();
        let first = database.create_entry(input("清空一")).unwrap();
        let second = database.create_entry(input("清空二")).unwrap();
        database.delete_entry(&first.id).unwrap();
        database.delete_entry(&second.id).unwrap();

        database.empty_trash().unwrap();

        let (_, purged) = database.read_sync_state().unwrap();
        let mut ids = purged
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>();
        ids.sort_unstable();
        let mut expected = vec![first.id.as_str(), second.id.as_str()];
        expected.sort_unstable();
        assert_eq!(ids, expected);
    }

    #[test]
    fn concurrent_increments_are_atomic_and_not_lost() {
        let (_directory, database) = test_database();
        let database = Arc::new(database);
        let entry = database
            .create_entry(EntryInput {
                total_progress: None,
                ..input("并发")
            })
            .unwrap();
        let mut handles = Vec::new();

        for _ in 0..8 {
            let database = Arc::clone(&database);
            let id = entry.id.clone();
            handles.push(thread::spawn(move || {
                (0..25)
                    .map(|_| database.adjust_progress(&id, 1).unwrap().current_progress)
                    .collect::<Vec<_>>()
            }));
        }

        let mut observed = handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        observed.sort_unstable();
        assert_eq!(observed, (1..=200).collect::<Vec<_>>());
        assert_eq!(database.list_entries().unwrap()[0].current_progress, 200);
    }

    #[test]
    fn list_orders_by_updated_at_then_id() {
        let (_directory, database) = test_database();
        let first = database.create_entry(input("第一")).unwrap();
        let second = database.create_entry(input("第二")).unwrap();
        let third = database.create_entry(input("第三")).unwrap();

        {
            let connection = database.lock().unwrap();
            connection
                .execute(
                    "UPDATE entries SET updated_at = ?2 WHERE id = ?1",
                    params![&first.id, "2001-01-01T00:00:00.000000000Z"],
                )
                .unwrap();
            connection
                .execute(
                    "UPDATE entries SET updated_at = ?2 WHERE id = ?1",
                    params![&second.id, "2002-01-01T00:00:00.000000000Z"],
                )
                .unwrap();
            connection
                .execute(
                    "UPDATE entries SET updated_at = ?2 WHERE id = ?1",
                    params![&third.id, "2000-01-01T00:00:00.000000000Z"],
                )
                .unwrap();
        }

        let ordered_ids = database
            .list_entries()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_ids,
            vec![second.id.clone(), first.id.clone(), third.id.clone()]
        );

        let updated = database
            .set_entry_status(&third.id, EntryStatus::Completed)
            .unwrap();
        assert_eq!(database.list_entries().unwrap()[0], updated);

        {
            let connection = database.lock().unwrap();
            connection
                .execute(
                    "UPDATE entries SET updated_at = '2003-01-01T00:00:00.000000000Z'",
                    [],
                )
                .unwrap();
        }
        let mut expected_ids = vec![first.id, second.id, third.id];
        expected_ids.sort();
        let tied_ids = database
            .list_entries()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(tied_ids, expected_ids);
    }

    #[test]
    fn database_checks_reject_invalid_direct_writes() {
        let (_directory, database) = test_database();
        let entry = database.create_entry(input("数据库边界")).unwrap();
        let long_platform = "a".repeat(61);
        let invalid_statements = [
            "UPDATE entries SET title = '  ' WHERE id = ?1".to_owned(),
            "UPDATE entries SET media_type = 'book' WHERE id = ?1".to_owned(),
            "UPDATE entries SET current_progress = -1 WHERE id = ?1".to_owned(),
            "UPDATE entries SET current_progress = 1.5 WHERE id = ?1".to_owned(),
            "UPDATE entries SET total_progress = 0 WHERE id = ?1".to_owned(),
            "UPDATE entries SET total_progress = 2.5 WHERE id = ?1".to_owned(),
            "UPDATE entries SET current_progress = 11 WHERE id = ?1".to_owned(),
            "UPDATE entries SET status = 'paused' WHERE id = ?1".to_owned(),
            "UPDATE entries SET season = 0 WHERE id = ?1".to_owned(),
            "UPDATE entries SET season = 1000 WHERE id = ?1".to_owned(),
            "UPDATE entries SET rating = 10.5 WHERE id = ?1".to_owned(),
            "UPDATE entries SET rating = 8.25 WHERE id = ?1".to_owned(),
            "UPDATE entries SET cover_url = 'ftp://example.com/a.png' WHERE id = ?1".to_owned(),
            format!("UPDATE entries SET platform = '{long_platform}' WHERE id = ?1"),
        ];

        for statement in invalid_statements {
            let result = database
                .lock()
                .unwrap()
                .execute(&statement, params![&entry.id]);
            assert!(result.is_err(), "statement should fail: {statement}");
        }

        let stored = database.list_entries().unwrap().remove(0);
        assert_eq!(stored.title, entry.title);
        assert_eq!(stored.media_type, entry.media_type);
        assert_eq!(stored.current_progress, entry.current_progress);
        assert_eq!(stored.total_progress, entry.total_progress);
        assert_eq!(stored.status, entry.status);
    }

    #[test]
    fn dropped_entries_keep_status_through_progress_changes() {
        let (_directory, database) = test_database();
        assert_eq!(
            serde_json::to_value(EntryStatus::Dropped).unwrap(),
            json!("dropped")
        );
        let decoded_status: EntryStatus = serde_json::from_value(json!("dropped")).unwrap();
        assert_eq!(decoded_status, EntryStatus::Dropped);

        let entry = database
            .create_entry(EntryInput {
                current_progress: 2,
                total_progress: Some(5),
                status: EntryStatus::Dropped,
                ..input("弃剧")
            })
            .unwrap();
        assert_eq!(entry.status, EntryStatus::Dropped);

        let incremented = database.adjust_progress(&entry.id, 1).unwrap();
        assert_eq!(incremented.current_progress, 3);
        assert_eq!(incremented.status, EntryStatus::Dropped);

        let decremented = database.adjust_progress(&entry.id, -1).unwrap();
        assert_eq!(decremented.current_progress, 2);
        assert_eq!(decremented.status, EntryStatus::Dropped);

        let resumed = database
            .set_entry_status(&entry.id, EntryStatus::Tracking)
            .unwrap();
        assert_eq!(resumed.status, EntryStatus::Tracking);
        assert_eq!(resumed.current_progress, 2);

        let dropped_again = database
            .set_entry_status(&entry.id, EntryStatus::Dropped)
            .unwrap();
        assert_eq!(dropped_again.status, EntryStatus::Dropped);
        assert_eq!(dropped_again.current_progress, 2);
    }

    #[test]
    fn dropped_status_is_not_automatically_completed_at_the_limit() {
        let (_directory, database) = test_database();
        let at_total = database
            .create_entry(EntryInput {
                current_progress: 5,
                total_progress: Some(5),
                status: EntryStatus::Dropped,
                ..input("弃剧满集")
            })
            .unwrap();
        assert_eq!(at_total.status, EntryStatus::Dropped);

        let near_total = database
            .create_entry(EntryInput {
                current_progress: 4,
                total_progress: Some(5),
                status: EntryStatus::Dropped,
                ..input("弃剧将满")
            })
            .unwrap();
        let updated = database.adjust_progress(&near_total.id, 1).unwrap();
        assert_eq!(updated.current_progress, 5);
        assert_eq!(updated.status, EntryStatus::Dropped);
        assert_error(database.adjust_progress(&at_total.id, 1), "不能继续增加");
    }

    #[test]
    fn to_watch_status_persists_and_starts_tracking_on_progress() {
        let (_directory, database) = test_database();
        assert_eq!(
            serde_json::to_value(EntryStatus::ToWatch).unwrap(),
            json!("to_watch")
        );
        let decoded: EntryStatus = serde_json::from_value(json!("to_watch")).unwrap();
        assert_eq!(decoded, EntryStatus::ToWatch);

        let planned = database
            .create_entry(EntryInput {
                current_progress: 0,
                total_progress: Some(12),
                status: EntryStatus::ToWatch,
                ..input("待看新剧")
            })
            .unwrap();
        assert_eq!(planned.status, EntryStatus::ToWatch);
        assert_eq!(planned.current_progress, 0);

        // 达到总进度时，待看不会被自动标记为已完成。
        let full = database
            .create_entry(EntryInput {
                current_progress: 12,
                total_progress: Some(12),
                status: EntryStatus::ToWatch,
                ..input("待看但全集")
            })
            .unwrap();
        assert_eq!(full.status, EntryStatus::ToWatch);

        // 记录进度即代表开始追更，状态转为在追。
        let started = database.adjust_progress(&planned.id, 1).unwrap();
        assert_eq!(started.current_progress, 1);
        assert_eq!(started.status, EntryStatus::Tracking);
    }

    #[test]
    fn completed_entries_return_to_tracking_when_progress_moves() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                current_progress: 5,
                total_progress: Some(5),
                ..input("自动完成")
            })
            .unwrap();
        assert_eq!(entry.status, EntryStatus::Completed);

        let manually_completed = database
            .create_entry(EntryInput {
                current_progress: 1,
                total_progress: Some(5),
                status: EntryStatus::Completed,
                ..input("手动完成")
            })
            .unwrap();
        let incremented = database.adjust_progress(&manually_completed.id, 1).unwrap();
        assert_eq!(incremented.current_progress, 2);
        assert_eq!(incremented.status, EntryStatus::Tracking);

        let decremented = database.adjust_progress(&entry.id, -1).unwrap();
        assert_eq!(decremented.current_progress, 4);
        assert_eq!(decremented.status, EntryStatus::Tracking);
    }

    #[test]
    fn season_boundaries_are_enforced() {
        let (_directory, database) = test_database();
        for season in [1, 999] {
            let entry = database
                .create_entry(EntryInput {
                    season: Some(season),
                    total_progress: None,
                    ..input("分季")
                })
                .unwrap();
            assert_eq!(entry.season, Some(season));
        }

        assert_error(
            database.create_entry(EntryInput {
                season: Some(0),
                ..input("零季")
            }),
            "季数必须在 1 到 999 之间",
        );
        assert_error(
            database.create_entry(EntryInput {
                season: Some(1000),
                ..input("超季")
            }),
            "季数必须在 1 到 999 之间",
        );

        let negative_season = json!({
            "title": "负季",
            "mediaType": "drama",
            "currentProgress": 0,
            "totalProgress": null,
            "status": "tracking",
            "season": -1
        });
        assert!(serde_json::from_value::<EntryInput>(negative_season).is_err());
    }

    #[test]
    fn rating_is_validated_and_rounded_to_one_decimal() {
        let (_directory, database) = test_database();
        for (raw, expected) in [
            (0.0, 0.0),
            (10.0, 10.0),
            (8.26, 8.3),
            (7.24, 7.2),
            (9.99, 10.0),
        ] {
            let entry = database
                .create_entry(EntryInput {
                    rating: Some(raw),
                    total_progress: None,
                    ..input("评分")
                })
                .unwrap();
            assert_eq!(entry.rating, Some(expected), "rating {raw} should round");
        }

        for invalid in [-0.01, 10.01, f64::NAN, f64::INFINITY] {
            assert_error(
                database.create_entry(EntryInput {
                    rating: Some(invalid),
                    ..input("非法评分")
                }),
                "评分必须在 0 到 10 之间",
            );
        }
    }

    #[test]
    fn optional_fields_are_trimmed_and_validated() {
        let (_directory, database) = test_database();
        let entry = database
            .create_entry(EntryInput {
                platform: Some("  Netflix \n".to_owned()),
                cover_url: Some("  https://img.example.com/a.jpg  ".to_owned()),
                overview: Some("  一段简介  ".to_owned()),
                ..input("可选字段")
            })
            .unwrap();
        assert_eq!(entry.platform.as_deref(), Some("Netflix"));
        assert_eq!(
            entry.cover_url.as_deref(),
            Some("https://img.example.com/a.jpg")
        );
        assert_eq!(entry.overview.as_deref(), Some("一段简介"));

        let blank = database
            .create_entry(EntryInput {
                platform: Some("   ".to_owned()),
                cover_url: Some(" \n ".to_owned()),
                overview: Some("\t".to_owned()),
                ..input("空白可选字段")
            })
            .unwrap();
        assert_eq!(blank.platform, None);
        assert_eq!(blank.cover_url, None);
        assert_eq!(blank.overview, None);

        assert_error(
            database.create_entry(EntryInput {
                cover_url: Some("ftp://example.com/a.png".to_owned()),
                ..input("非法封面")
            }),
            "封面地址仅支持 http 或 https 链接",
        );
        assert_error(
            database.create_entry(EntryInput {
                cover_url: Some(format!("https://example.com/{}", "a".repeat(490))),
                ..input("超长封面")
            }),
            "封面地址不能超过 500 个字符",
        );
        assert_error(
            database.create_entry(EntryInput {
                platform: Some("a".repeat(61)),
                ..input("超长平台")
            }),
            "平台不能超过 60 个字符",
        );
        assert_error(
            database.create_entry(EntryInput {
                overview: Some("a".repeat(2001)),
                ..input("超长简介")
            }),
            "简介不能超过 2000 个字符",
        );
    }

    #[test]
    fn soft_delete_moves_entry_to_trash_and_restore_brings_it_back() {
        let (_directory, database) = test_database();
        let entry = database.create_entry(input("回收")).unwrap();

        database.delete_entry(&entry.id).unwrap();
        assert!(database.list_entries().unwrap().is_empty());
        let trash = database.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, entry.id);
        assert_eq!(trash[0].current_progress, entry.current_progress);

        let restored = database.restore_entry(&entry.id).unwrap();
        assert_eq!(restored.id, entry.id);
        assert_eq!(restored.created_at, entry.created_at);
        assert!(restored.updated_at > entry.updated_at);
        assert_eq!(database.list_entries().unwrap(), vec![restored]);
        assert!(database.list_trash().unwrap().is_empty());
        assert_error(database.restore_entry(&entry.id), "要恢复的条目不存在");
    }

    #[test]
    fn purge_entry_removes_only_trashed_entries() {
        let (_directory, database) = test_database();
        let active = database.create_entry(input("保留")).unwrap();
        let trashed = database.create_entry(input("彻底删除")).unwrap();
        database.delete_entry(&trashed.id).unwrap();

        assert_error(database.purge_entry(&active.id), "要彻底删除的条目不存在");
        database.purge_entry(&trashed.id).unwrap();
        assert!(database.list_trash().unwrap().is_empty());
        assert_eq!(database.list_entries().unwrap(), vec![active]);
        assert_error(database.purge_entry(&trashed.id), "要彻底删除的条目不存在");
    }

    #[test]
    fn empty_trash_removes_all_trashed_entries_and_keeps_active_ones() {
        let (_directory, database) = test_database();
        let active = database.create_entry(input("仍在追")).unwrap();
        let first = database.create_entry(input("第一条")).unwrap();
        let second = database.create_entry(input("第二条")).unwrap();
        database.delete_entry(&first.id).unwrap();
        database.delete_entry(&second.id).unwrap();

        database.empty_trash().unwrap();
        assert!(database.list_trash().unwrap().is_empty());
        assert_eq!(database.list_entries().unwrap(), vec![active]);
        database.empty_trash().unwrap();
    }

    #[test]
    fn trash_orders_by_deleted_at_descending() {
        let (_directory, database) = test_database();
        let first = database.create_entry(input("第一")).unwrap();
        let second = database.create_entry(input("第二")).unwrap();
        let third = database.create_entry(input("第三")).unwrap();
        for entry in [&first, &second, &third] {
            database.delete_entry(&entry.id).unwrap();
        }

        {
            let connection = database.lock().unwrap();
            connection
                .execute(
                    "UPDATE entries SET deleted_at = ?2 WHERE id = ?1",
                    params![&first.id, "2001-01-01T00:00:00.000000000Z"],
                )
                .unwrap();
            connection
                .execute(
                    "UPDATE entries SET deleted_at = ?2 WHERE id = ?1",
                    params![&second.id, "2003-01-01T00:00:00.000000000Z"],
                )
                .unwrap();
            connection
                .execute(
                    "UPDATE entries SET deleted_at = ?2 WHERE id = ?1",
                    params![&third.id, "2002-01-01T00:00:00.000000000Z"],
                )
                .unwrap();
        }

        let ordered_ids = database
            .list_trash()
            .unwrap()
            .into_iter()
            .map(|entry| entry.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ordered_ids,
            vec![second.id.clone(), third.id.clone(), first.id.clone()]
        );
    }

    #[test]
    fn expired_trash_is_purged_when_the_database_opens() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        let (old, recent) = {
            let database = Database::open(&path).unwrap();
            let old = database.create_entry(input("过期回收")).unwrap();
            let recent = database.create_entry(input("近期回收")).unwrap();
            database.delete_entry(&old.id).unwrap();
            database.delete_entry(&recent.id).unwrap();
            {
                let connection = database.lock().unwrap();
                connection
                    .execute(
                        "UPDATE entries SET deleted_at = ?2 WHERE id = ?1",
                        params![&old.id, "2000-01-01T00:00:00.000000000Z"],
                    )
                    .unwrap();
            }
            (old, recent)
        };

        let reopened = Database::open(&path).unwrap();
        let trash = reopened.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, recent.id);
        assert!(reopened.list_entries().unwrap().is_empty());
        assert_error(reopened.restore_entry(&old.id), "要恢复的条目不存在");
    }

    #[test]
    fn v1_database_upgrades_to_v2_without_losing_data() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "
                    CREATE TABLE entries (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        media_type TEXT NOT NULL,
                        current_progress INTEGER NOT NULL,
                        total_progress INTEGER,
                        status TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX entries_updated_at_id_idx
                        ON entries (updated_at DESC, id ASC);
                    PRAGMA user_version = 1;
                    ",
                )
                .unwrap();
            connection
                .execute(
                    "
                    INSERT INTO entries (
                        id, title, media_type, current_progress, total_progress, status,
                        created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    ",
                    params![
                        "v1-a",
                        "旧版条目 A",
                        "novel",
                        12,
                        Some(30),
                        "tracking",
                        "2020-01-01T00:00:00.000000000Z",
                        "2020-01-02T00:00:00.000000000Z",
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "
                    INSERT INTO entries (
                        id, title, media_type, current_progress, total_progress, status,
                        created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                    ",
                    params![
                        "v1-b",
                        "旧版条目 B",
                        "movie",
                        1,
                        Some(1),
                        "completed",
                        "2021-01-01T00:00:00.000000000Z",
                        "2021-01-02T00:00:00.000000000Z",
                    ],
                )
                .unwrap();
        }

        let database = Database::open(&path).unwrap();
        let version: u32 = database
            .lock()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_VERSION);

        let entries = database.list_entries().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "v1-b");
        assert_eq!(entries[1].id, "v1-a");

        let preserved = entries.iter().find(|entry| entry.id == "v1-a").unwrap();
        assert_eq!(preserved.title, "旧版条目 A");
        assert_eq!(preserved.media_type, MediaType::Novel);
        assert_eq!(preserved.current_progress, 12);
        assert_eq!(preserved.total_progress, Some(30));
        assert_eq!(preserved.status, EntryStatus::Tracking);
        assert_eq!(preserved.created_at, "2020-01-01T00:00:00.000000000Z");
        assert_eq!(preserved.updated_at, "2020-01-02T00:00:00.000000000Z");
        assert_eq!(preserved.season, None);
        assert_eq!(preserved.rating, None);
        assert_eq!(preserved.platform, None);
        assert_eq!(preserved.cover_url, None);
        assert_eq!(preserved.overview, None);

        let completed = entries.iter().find(|entry| entry.id == "v1-b").unwrap();
        assert_eq!(completed.status, EntryStatus::Completed);
        assert_eq!(completed.media_type, MediaType::Movie);

        let has_trash_index: bool = database
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'entries_deleted_at_idx')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_trash_index);
    }

    #[test]
    fn update_refreshes_updated_at_without_touching_created_at() {
        let (_directory, database) = test_database();
        let entry = database.create_entry(input("旧时间")).unwrap();
        {
            let connection = database.lock().unwrap();
            connection
                .execute(
                    "UPDATE entries SET updated_at = '2000-01-01T00:00:00.000000000Z' WHERE id = ?1",
                    params![&entry.id],
                )
                .unwrap();
        }

        let updated = database
            .update_entry(
                &entry.id,
                EntryInput {
                    status: EntryStatus::Completed,
                    ..input("新标题")
                },
            )
            .unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.created_at, entry.created_at);
        assert!(updated.updated_at.as_str() > "2000-01-01T00:00:00.000000000Z");
    }

    #[test]
    fn trashed_entries_reject_mutations() {
        let (_directory, database) = test_database();
        let entry = database.create_entry(input("回收后修改")).unwrap();
        database.delete_entry(&entry.id).unwrap();

        assert_error(
            database.update_entry(&entry.id, input("试图修改")),
            "要更新的条目不存在",
        );
        assert_error(
            database.adjust_progress(&entry.id, 1),
            "要调整进度的条目不存在",
        );
        assert_error(
            database.set_entry_status(&entry.id, EntryStatus::Completed),
            "要更新状态的条目不存在",
        );
        assert_eq!(database.list_trash().unwrap().len(), 1);
    }

    fn excel_base64(rows: &[&[&str]]) -> String {
        use base64::{engine::general_purpose, Engine as _};
        use rust_xlsxwriter::Workbook;

        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        for (row_index, row) in rows.iter().enumerate() {
            for (column, value) in row.iter().enumerate() {
                worksheet
                    .write_string(row_index as u32, column as u16, *value)
                    .unwrap();
            }
        }
        general_purpose::STANDARD.encode(workbook.save_to_buffer().unwrap())
    }

    #[test]
    fn import_excel_parses_header_mapped_workbook() {
        let (_directory, database) = test_database();
        let report = database
            .import_excel(
                &excel_base64(&[
                    &[
                        "标题",
                        "类型",
                        "季",
                        "当前进度",
                        "总进度",
                        "状态",
                        "平台",
                        "评分",
                        "封面",
                        "简介",
                    ],
                    &[
                        "庆余年",
                        "剧集",
                        "2",
                        "3",
                        "36",
                        "在追",
                        "腾讯视频",
                        "8.6",
                        "https://example.com/a.jpg",
                        "简介",
                    ],
                    &["待看的新剧", "", "", "", "", "待看", "", "", "", ""],
                ]),
                None,
            )
            .unwrap();

        assert_eq!(report.imported, 2);
        assert_eq!(report.skipped, 0);
        assert!(report.errors.is_empty());

        let first = &report.entries[0];
        assert_eq!(first.title, "庆余年");
        assert_eq!(first.media_type, MediaType::Drama);
        assert_eq!(first.season, Some(2));
        assert_eq!(first.current_progress, 3);
        assert_eq!(first.total_progress, Some(36));
        assert_eq!(first.status, EntryStatus::Tracking);
        assert_eq!(first.platform.as_deref(), Some("腾讯视频"));
        assert_eq!(first.rating, Some(8.6));
        assert_eq!(
            first.cover_url.as_deref(),
            Some("https://example.com/a.jpg")
        );
        assert_eq!(first.overview.as_deref(), Some("简介"));

        let second = &report.entries[1];
        assert_eq!(second.title, "待看的新剧");
        assert_eq!(second.status, EntryStatus::ToWatch);
        assert_eq!(second.current_progress, 0);
        assert_eq!(second.total_progress, None);
    }

    #[test]
    fn import_excel_parses_positional_workbook_without_header() {
        let (_directory, database) = test_database();
        let report = database
            .import_excel(
                &excel_base64(&[
                    &["漫长的季节", "剧集", "", "3/12", "腾讯视频", "9.4"],
                    &["诡秘之主", "小说", "", "第12章", "", "9.1"],
                ]),
                None,
            )
            .unwrap();
        assert_eq!(report.imported, 2);
        let drama = &report.entries[0];
        assert_eq!(drama.title, "漫长的季节");
        assert_eq!(drama.current_progress, 3);
        assert_eq!(drama.total_progress, Some(12));
        assert_eq!(drama.platform.as_deref(), Some("腾讯视频"));
        assert_eq!(drama.rating, Some(9.4));
        let novel = &report.entries[1];
        assert_eq!(novel.media_type, MediaType::Novel);
        assert_eq!(novel.current_progress, 12);
    }

    #[test]
    fn import_excel_reports_row_errors_and_keeps_valid_lines() {
        let (_directory, database) = test_database();
        let report = database
            .import_excel(
                &excel_base64(&[
                    &["标题", "评分"],
                    &["", "8.0"],
                    &["评分越界", "11"],
                    &["正常条目", "8.8"],
                ]),
                None,
            )
            .unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.skipped, 2);
        assert_eq!(report.errors.len(), 2);
        assert!(report.errors[0].contains("第 2 行：标题不能为空"));
        assert!(report.errors[1].contains("评分必须在 0 到 10 之间"));
        assert_eq!(report.entries[0].title, "正常条目");
        assert_eq!(report.entries[0].rating, Some(8.8));
    }

    #[test]
    fn import_excel_skips_duplicates() {
        let (_directory, database) = test_database();
        database
            .create_entry(EntryInput {
                season: Some(2),
                ..input("庆余年")
            })
            .unwrap();
        let report = database
            .import_excel(
                &excel_base64(&[
                    &["标题", "季"],
                    &["庆余年", "2"],
                    &["庆余年", "2"],
                    &["漫长的季节", ""],
                    &["漫长的季节", ""],
                ]),
                None,
            )
            .unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.skipped, 3);
        assert_eq!(report.errors.len(), 3);
        assert!(report.errors[0].contains("已存在同名、同类型与季的条目"));
        assert!(report.errors[1].contains("本批次已有相同标题、类型与季的条目"));
        assert!(report.errors[2].contains("本批次已有相同标题、类型与季的条目"));
        assert_eq!(database.list_entries().unwrap().len(), 2);
    }

    #[test]
    fn import_excel_uses_default_media_type() {
        let (_directory, database) = test_database();
        let with_default = database
            .import_excel(
                &excel_base64(&[&["标题"], &["无类型内容"]]),
                Some(MediaType::Novel),
            )
            .unwrap();
        assert_eq!(with_default.imported, 1);
        assert_eq!(with_default.entries[0].media_type, MediaType::Novel);

        let without_default = database
            .import_excel(&excel_base64(&[&["标题"], &["另一条"]]), None)
            .unwrap();
        assert_eq!(without_default.entries[0].media_type, MediaType::Drama);
    }

    #[test]
    fn import_excel_persists_across_reopens_and_persists_completion() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        let expected_ids = {
            let database = Database::open(&path).unwrap();
            let report = database
                .import_excel(
                    &excel_base64(&[
                        &["标题", "当前进度", "总进度"],
                        &["第一条", "", ""],
                        &["第二条", "5", "5"],
                    ]),
                    None,
                )
                .unwrap();
            assert_eq!(report.imported, 2);
            assert_eq!(report.entries[1].status, EntryStatus::Completed);
            report
                .entries
                .iter()
                .map(|entry| entry.id.clone())
                .collect::<Vec<_>>()
        };

        let reopened = Database::open(&path).unwrap();
        let stored = reopened.list_entries().unwrap();
        assert_eq!(stored.len(), 2);
        let mut stored_ids = stored
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();
        stored_ids.sort();
        let mut expected = expected_ids;
        expected.sort();
        assert_eq!(stored_ids, expected);
        let completed = stored.iter().find(|entry| entry.title == "第二条").unwrap();
        assert_eq!(completed.current_progress, 5);
        assert_eq!(completed.status, EntryStatus::Completed);
    }

    #[test]
    fn import_excel_rejects_invalid_base64() {
        let (_directory, database) = test_database();
        assert_error(
            database.import_excel("!!!not base64!!!", None),
            "无法解析 Excel 文件",
        );
    }

    #[test]
    fn settings_default_to_empty_values_when_not_configured() {
        let (_directory, database) = test_database();
        let settings = database.get_settings().unwrap();

        assert_eq!(settings.tmdb_api_key, "");
        assert_eq!(settings.webdav_url, "");
        assert_eq!(settings.webdav_username, "");
        assert_eq!(settings.webdav_password, "");
        assert!(!settings.webdav_enabled);
        assert_eq!(settings.last_synced_at, None);
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.library_view, "list");
    }

    #[test]
    fn settings_round_trip_and_persist_across_reopens() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        let saved = {
            let database = Database::open(&path).unwrap();
            database
                .save_settings(AppSettings {
                    tmdb_api_key: "  tmdb-key  ".to_owned(),
                    webdav_url: " https://dav.example.com/catchup ".to_owned(),
                    webdav_username: " alice ".to_owned(),
                    webdav_password: " secret ".to_owned(),
                    webdav_enabled: true,
                    last_synced_at: Some(" 2026-11-20T00:00:00.000Z ".to_owned()),
                    theme: "  dark ".to_owned(),
                    library_view: "grid".to_owned(),
                })
                .unwrap()
        };

        assert_eq!(saved.tmdb_api_key, "tmdb-key");
        assert_eq!(saved.webdav_url, "https://dav.example.com/catchup");
        assert_eq!(saved.webdav_username, "alice");
        assert_eq!(saved.webdav_password, " secret ");
        assert_eq!(
            saved.last_synced_at.as_deref(),
            Some("2026-11-20T00:00:00.000Z")
        );
        assert_eq!(saved.theme, "dark");
        assert_eq!(saved.library_view, "grid");

        let reopened = Database::open(&path).unwrap();
        assert_eq!(reopened.get_settings().unwrap(), saved);
    }

    #[test]
    fn settings_require_webdav_url_and_username_when_enabled() {
        let (_directory, database) = test_database();

        assert_error(
            database.save_settings(AppSettings {
                webdav_enabled: true,
                webdav_url: "   ".to_owned(),
                webdav_username: "alice".to_owned(),
                ..AppSettings::default()
            }),
            "启用 WebDAV 自动同步时，请填写服务器地址",
        );
        assert_error(
            database.save_settings(AppSettings {
                webdav_enabled: true,
                webdav_url: "https://dav.example.com".to_owned(),
                webdav_username: "  ".to_owned(),
                ..AppSettings::default()
            }),
            "启用 WebDAV 自动同步时，请填写用户名",
        );

        database
            .save_settings(AppSettings {
                webdav_enabled: false,
                ..AppSettings::default()
            })
            .unwrap();
    }

    #[test]
    fn settings_validate_webdav_url_and_field_lengths() {
        let (_directory, database) = test_database();

        assert_error(
            database.save_settings(AppSettings {
                webdav_url: "ftp://dav.example.com".to_owned(),
                ..AppSettings::default()
            }),
            "WebDAV 服务器地址仅支持 http 或 https 链接",
        );
        assert_error(
            database.save_settings(AppSettings {
                webdav_url: format!("https://example.com/{}", "a".repeat(500)),
                ..AppSettings::default()
            }),
            "WebDAV 服务器地址不能超过 500 个字符",
        );
        assert_error(
            database.save_settings(AppSettings {
                tmdb_api_key: "a".repeat(201),
                ..AppSettings::default()
            }),
            "TMDB API Key 不能超过 200 个字符",
        );
        assert_error(
            database.save_settings(AppSettings {
                webdav_username: "a".repeat(201),
                ..AppSettings::default()
            }),
            "WebDAV 用户名不能超过 200 个字符",
        );
        assert_error(
            database.save_settings(AppSettings {
                webdav_password: "a".repeat(501),
                ..AppSettings::default()
            }),
            "WebDAV 密码不能超过 500 个字符",
        );
    }

    #[test]
    fn v2_database_upgrades_to_latest_and_keeps_settings_extensible() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(&format!(
                    "
                    CREATE TABLE entries ({ENTRIES_V2_DEFINITION});
                    CREATE INDEX entries_updated_at_id_idx
                        ON entries (updated_at DESC, id ASC);
                    CREATE INDEX entries_deleted_at_idx
                        ON entries (deleted_at DESC);
                    PRAGMA user_version = 2;
                    "
                ))
                .unwrap();
            connection
                .execute(
                    "
                    INSERT INTO entries (
                        id, title, media_type, current_progress, total_progress, status,
                        season, rating, platform, cover_url, overview, created_at, updated_at,
                        deleted_at
                    ) VALUES (?1, ?2, 'drama', 4, 12, 'tracking', 2, 8.6, '腾讯视频',
                        'https://example.com/cover.jpg', '简介', ?3, ?3, NULL)
                    ",
                    params!["v2-entry", "旧版 v2 条目", "2024-01-01T00:00:00.000000000Z"],
                )
                .unwrap();
        }

        let database = Database::open(&path).unwrap();
        let expected_defaults = AppSettings {
            theme: "system".to_owned(),
            library_view: "list".to_owned(),
            ..AppSettings::default()
        };
        assert_eq!(database.get_settings().unwrap(), expected_defaults);
        let entries = database.list_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "v2-entry");
        assert_eq!(entries[0].season, Some(2));
        assert_eq!(entries[0].rating, Some(8.6));

        {
            let connection = database.lock().unwrap();
            let version: u32 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(version, DATABASE_VERSION);
            let has_purged_table: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'purged_entries')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(has_purged_table);
            connection
                .execute(
                    "INSERT INTO settings (key, value) VALUES ('future_feature', 'on')",
                    [],
                )
                .unwrap();
        }

        database
            .save_settings(AppSettings {
                tmdb_api_key: "persisted-key".to_owned(),
                ..AppSettings::default()
            })
            .unwrap();
        drop(database);

        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            reopened.get_settings().unwrap().tmdb_api_key,
            "persisted-key"
        );
        let unknown: String = reopened
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key = 'future_feature'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unknown, "on");
        assert_eq!(reopened.list_entries().unwrap()[0].id, "v2-entry");
    }

    #[test]
    fn v4_database_upgrades_to_allow_to_watch_status() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("catchup.sqlite3");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "
                    CREATE TABLE entries (
                        id TEXT PRIMARY KEY NOT NULL,
                        title TEXT NOT NULL,
                        media_type TEXT NOT NULL CHECK (
                            media_type IN ('drama','anime','variety','novel','movie','short_drama')
                        ),
                        current_progress INTEGER NOT NULL CHECK (current_progress >= 0),
                        total_progress INTEGER,
                        status TEXT NOT NULL CHECK (
                            status IN ('tracking','completed','dropped')
                        ),
                        season INTEGER CHECK (season BETWEEN 1 AND 999),
                        rating REAL CHECK (rating >= 0 AND rating <= 10),
                        platform TEXT CHECK (length(platform) <= 100),
                        cover_url TEXT CHECK (
                            cover_url IS NULL OR length(cover_url) <= 500
                        ),
                        overview TEXT CHECK (length(overview) <= 2000),
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        deleted_at TEXT
                    );
                    CREATE INDEX entries_updated_at_id_idx
                        ON entries (updated_at DESC, id ASC);
                    CREATE INDEX entries_deleted_at_idx
                        ON entries (deleted_at DESC);
                    CREATE TABLE purged_entries (
                        id TEXT PRIMARY KEY NOT NULL,
                        purged_at TEXT NOT NULL
                    );
                    CREATE TABLE settings (
                        key TEXT PRIMARY KEY NOT NULL,
                        value TEXT NOT NULL
                    );
                    PRAGMA user_version = 4;
                    ",
                )
                .unwrap();
            connection
                .execute(
                    "
                    INSERT INTO entries (
                        id, title, media_type, current_progress, total_progress, status,
                        season, rating, platform, cover_url, overview, created_at, updated_at,
                        deleted_at
                    ) VALUES (?1, ?2, 'drama', 1, 12, 'tracking', NULL, NULL, NULL,
                        NULL, NULL, ?3, ?3, NULL)
                    ",
                    params![
                        "old-entry",
                        "旧版 v4 条目",
                        "2024-01-01T00:00:00.000000000Z"
                    ],
                )
                .unwrap();
        }

        let database = Database::open(&path).unwrap();
        let entries = database.list_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "old-entry");

        // 升级后应允许写入“待看”状态。
        let planned = database
            .create_entry(EntryInput {
                status: EntryStatus::ToWatch,
                ..input("新待看")
            })
            .unwrap();
        assert_eq!(planned.status, EntryStatus::ToWatch);

        let version: u32 = database
            .lock()
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_VERSION);
    }
}
