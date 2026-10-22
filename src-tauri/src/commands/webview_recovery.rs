pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::webview_recovery::recovery_get,
        crate::webview_recovery::recovery_update,
        crate::webview_recovery::recovery_ready,
    ];
    handler(invoke)
}
