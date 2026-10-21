pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::tab::tab_suggest_path,
        crate::tab::tab_suggest_fim,
        crate::tab::tab_rewrite_command,
    ];
    handler(invoke)
}
