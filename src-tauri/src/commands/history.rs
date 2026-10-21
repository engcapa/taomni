pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::history::history_append,
        crate::history::history_match_prefix,
        crate::history::history_list_recent,
        crate::history::history_clear,
    ];
    handler(invoke)
}
