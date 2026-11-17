use std::{
    fs,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, types::Type, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const DATABASE_VERSION: u32 = 1;
const ENTRY_COLUMNS: &str = "
    id, title, media_type, current_progress, total_progress, status, created_at, updated_at
";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Drama,
    Anime,
    Variety,
    Novel,
    Movie,
}

impl MediaType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Drama => "drama",
            Self::Anime => "anime",
            Self::Variety => "variety",
            Self::Novel => "novel",
            Self::Movie => "movie",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "drama" => Ok(Self::Drama),
            "anime" => Ok(Self::Anime),
            "variety" => Ok(Self::Variety),
            "novel" => Ok(Self::Novel),
            "movie" => Ok(Self::Movie),
            _ => Err(format!("数据库包含未知媒体类型：{value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    Tracking,
    Completed,
}

impl EntryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tracking => "tracking",
            Self::Completed => "completed",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "tracking" => Ok(Self::Tracking),
            "completed" => Ok(Self::Completed),
            _ => Err(format!("数据库包含未知追更状态：{value}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub id: String,
    pub title: String,
    pub media_type: MediaType,
    pub current_progress: i64,
    pub total_progress: Option<i64>,
    pub status: EntryStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub title: String,
    pub media_type: MediaType,
    pub current_progress: i64,
    pub total_progress: Option<i64>,
    pub status: EntryStatus,
}

struct ValidatedInput {
    title: String,
    media_type: MediaType,
    current_progress: i64,
    total_progress: Option<i64>,
    status: EntryStatus,
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

        let status = if self.total_progress == Some(self.current_progress) {
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
        })
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
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS entries (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
                    media_type TEXT NOT NULL CHECK (
                        media_type IN ('drama', 'anime', 'variety', 'novel', 'movie')
                    ),
                    current_progress INTEGER NOT NULL CHECK (
                        typeof(current_progress) = 'integer' AND current_progress >= 0
                    ),
                    total_progress INTEGER CHECK (
                        total_progress IS NULL
                        OR (typeof(total_progress) = 'integer' AND total_progress > 0)
                    ),
                    status TEXT NOT NULL CHECK (status IN ('tracking', 'completed')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    CHECK (total_progress IS NULL OR current_progress <= total_progress)
                );

                CREATE INDEX IF NOT EXISTS entries_updated_at_id_idx
                    ON entries (updated_at DESC, id ASC);
                ",
            )
            .map_err(|error| format!("无法初始化数据库表：{error}"))?;
        transaction
            .pragma_update(None, "user_version", DATABASE_VERSION)
            .map_err(|error| format!("无法写入数据库版本：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("无法完成数据库迁移：{error}"))
    }

    pub fn list_entries(&self) -> Result<Vec<MediaEntry>, String> {
        let connection = self.lock()?;
        let sql = format!("SELECT {ENTRY_COLUMNS} FROM entries ORDER BY updated_at DESC, id ASC");
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("无法准备追更列表查询：{error}"))?;
        let rows = statement
            .query_map([], entry_from_row)
            .map_err(|error| format!("无法查询追更列表：{error}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取追更列表：{error}"))
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
            created_at: now.clone(),
            updated_at: now,
        };

        self.lock()?
            .execute(
                "
                INSERT INTO entries (
                    id, title, media_type, current_progress, total_progress, status,
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    entry.id,
                    entry.title,
                    entry.media_type.as_str(),
                    entry.current_progress,
                    entry.total_progress,
                    entry.status.as_str(),
                    entry.created_at,
                    entry.updated_at,
                ],
            )
            .map_err(|error| format!("创建追更条目失败：{error}"))?;

        Ok(entry)
    }

    pub fn update_entry(&self, id: &str, input: EntryInput) -> Result<MediaEntry, String> {
        let input = input.validate()?;
        let connection = self.lock()?;
        let affected = connection
            .execute(
                "
                UPDATE entries
                SET title = ?2, media_type = ?3, current_progress = ?4,
                    total_progress = ?5, status = ?6, updated_at = ?7
                WHERE id = ?1
                ",
                params![
                    id,
                    input.title,
                    input.media_type.as_str(),
                    input.current_progress,
                    input.total_progress,
                    input.status.as_str(),
                    timestamp(),
                ],
            )
            .map_err(|error| format!("更新追更条目失败：{error}"))?;
        if affected == 0 {
            return Err(format!("要更新的条目不存在（ID：{id}）"));
        }

        find_entry(&connection, id)
            .map_err(|error| format!("读取更新后的条目失败：{error}"))?
            .ok_or_else(|| format!("要更新的条目不存在（ID：{id}）"))
    }

    pub fn delete_entry(&self, id: &str) -> Result<(), String> {
        let affected = self
            .lock()?
            .execute("DELETE FROM entries WHERE id = ?1", params![id])
            .map_err(|error| format!("删除追更条目失败：{error}"))?;
        if affected == 0 {
            return Err(format!("要删除的条目不存在（ID：{id}）"));
        }
        Ok(())
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

        let next_status = if delta < 0 {
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
                WHERE id = ?1 AND current_progress = ?5
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
        let connection = self.lock()?;
        let affected = connection
            .execute(
                "UPDATE entries SET status = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, status.as_str(), timestamp()],
            )
            .map_err(|error| format!("更新追更状态失败：{error}"))?;
        if affected == 0 {
            return Err(format!("要更新状态的条目不存在（ID：{id}）"));
        }

        find_entry(&connection, id)
            .map_err(|error| format!("读取更新后的状态失败：{error}"))?
            .ok_or_else(|| format!("要更新状态的条目不存在（ID：{id}）"))
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true)
}

fn find_entry(connection: &Connection, id: &str) -> rusqlite::Result<Option<MediaEntry>> {
    let sql = format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id = ?1");
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
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
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
            assert!(value.get("media_type").is_none());
            assert!(value.get("current_progress").is_none());
            assert!(value.get("total_progress").is_none());
            assert!(value.get("created_at").is_none());
            assert!(value.get("updated_at").is_none());
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
        assert_eq!(database.list_entries().unwrap().len(), 5);
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
        let invalid_statements = [
            "UPDATE entries SET title = '  ' WHERE id = ?1",
            "UPDATE entries SET media_type = 'book' WHERE id = ?1",
            "UPDATE entries SET current_progress = -1 WHERE id = ?1",
            "UPDATE entries SET current_progress = 1.5 WHERE id = ?1",
            "UPDATE entries SET total_progress = 0 WHERE id = ?1",
            "UPDATE entries SET total_progress = 2.5 WHERE id = ?1",
            "UPDATE entries SET current_progress = 11 WHERE id = ?1",
            "UPDATE entries SET status = 'paused' WHERE id = ?1",
        ];

        for statement in invalid_statements {
            let result = database
                .lock()
                .unwrap()
                .execute(statement, params![&entry.id]);
            assert!(result.is_err(), "statement should fail: {statement}");
        }

        let stored = database.list_entries().unwrap().remove(0);
        assert_eq!(stored.title, entry.title);
        assert_eq!(stored.media_type, entry.media_type);
        assert_eq!(stored.current_progress, entry.current_progress);
        assert_eq!(stored.total_progress, entry.total_progress);
        assert_eq!(stored.status, entry.status);
    }
}
