pub(super) fn handles(command: &str) -> bool {
    matches!(
        command,
        "mobile_status"
            | "mobile_start"
            | "mobile_stop"
            | "mobile_listener_get"
            | "mobile_listener_save"
            | "mobile_pairing_code"
            | "mobile_revoke"
            | "mobile_open_session_result"
            | "mobile_claim_open_session"
            | "mobile_set_open_sessions"
            | "mobile_set_screen_capture"
            | "mobile_terminal_title"
            | "mobile_connection_auth"
            | "mobile_cancel_open_session"
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
        crate::mobile::mobile_listener_get,
        crate::mobile::mobile_listener_save,
        crate::mobile::mobile_pairing_code,
        crate::mobile::mobile_revoke,
        crate::mobile::session_open::mobile_open_session_result,
        crate::mobile::session_open::mobile_claim_open_session,
        crate::mobile::session_open::mobile_set_open_sessions,
        crate::mobile::mobile_set_screen_capture,
        crate::mobile::session_open::mobile_terminal_title,
        crate::mobile::session_open::connection_auth::mobile_connection_auth,
        crate::mobile::session_open::connection_auth::mobile_cancel_open_session,
    ];
    handler(invoke)
}
