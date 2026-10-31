pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::mobile::mobile_status,
        crate::mobile::mobile_start,
        crate::mobile::mobile_stop,
        crate::mobile::mobile_pairing_code,
        crate::mobile::mobile_revoke,
    ];
    handler(invoke)
}
