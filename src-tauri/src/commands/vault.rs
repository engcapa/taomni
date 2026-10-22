pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::vault::vault_status,
        crate::vault::vault_init,
        crate::vault::vault_unlock,
        crate::vault::vault_lock,
        crate::vault::vault_change_master,
        crate::vault::vault_put,
        crate::vault::vault_update,
        crate::vault::vault_delete,
        crate::vault::vault_list,
    ];
    handler(invoke)
}
