pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::rdp::rdp_connect,
        crate::rdp::rdp_disconnect,
        crate::rdp::rdp_test_connection,
        crate::rdp::rdp_trust_certificate,
    ];
    handler(invoke)
}
