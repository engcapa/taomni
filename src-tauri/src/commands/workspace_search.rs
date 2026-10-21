pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::workspace_search::workspace_search_start,
        crate::workspace_search::workspace_search_cancel,
    ];
    handler(invoke)
}
