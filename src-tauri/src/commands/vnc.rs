pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::vnc::vnc_connect,
        crate::vnc::vnc_disconnect,
        crate::vnc::vnc_test_connection,
        crate::vnc::vnc_create_detach_claim,
        crate::vnc::vnc_consume_detach_claim,
        crate::vnc::vnc_cancel_connect,
        crate::vnc::keyboard_hook::vnc_set_special_key_capture,
        crate::vnc::keyboard_hook::vnc_special_key_capture_status,
    ];
    handler(invoke)
}
