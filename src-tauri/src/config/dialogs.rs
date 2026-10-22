use super::platform;

#[tauri::command]
pub fn select_private_key_file(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_private_key_file(current_path.as_deref())
}

#[tauri::command]
pub fn select_upload_file() -> Result<Vec<String>, String> {
    platform::select_upload_file()
}

#[tauri::command]
pub fn select_file_path(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_file_path(current_path.as_deref())
}

#[tauri::command]
pub fn select_folder_path(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_folder_path(current_path.as_deref())
}

#[tauri::command]
pub fn select_save_directory(current_path: Option<String>) -> Result<Option<String>, String> {
    platform::select_save_directory(current_path.as_deref())
}

#[tauri::command]
pub fn select_save_file_path(
    default_name: Option<String>,
    current_path: Option<String>,
) -> Result<Option<String>, String> {
    platform::select_save_file_path(default_name.as_deref(), current_path.as_deref())
}

#[tauri::command]
pub fn get_home_dir() -> Option<String> {
    dirs::home_dir().map(|path| path.to_string_lossy().into_owned())
}
