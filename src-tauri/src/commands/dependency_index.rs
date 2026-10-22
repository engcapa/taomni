pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::dependency_index::dependency_index_status,
        crate::dependency_index::dependency_index_search,
        crate::dependency_index::dependency_index_versions,
    ];
    handler(invoke)
}
