pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::proxy::get_app_proxy_config,
        crate::proxy::save_app_proxy_config,
        crate::proxy::get_app_proxy_url,
    ];
    handler(invoke)
}
