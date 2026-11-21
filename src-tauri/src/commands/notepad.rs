use crate::notepad::{
    self, NotepadBackupContent, NotepadBackupEntry, NotepadDirFilesResult, NotepadEncodingGroup,
    NotepadEncodingLossReport, NotepadHashResult, NotepadMacroLoadResult, NotepadRenameResult,
    NotepadSaveAsResult,
};
use crate::resolved_app_data_dir;
use tauri::AppHandle;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("io: Task join error: {e}"))?
}

#[tauri::command]
pub(crate) async fn viewer_save_as(
    path: String,
    content: String,
    encoding: String,
    bom: bool,
    eol: String,
    overwrite: bool,
) -> Result<NotepadSaveAsResult, String> {
    blocking(move || notepad::save_as(&path, &content, &encoding, bom, &eol, overwrite)).await
}

#[tauri::command]
pub(crate) async fn viewer_rename(
    old_path: String,
    new_name: String,
) -> Result<NotepadRenameResult, String> {
    blocking(move || notepad::rename_file(&old_path, &new_name)).await
}

#[tauri::command]
pub(crate) async fn viewer_trash(path: String) -> Result<String, String> {
    blocking(move || notepad::trash_file(&path)).await
}

#[tauri::command]
pub(crate) async fn viewer_set_readonly_attr(path: String, readonly: bool) -> Result<bool, String> {
    blocking(move || notepad::set_readonly_attr(&path, readonly)).await
}

#[tauri::command]
pub(crate) async fn viewer_write_text_elevated(
    path: String,
    content: String,
    encoding: String,
    bom: bool,
    eol: String,
) -> Result<NotepadSaveAsResult, String> {
    blocking(move || notepad::write_text_elevated(&path, &content, &encoding, bom, &eol)).await
}

#[tauri::command]
pub(crate) async fn notepad_open_terminal_dir(
    path: String,
    preferred_shell: Option<String>,
) -> Result<(), String> {
    blocking(move || notepad::open_terminal_dir(&path, preferred_shell.as_deref())).await
}

#[tauri::command]
pub(crate) async fn notepad_list_dir_text_files(
    path: String,
    max_count: Option<usize>,
) -> Result<NotepadDirFilesResult, String> {
    blocking(move || notepad::list_dir_text_files(&path, max_count)).await
}

#[tauri::command]
pub(crate) async fn notepad_backup_write(
    app: AppHandle,
    doc_id: String,
    path: Option<String>,
    name: String,
    content: String,
    encoding: String,
    bom: bool,
    eol: String,
    saved_hash: String,
) -> Result<NotepadBackupEntry, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || {
        notepad::backup_write(
            &dir,
            &doc_id,
            path.as_deref(),
            &name,
            &content,
            &encoding,
            bom,
            &eol,
            &saved_hash,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn notepad_backup_list(app: AppHandle) -> Result<Vec<NotepadBackupEntry>, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::backup_list(&dir)).await
}

#[tauri::command]
pub(crate) async fn notepad_backup_read(
    app: AppHandle,
    id: String,
) -> Result<NotepadBackupContent, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::backup_read(&dir, &id)).await
}

#[tauri::command]
pub(crate) async fn notepad_backup_prune(app: AppHandle, doc_id: String) -> Result<(), String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::backup_prune(&dir, &doc_id)).await
}

#[tauri::command]
pub(crate) async fn notepad_save_backup_copy(
    app: AppHandle,
    source_path: String,
    mode: String,
    custom_dir: Option<String>,
) -> Result<Option<String>, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::save_backup_copy(&dir, &source_path, &mode, custom_dir.as_deref()))
        .await
}

#[tauri::command]
pub(crate) async fn notepad_hash(
    algorithm: String,
    text: Option<String>,
    file_path: Option<String>,
) -> Result<NotepadHashResult, String> {
    blocking(move || notepad::compute_hash(&algorithm, text.as_deref(), file_path.as_deref())).await
}

#[tauri::command]
pub(crate) fn notepad_list_encodings() -> Vec<NotepadEncodingGroup> {
    notepad::list_encodings()
}

#[tauri::command]
pub(crate) async fn notepad_check_encoding_loss(
    content: String,
    encoding_label: String,
) -> Result<NotepadEncodingLossReport, String> {
    blocking(move || notepad::check_encoding_loss(&content, &encoding_label)).await
}

#[tauri::command]
pub(crate) async fn notepad_macros_load(app: AppHandle) -> Result<NotepadMacroLoadResult, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::macros_load(&dir)).await
}

#[tauri::command]
pub(crate) async fn notepad_macros_save(
    app: AppHandle,
    json: String,
) -> Result<NotepadMacroLoadResult, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::macros_save(&dir, &json)).await
}

#[tauri::command]
pub(crate) async fn notepad_macros_validate(
    app: AppHandle,
) -> Result<NotepadMacroLoadResult, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::macros_validate(&dir)).await
}

#[tauri::command]
pub(crate) async fn notepad_macros_accept(
    app: AppHandle,
) -> Result<NotepadMacroLoadResult, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::macros_accept(&dir)).await
}

#[tauri::command]
pub(crate) async fn notepad_session_save(
    app: AppHandle,
    file_path: Option<String>,
    json: String,
) -> Result<String, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::session_save(&dir, file_path.as_deref(), &json)).await
}

#[tauri::command]
pub(crate) async fn notepad_session_load(
    app: AppHandle,
    file_path: Option<String>,
) -> Result<Option<String>, String> {
    let dir = resolved_app_data_dir(&app)?;
    blocking(move || notepad::session_load(&dir, file_path.as_deref())).await
}

pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::commands::notepad::viewer_save_as,
        crate::commands::notepad::viewer_rename,
        crate::commands::notepad::viewer_trash,
        crate::commands::notepad::viewer_set_readonly_attr,
        crate::commands::notepad::viewer_write_text_elevated,
        crate::commands::notepad::notepad_open_terminal_dir,
        crate::commands::notepad::notepad_list_dir_text_files,
        crate::commands::notepad::notepad_backup_write,
        crate::commands::notepad::notepad_backup_list,
        crate::commands::notepad::notepad_backup_read,
        crate::commands::notepad::notepad_backup_prune,
        crate::commands::notepad::notepad_save_backup_copy,
        crate::commands::notepad::notepad_hash,
        crate::commands::notepad::notepad_list_encodings,
        crate::commands::notepad::notepad_check_encoding_loss,
        crate::commands::notepad::notepad_macros_load,
        crate::commands::notepad::notepad_macros_save,
        crate::commands::notepad::notepad_macros_validate,
        crate::commands::notepad::notepad_macros_accept,
        crate::commands::notepad::notepad_session_save,
        crate::commands::notepad::notepad_session_load,
    ];
    handler(invoke)
}

pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "viewer_save_as"
            | "viewer_rename"
            | "viewer_trash"
            | "viewer_set_readonly_attr"
            | "viewer_write_text_elevated"
            | "notepad_open_terminal_dir"
            | "notepad_list_dir_text_files"
            | "notepad_backup_write"
            | "notepad_backup_list"
            | "notepad_backup_read"
            | "notepad_backup_prune"
            | "notepad_save_backup_copy"
            | "notepad_hash"
            | "notepad_list_encodings"
            | "notepad_check_encoding_loss"
            | "notepad_macros_load"
            | "notepad_macros_save"
            | "notepad_macros_validate"
            | "notepad_macros_accept"
            | "notepad_session_save"
            | "notepad_session_load"
    )
}
