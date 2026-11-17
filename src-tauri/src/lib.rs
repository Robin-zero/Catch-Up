mod database;

use database::{Database, EntryInput, EntryStatus, MediaEntry};
use tauri::{Manager, State};

#[tauri::command]
fn list_entries(database: State<'_, Database>) -> Result<Vec<MediaEntry>, String> {
    database.list_entries()
}

#[tauri::command]
fn create_entry(database: State<'_, Database>, input: EntryInput) -> Result<MediaEntry, String> {
    database.create_entry(input)
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_entries,
            create_entry,
            update_entry,
            delete_entry,
            adjust_progress,
            set_entry_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CatchUp");
}
