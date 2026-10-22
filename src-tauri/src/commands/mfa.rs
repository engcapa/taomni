pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::mfa::commands::mfa_list,
        crate::mfa::commands::mfa_codes,
        crate::mfa::commands::mfa_inspect,
        crate::mfa::commands::mfa_add,
        crate::mfa::commands::mfa_update,
        crate::mfa::commands::mfa_delete,
        crate::mfa::commands::mfa_reorder,
        crate::mfa::commands::mfa_hotp_next,
        crate::mfa::commands::mfa_mark_used,
        crate::mfa::commands::mfa_set_prefs,
        crate::mfa::commands::mfa_reset_store,
        crate::mfa::commands::mfa_export_uri,
        crate::mfa::commands::mfa_read_clipboard_image,
        crate::mfa::commands::mfa_capture_screens,
    ];
    handler(invoke)
}
