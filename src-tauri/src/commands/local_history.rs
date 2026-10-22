pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::local_history::history_snapshot,
        crate::local_history::history_list,
        crate::local_history::history_read,
        crate::local_history::history_prune,
    ];
    handler(invoke)
}
