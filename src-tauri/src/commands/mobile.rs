pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "mobile_status"
            | "mobile_start"
            | "mobile_stop"
            | "mobile_pairing_code"
            | "mobile_revoke"
            | "mobile_feishu_get"
            | "mobile_feishu_save"
            | "mobile_feishu_start"
            | "mobile_feishu_stop"
    )
}
pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::mobile::mobile_feishu_get,
        crate::mobile::mobile_feishu_save,
        crate::mobile::mobile_feishu_start,
        crate::mobile::mobile_feishu_stop,
        crate::mobile::mobile_status,
        crate::mobile::mobile_start,
        crate::mobile::mobile_stop,
        crate::mobile::mobile_pairing_code,
        crate::mobile::mobile_revoke,
    ];
    handler(invoke)
}
