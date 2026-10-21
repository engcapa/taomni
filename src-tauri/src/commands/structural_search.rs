pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::structural_search::structural_search_capabilities,
        crate::structural_search::structural_search_run,
        crate::structural_search::structural_search_cancel,
    ];
    handler(invoke)
}
