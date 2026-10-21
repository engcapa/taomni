pub fn select_private_key_file(_current_path: Option<&str>) -> Result<Option<String>, String> {
    Err("Native file dialog is not supported on this platform".to_string())
}

pub fn select_upload_file() -> Result<Vec<String>, String> {
    Err("Native file dialog is not supported on this platform".to_string())
}

pub fn select_save_directory(_current_path: Option<&str>) -> Result<Option<String>, String> {
    Err("Native file dialog is not supported on this platform".to_string())
}

pub fn select_save_file_path(
    _default_name: Option<&str>,
    _current_path: Option<&str>,
) -> Result<Option<String>, String> {
    Err("Native file dialog is not supported on this platform".to_string())
}

pub fn select_folder_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
    Err("Native file dialog is not supported on this platform".to_string())
}

pub fn select_file_path(_current_path: Option<&str>) -> Result<Option<String>, String> {
    Err("Native file dialog is not supported on this platform".to_string())
}

pub fn clipboard_read_files() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

pub fn clipboard_write_files(_paths: &[String]) -> Result<(), String> {
    Err("Native file clipboard is not supported on this platform".to_string())
}
