pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::ai::commands::get_ai_config,
        crate::ai::commands::get_opencode_go_catalog,
        crate::ai::commands::get_provider_models,
        crate::ai::commands::test_llm_model,
        crate::ai::commands::save_ai_config,
        crate::ai::commands::save_ai_api_key,
        crate::ai::commands::test_llm_connection,
        crate::ai::commands::generate_shell_command,
        crate::ai::commands::update_shell_audit_outcome,
        crate::ai::session_safety::is_session_ai_write_disabled,
    ];
    handler(invoke)
}
