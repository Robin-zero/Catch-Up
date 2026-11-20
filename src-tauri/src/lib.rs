pub mod database;
pub mod excel;
pub mod settings;
pub mod tmdb;
pub mod webdav;

use base64::Engine as _;
use database::{Database, EntryInput, EntryStatus, ImportReport, MediaEntry, MediaType};
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
async fn sync_now(database: State<'_, Database>) -> Result<SyncReport, String> {
    webdav::sync_now(database.inner()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_directory = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(format!("无法定位应用数据目录：{error}")))?;
            let database = Database::open(data_directory.join("catchup.sqlite3"))
                .map_err(std::io::Error::other)?;
            app.manage(database);

            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
                use tauri::Emitter;

                let new_entry =
                    MenuItem::with_id(app, "new_entry", "新建条目", true, Some("CmdOrCtrl+N"))?;
                let file_menu = Submenu::with_items(
                    app,
                    "文件",
                    true,
                    &[
                        &new_entry,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
                    ],
                )?;
                let edit_menu = Submenu::with_items(
                    app,
                    "编辑",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, Some("撤销"))?,
                        &PredefinedMenuItem::redo(app, Some("重做"))?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, Some("剪切"))?,
                        &PredefinedMenuItem::copy(app, Some("复制"))?,
                        &PredefinedMenuItem::paste(app, Some("粘贴"))?,
                        &PredefinedMenuItem::select_all(app, Some("全选"))?,
                    ],
                )?;
                let window_menu = Submenu::with_items(
                    app,
                    "窗口",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, Some("最小化"))?,
                        &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
                    ],
                )?;
                let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &window_menu])?;
                app.set_menu(menu)?;

                app.on_menu_event(|app, event| {
                    if event.id() == "new_entry" {
                        let _ = app.emit("catchup://new-entry", ());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_entries,
            create_entry,
            import_excel,
            download_excel_template,
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
            sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CatchUp");
}
