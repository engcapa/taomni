pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::dap::dap_start_session,
        crate::dap::dap_send_request,
        crate::dap::dap_send,
        crate::dap::dap_terminate,
    ];
    handler(invoke)
}
