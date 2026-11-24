pub mod ai;
pub mod cover;
pub mod database;
pub mod excel;
pub mod scrape;
pub mod settings;
pub mod tmdb;
pub mod webdav;

use base64::Engine as _;
use database::{Database, EntryInput, EntryStatus, ImportReport, MediaEntry, MediaType};
use scrape::SmartScrapeResult;
use settings::AppSettings;
use tauri::{Manager, State};
use tmdb::ScrapeCandidate;
use webdav::SyncReport;

#[tauri::command]
fn list_entries(database: State<'_, Database>) -> Result<Vec<MediaEntry>, String> {
    database.list_entries()
}

#[tauri::command]
fn create_entry(database: State<'_, Database>, input: EntryInput) -> Result<MediaEntry, String> {
    database.create_entry(input)
}

#[tauri::command]
fn import_excel(
    database: State<'_, Database>,
    data: String,
    default_media_type: Option<MediaType>,
) -> Result<ImportReport, String> {
    database.import_excel(&data, default_media_type)
}

#[tauri::command]
fn download_excel_template() -> Result<String, String> {
    let bytes = excel::generate_template_bytes()?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn update_entry(
    database: State<'_, Database>,
    id: String,
    input: EntryInput,
) -> Result<MediaEntry, String> {
    database.update_entry(&id, input)
}

#[tauri::command]
fn delete_entry(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.delete_entry(&id)
}

#[tauri::command]
fn adjust_progress(
    database: State<'_, Database>,
    id: String,
    delta: i32,
) -> Result<MediaEntry, String> {
    database.adjust_progress(&id, delta)
}

#[tauri::command]
fn set_entry_status(
    database: State<'_, Database>,
    id: String,
    status: EntryStatus,
) -> Result<MediaEntry, String> {
    database.set_entry_status(&id, status)
}

#[tauri::command]
fn list_trash(database: State<'_, Database>) -> Result<Vec<MediaEntry>, String> {
    database.list_trash()
}

#[tauri::command]
fn restore_entry(database: State<'_, Database>, id: String) -> Result<MediaEntry, String> {
    database.restore_entry(&id)
}

#[tauri::command]
fn purge_entry(database: State<'_, Database>, id: String) -> Result<(), String> {
    database.purge_entry(&id)
}

#[tauri::command]
fn empty_trash(database: State<'_, Database>) -> Result<(), String> {
    database.empty_trash()
}

#[tauri::command]
fn get_settings(database: State<'_, Database>) -> Result<AppSettings, String> {
    database.get_settings()
}

#[tauri::command]
fn save_settings(
    database: State<'_, Database>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    database.save_settings(settings)
}

#[tauri::command]
async fn search_tmdb(
    database: State<'_, Database>,
    query: String,
    media_type: Option<MediaType>,
) -> Result<Vec<ScrapeCandidate>, String> {
    // 先读取并释放数据库锁，再发起网络请求，避免 MutexGuard 跨 await。
    let settings = database.get_settings()?;
    tmdb::search_tmdb(&settings, &query, media_type).await
}

#[tauri::command]
async fn smart_scrape(
    database: State<'_, Database>,
    query: String,
    media_type: Option<MediaType>,
) -> Result<SmartScrapeResult, String> {
    // 先读取并释放数据库锁，再发起网络请求，避免 MutexGuard 跨 await。
    let settings = database.get_settings()?;
    scrape::smart_scrape(&settings, &query, media_type).await
}

#[tauri::command]
async fn sync_now(
    app: tauri::AppHandle,
    database: State<'_, Database>,
) -> Result<SyncReport, String> {
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    webdav::sync_now(database.inner(), &data_directory).await
}

#[cfg(desktop)]
fn migrate_legacy_data_directory(data_directory: &std::path::Path) {
    const LEGACY_IDENTIFIER: &str = "com.catchup.progress";
    if data_directory.join("catchup.sqlite3").exists() {
        return;
    }
    let Some(parent) = data_directory.parent() else {
        return;
    };
    let legacy = parent.join(LEGACY_IDENTIFIER);
    if !legacy.join("catchup.sqlite3").exists() {
        return;
    }
    if std::fs::create_dir_all(data_directory).is_err() {
        return;
    }
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("catchup.sqlite3{suffix}");
        let source = legacy.join(&name);
        if source.exists() {
            let _ = std::fs::copy(&source, data_directory.join(&name));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(format!("无法定位应用数据目录：{error}")))?;
            #[cfg(desktop)]
            migrate_legacy_data_directory(&data_directory);
            let database = Database::open(data_directory.join("catchup.sqlite3"))
                .map_err(std::io::Error::other)?;
            app.manage(database);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_entries,
            create_entry,
            import_excel,
            download_excel_template,
            cover::save_cover_image,
            cover::cache_cover_from_url,
            update_entry,
            delete_entry,
            adjust_progress,
            set_entry_status,
            list_trash,
            restore_entry,
            purge_entry,
            empty_trash,
            get_settings,
            save_settings,
            search_tmdb,
            smart_scrape,
            sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CatchUp");
}
