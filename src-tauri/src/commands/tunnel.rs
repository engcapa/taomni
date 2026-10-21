pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::tunnel::list_tunnels,
        crate::tunnel::upsert_tunnel,
        crate::tunnel::delete_tunnel,
        crate::tunnel::start_tunnel,
        crate::tunnel::stop_tunnel,
        crate::tunnel::start_all_tunnels,
        crate::tunnel::stop_all_tunnels,
        crate::tunnel::reorder_tunnels,
        crate::tunnel::test_tunnel,
        crate::tunnel::get_tunnel_status,
        crate::tunnel::list_tunnel_statuses,
    ];
    handler(invoke)
}
