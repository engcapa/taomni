pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::sdk::sdk_get_registry,
        crate::sdk::sdk_probe_installation,
        crate::sdk::sdk_discover_installations,
        crate::sdk::sdk_save_installation,
        crate::sdk::sdk_remove_installation,
        crate::sdk::sdk_refresh_installations,
        crate::sdk::sdk_set_default,
        crate::sdk::sdk_save_workspace_binding,
        crate::sdk::sdk_remove_workspace_binding,
        crate::sdk::sdk_analyze_workspace,
        crate::sdk::sdk_resolve_workspace,
    ];
    handler(invoke)
}
