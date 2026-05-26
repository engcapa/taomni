mod state;
mod terminal;
mod session;
mod filebrowser;
mod tunnel;
mod nettools;
mod serial;
mod config;
mod appearance;
mod vnc;
mod rdp;
mod wsl;
mod history;
pub mod vault;
pub mod ai;
mod asr;
pub mod llm;
mod tab;
pub mod agent;
mod chat;
pub mod models;
pub mod perf;
mod voice;

use state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

#[tauri::command]
fn exit_app(app_handle: AppHandle) {
    app_handle.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data).ok();

            let db_path = app_data.join("newmob.db");
            let conn = rusqlite::Connection::open(&db_path)
                .expect("failed to open database");
            session::db::init_db(&conn).expect("failed to init database");

            let vault_path = vault::default_vault_path(app.handle());
            let v = vault::Vault::open(&vault_path).expect("failed to open vault");
            let vault_arc = Arc::new(v);

            // Load AI config and build the AppAiCtx (AsrManager + LlmRouter).
            // Vault is passed so api_key fields stored as `vault:<id>` get
            // transparently resolved by the LLM router.
            let ai_config_path = ai::config::default_ai_config_path();
            let ai_config = ai::config::AiConfig::load(&ai_config_path);
            let ai_ctx = ai::AppAiCtx::from_config(ai_config, vault_arc.clone());

            app.manage(AppState::new(conn, vault_arc, ai_ctx));

            // Auto-start any tunnels with autostart=true.
            let app_for_autostart = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tunnel::autostart_tunnels(app_for_autostart).await;
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Some(main_window_config) = app.config().app.windows.first().cloned() {
                WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?
                    // Required on Linux/Windows for navigator.clipboard.readText().
                    // Terminal right-click paste and Shift+Insert use that API.
                    .enable_clipboard_access()
                    .build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::list_local_shells,
            wsl::list_wsl_distros,
            terminal::open_local_shell_as_administrator,
            terminal::create_local_terminal,
            terminal::create_ssh_terminal,
            terminal::test_ssh_connection,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::send_terminal_signal,
            terminal::close_terminal,
            session::list_sessions,
            session::get_session,
            session::save_session,
            session::delete_session,
            session::mark_session_connected,
            session::list_session_groups,
            session::save_session_group,
            session::delete_session_group,
            session::import::import_putty_sessions,
            session::import::import_wsl_sessions,
            session::import::import_external_bash_sessions,
            session::import::scan_local_session_files,
            session::import::read_plist_session_file,
            session::import_secrets::keychain::keychain_lookup_batch,
            session::import_secrets::tabby::tabby_decrypt_vault,
            filebrowser::sftp_attach,
            filebrowser::sftp_detach,
            filebrowser::sftp_list_remote,
            filebrowser::sftp_list_local,
            filebrowser::sftp_local_home,
            filebrowser::sftp_local_drives,
            filebrowser::sftp_mkdir,
            filebrowser::sftp_remove,
            filebrowser::sftp_rename,
            filebrowser::sftp_stat,
            filebrowser::sftp_chmod,
            filebrowser::sftp_realpath,
            filebrowser::sftp_open_path,
            filebrowser::sftp_read_file_text,
            filebrowser::sftp_write_file_text,
            filebrowser::sftp_upload,
            filebrowser::sftp_download,
            filebrowser::sftp_upload_dir,
            filebrowser::sftp_download_dir,
            filebrowser::sftp_upload_bytes,
            filebrowser::sftp_download_bytes,
            filebrowser::sftp_cancel_transfer,
            filebrowser::sftp_pause_transfer,
            filebrowser::sftp_resume_transfer,
            filebrowser::open_sftp_window,
            appearance::list_system_fonts,
            config::select_private_key_file,
            config::select_upload_file,
            config::select_save_directory,
            config::select_save_file_path,
            config::select_file_path,
            config::select_folder_path,
            config::read_file_bytes,
            config::read_stream_open,
            config::read_stream_read,
            config::read_stream_close,
            config::write_stream_open,
            config::write_stream_append,
            config::write_stream_close,
            config::write_stream_abort,
            config::check_file_exists,
            config::clipboard_read_text,
            config::clipboard_write_text,
            tunnel::list_tunnels,
            tunnel::upsert_tunnel,
            tunnel::delete_tunnel,
            tunnel::start_tunnel,
            tunnel::stop_tunnel,
            tunnel::start_all_tunnels,
            tunnel::stop_all_tunnels,
            tunnel::reorder_tunnels,
            tunnel::test_tunnel,
            tunnel::get_tunnel_status,
            tunnel::list_tunnel_statuses,
            vnc::vnc_connect,
            vnc::vnc_disconnect,
            vnc::vnc_test_connection,
            rdp::rdp_connect,
            rdp::rdp_disconnect,
            rdp::rdp_test_connection,
            history::history_append,
            history::history_match_prefix,
            history::history_list_recent,
            history::history_clear,
            vault::vault_status,
            vault::vault_init,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_change_master,
            vault::vault_put,
            vault::vault_update,
            vault::vault_delete,
            vault::vault_list,
            ai::commands::get_ai_config,
            ai::commands::save_ai_config,
            ai::commands::save_ai_api_key,
            ai::commands::test_llm_connection,
            ai::commands::generate_shell_command,
            ai::commands::update_shell_audit_outcome,
            ai::session_safety::is_session_ai_write_disabled,
            tab::tab_suggest_path,
            tab::tab_suggest_fim,
            tab::tab_rewrite_command,
            agent::commands::agent_explain_error,
            agent::commands::agent_plan_tool,
            agent::commands::agent_execute_tool,
            agent::commands::agent_run,
            agent::search::commands::web_search_execute,
            agent::search::commands::deep_search_execute,
            agent::search::commands::searxng_availability,
            agent::search::commands::web_fetch_execute,
            agent::search::commands::probe_searxng_instances,
            agent::search::commands::provider_caps,
            agent::search::key_storage::keyring_put,
            agent::search::key_storage::keyring_get,
            agent::search::key_storage::keyring_delete,
            agent::cc_bridge::commands::cc_detect,
            agent::cc_bridge::commands::cc_send_message,
            agent::cc_bridge::commands::cc_stream_message,
            agent::cc_bridge::commands::cc_stop_session,
            agent::mcp_server::mcp_server_start,
            agent::mcp_server::mcp_server_stop,
            agent::mcp_server::mcp_server_status,
            chat::chat_new_thread,
            chat::chat_list_threads,
            chat::chat_list_messages,
            chat::chat_delete_thread,
            chat::chat_set_thread_provider,
            chat::chat_set_thread_output_format,
            chat::chat_purge_old,
            chat::chat_export_archive,
            chat::chat_send,
            chat::chat_stream,
            chat::inline_qq::inline_qq_stream,
            models::models_list,
            models::models_download,
            models::models_delete,
            models::models_verify,
            models::cuda_pack_status,
            models::cuda_pack_install,
            models::cuda_pack_uninstall,
            models::mirror_get_config,
            models::mirror_set_config,
            llm::llama_server::sidecar_start,
            llm::llama_server::sidecar_stop,
            llm::llama_server::sidecar_status,
            perf::perf_baseline_recent,
            voice::commands::voice_capture_supported,
            voice::commands::voice_start_capture,
            voice::commands::voice_stop_capture,
            voice::commands::voice_stop_and_transcribe,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
