pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::session::list_sessions,
        crate::session::resume::get_welcome_run_snapshot,
        crate::session::resume::commit_welcome_run_snapshot,
        crate::session::resume::clear_welcome_run_snapshot,
        crate::session::get_session,
        crate::session::save_session,
        crate::session::delete_session,
        crate::session::mark_session_connected,
        crate::session::list_session_groups,
        crate::session::save_session_group,
        crate::session::delete_session_group,
        crate::session::import::import_putty_sessions,
        crate::session::import::import_wsl_sessions,
        crate::session::import::import_external_bash_sessions,
        crate::session::import::scan_local_session_files,
        crate::session::import::read_dbeaver_credentials_for_data_sources,
        crate::session::import::read_plist_session_file,
        crate::session::import_secrets::keychain::keychain_lookup_batch,
        crate::session::import_secrets::securecrt::securecrt_decrypt_passwords,
        crate::session::import_secrets::tabby::tabby_decrypt_vault,
    ];
    handler(invoke)
}
