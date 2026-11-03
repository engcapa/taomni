pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::orchestration::commands::orchestration_get_settings,
        crate::orchestration::commands::orchestration_save_settings,
        crate::orchestration::commands::orchestration_list_runs,
        crate::orchestration::commands::orchestration_get_run,
        crate::orchestration::commands::orchestration_create_run,
        crate::orchestration::commands::orchestration_preview_context,
        crate::orchestration::commands::orchestration_start_run,
        crate::orchestration::commands::orchestration_cancel_run,
        crate::orchestration::commands::orchestration_recover_run,
        crate::orchestration::commands::orchestration_active_count,
    ];
    handler(invoke)
}
