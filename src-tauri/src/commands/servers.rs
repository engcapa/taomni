pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::servers::start_local_server,
        crate::servers::stop_local_server,
        crate::servers::get_server_status,
        crate::servers::list_server_statuses,
        crate::servers::list_server_logs,
        crate::servers::clear_server_log,
        crate::servers::probe_rdp_capture,
        crate::servers::resolve_rdp_connection_request,
        crate::servers::probe_system_rdp,
        crate::servers::open_system_rdp_settings,
        crate::servers::save_server_config,
        crate::servers::load_server_configs,
    ];
    handler(invoke)
}
