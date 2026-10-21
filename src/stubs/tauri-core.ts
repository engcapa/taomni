import { voiceStub } from "./voiceStub";
import { installStubMailQaControl } from "./mailServerStub";
import { stubMfaInvoke } from "./mfaStub";
import { parity008Handles, parity008Invoke } from "./parity008Git";
import { CommandRegistry } from "./commands/registry";
import { mailStubSeed, invokeMail } from "./commands/mail";
import { type InvokeOptions } from "./commands/runtime";
import { loadStubVault, invokeVault } from "./commands/vault";
import { invokeApplication } from "./commands/application";
import { invokeTerminal } from "./commands/terminal";
import { invokeWorkspace } from "./commands/workspace";
import { invokeSession } from "./commands/session";
import { invokeFiles } from "./commands/files";
import { invokeSdk } from "./commands/sdk";
import { invokeLsp } from "./commands/lsp";
import { invokeRemoteDesktop } from "./commands/remoteDesktop";
import { invokeServers } from "./commands/servers";
import { invokeSockscap } from "./commands/sockscap";
import { invokeTunnel } from "./commands/tunnel";
import { invokeChat } from "./commands/chat";
import { invokeDatabase } from "./commands/database";
import { invokeLanchat } from "./commands/lanchat";
import { invokeNotes } from "./commands/notes";
import { invokeScreenshot } from "./commands/screenshot";

const stubCommandRegistry = new CommandRegistry();

if (typeof window !== "undefined") installStubMailQaControl(mailStubSeed);

export async function invoke<T>(cmd: string, args?: any, options?: InvokeOptions): Promise<T> {
  if (cmd === "backup_get_policy") {
    return JSON.parse(localStorage.getItem("taomni.backup.policy") || JSON.stringify({
      autoBackupEnabled: false, frequency: "weekly", maxRetainedCopies: 7,
      defaultScope: "core", includeMail: null, lastBackupAt: null,
    })) as T;
  }
  if (cmd === "backup_set_policy") {
    localStorage.setItem("taomni.backup.policy", JSON.stringify((args as { policy: unknown }).policy));
    return undefined as T;
  }
  if (cmd === "backup_list_history") return [] as T;
  if (cmd === "backup_get_default_dir") return "/preview/backups" as T;
  if (cmd.startsWith("backup_remote_") || cmd.startsWith("backup_feishu_")) {
    return await (await import("./remoteBackupStub")).remoteBackupStub(cmd, args) as T;
  }
  // ED-PARITY-008 isolated two-repository Git fixture (opt-in via localStorage).
  if (parity008Handles(cmd, args)) return await parity008Invoke(cmd, args) as T;
  // MFA authenticator: localStorage mirror of mfa.db gated by the stub vault.
  if (cmd.startsWith("mfa_")) {
    const vault = loadStubVault();
    return await stubMfaInvoke(cmd, args, vault.state === "unlocked", vault.masterPassword) as T;
  }
  if (cmd.startsWith("voice_")) return await voiceStub(cmd, args) as T;
  if (stubCommandRegistry.has(cmd)) return stubCommandRegistry.invoke<T>(cmd, args, options);
  console.warn(`[tauri-stub] Unknown invoke command: ${cmd}`, args);
  if (cmd === "history_match_prefix" || cmd === "history_list_recent") return [] as T;
  return undefined as T;
}

for (const command of ["recovery_get","recovery_update","recovery_ready","list_system_fonts","clipboard_read_text","clipboard_write_text","git_blame_lines","exit_app","open_sftp_window","close_current_detached_window","open_detached_window","probe_system_rdp","open_system_rdp_settings","mirror_get_config","mirror_set_config","cuda_pack_status","get_opencode_go_catalog","get_provider_models","test_llm_model","test_llm_connection","get_ai_config","save_ai_config","save_ai_api_key"]) {
  stubCommandRegistry.register({ domain: "application", command, handler: (args) => invokeApplication(command, args) });
}

for (const command of ["attach_terminal_output","detach_terminal_output","detect_x_server","list_local_shells","list_wsl_distros","list_common_local_directories","record_local_directory_use","history_snapshot","history_list","history_read","history_prune","create_local_terminal","create_ssh_terminal","submit_ssh_auth_response","test_ssh_connection","write_terminal","resize_terminal","send_terminal_signal","close_terminal"]) {
  stubCommandRegistry.register({ domain: "terminal", command, handler: (args) => invokeTerminal(command, args) });
}

for (const command of ["structural_search_capabilities","structural_search_run","structural_search_cancel","workspace_ingest_maven_project","workspace_list_dir","workspace_compact_chain","workspace_list_files_recursive","workspace_read_file","workspace_detect_git_roots","workspace_read_loose_file","workspace_read_file_with_encoding","workspace_read_loose_file_with_encoding","workspace_write_file","workspace_write_loose_file","workspace_search_start","workspace_search_cancel","workspace_write_file_encoded","workspace_write_loose_file_encoded","workspace_create_file","workspace_create_dir","workspace_delete_path","workspace_rename_path","workspace_apply_resource_operation","workspace_detect_tasks","workspace_java_run_targets","workspace_task_tree","workspace_dependency_tree","workspace_execution_model","workspace_test_results"]) {
  stubCommandRegistry.register({ domain: "workspace", command, handler: (args) => invokeWorkspace(command, args) });
}

for (const command of ["list_sessions","get_session","save_session","delete_session","mark_session_connected","list_session_groups","save_session_group","delete_session_group","get_welcome_run_snapshot","commit_welcome_run_snapshot","clear_welcome_run_snapshot"]) {
  stubCommandRegistry.register({ domain: "session", command, handler: (args) => invokeSession(command, args) });
}

for (const command of ["vault_status","vault_init","vault_unlock","vault_lock","vault_change_master","vault_put","vault_update","vault_delete","vault_list"]) {
  stubCommandRegistry.register({ domain: "vault", command, handler: (args) => invokeVault(command, args) });
}

for (const command of ["select_private_key_file","select_upload_file","select_save_directory","select_save_file_path","select_file_path","select_folder_path","read_file_bytes","check_file_exists","read_plist_session_file","read_stream_open","read_stream_read","read_stream_close","write_stream_open","write_stream_append","write_stream_close","write_stream_abort","temporary_file_path","open_local_shell_as_administrator","sftp_attach","sftp_detach","sftp_list_remote","sftp_list_local","sftp_list_local_detailed","sftp_local_home","sftp_local_drives","sftp_mkdir","sftp_remove","sftp_rename","sftp_stat","sftp_chmod","sftp_upload_dir","sftp_download_dir","sftp_realpath","sftp_read_file_text","sftp_write_file_text","sftp_upload","sftp_download","sftp_upload_bytes","sftp_download_bytes","sftp_cancel_transfer","sftp_pause_transfer","sftp_resume_transfer","sftp_open_path"]) {
  stubCommandRegistry.register({ domain: "files", command, handler: (args, options) => invokeFiles(command, args, options) });
}

for (const command of ["sdk_get_registry","sdk_probe_installation","sdk_discover_installations","sdk_save_installation","sdk_remove_installation","sdk_refresh_installations","sdk_set_default","sdk_save_workspace_binding","sdk_remove_workspace_binding","sdk_analyze_workspace","sdk_resolve_workspace"]) {
  stubCommandRegistry.register({ domain: "sdk", command, handler: (args) => invokeSdk(command, args) });
}

for (const command of ["lsp_list_presets","lsp_set_java_home","lsp_set_java_vmargs","lsp_resolve_show_message_request","lsp_cancel_work_done_progress","lsp_detect_servers","lsp_document_status","lsp_open_document","lsp_change_document","lsp_save_document","lsp_close_document","lsp_completion","lsp_completion_resolve","lsp_stop_workspace","lsp_workspace_will_file_operation","lsp_workspace_did_file_operation","lsp_get_diagnostics","lsp_hover","lsp_signature_help","lsp_java_project_model","lsp_definition","lsp_declaration","lsp_type_definition","lsp_implementation","lsp_references","lsp_workspace_symbols","lsp_workspace_symbol_resolve","lsp_read_uri_contents","lsp_download_sources","lsp_prepare_call_hierarchy","lsp_prepare_type_hierarchy","lsp_type_hierarchy_supertypes","lsp_type_hierarchy_subtypes","lsp_call_hierarchy_incoming","lsp_call_hierarchy_outgoing","lsp_document_highlights","lsp_inlay_hints","lsp_selection_ranges","lsp_code_actions","lsp_code_action_resolve","lsp_document_symbols","lsp_prepare_rename","lsp_rename","lsp_semantic_tokens","lsp_set_java_bundles","lsp_detect_java_bundles","lsp_discover_java_bundles","java_tools_status","java_tools_discover","dap_start_session","dap_send_request","dap_send","dap_terminate","java_debug_resolve_main_classes","java_tools_install","java_test_discover","java_test_resolve_launch","dependency_index_status","dependency_index_search","dependency_index_versions"]) {
  stubCommandRegistry.register({ domain: "lsp", command, handler: (args) => invokeLsp(command, args) });
}

for (const command of ["vnc_connect","vnc_test_connection","vnc_disconnect","vnc_cancel_connect","rdp_connect","rdp_disconnect","rdp_test_connection"]) {
  stubCommandRegistry.register({ domain: "remoteDesktop", command, handler: (args) => invokeRemoteDesktop(command, args) });
}

for (const command of ["load_server_configs","save_server_config","list_server_statuses","list_server_logs","clear_server_log","get_server_status","stop_local_server","start_local_server"]) {
  stubCommandRegistry.register({ domain: "servers", command, handler: (args) => invokeServers(command, args) });
}

for (const command of ["sockscap_capabilities","sockscap_redirector_install_status","sockscap_install_redirector","sockscap_get_config","sockscap_validate_macos_app","sockscap_set_config","sockscap_gfwlist_status","sockscap_refresh_gfwlist","sockscap_import_rules","sockscap_test_target","sockscap_status","sockscap_diagnostics","sockscap_start","sockscap_launch_app","sockscap_launch_terminal_app","sockscap_launched_apps","sockscap_stop_launched_app","sockscap_stop","sockscap_recover","sockscap_stats_snapshot","sockscap_get_domain_records","sockscap_clear_domain_records","sockscap_list_processes","sockscap_detect_local_proxies","sockscap_detect_tun_conflicts","sockscap_test_upstream","sockscap_helper_status","sockscap_helper_start","sockscap_helper_stop","sockscap_helper_probe_windivert"]) {
  stubCommandRegistry.register({ domain: "sockscap", command, handler: (args) => invokeSockscap(command, args) });
}

for (const command of ["list_tunnels","upsert_tunnel","delete_tunnel","start_tunnel","stop_tunnel","start_all_tunnels","stop_all_tunnels","get_tunnel_status","list_tunnel_statuses","test_tunnel","reorder_tunnels"]) {
  stubCommandRegistry.register({ domain: "tunnel", command, handler: (args) => invokeTunnel(command, args) });
}

for (const command of ["chat_list_threads","chat_new_thread","chat_list_messages","chat_set_thread_provider","chat_set_thread_llm_model","chat_set_thread_cc_model","chat_set_thread_output_format","chat_delete_thread","chat_purge_old","chat_stop_stream","acp_probe_profile","chat_stat_attachment_paths","chat_read_clipboard_image_attachment","chat_send","chat_generate_media"]) {
  stubCommandRegistry.register({ domain: "chat", command, handler: (args) => invokeChat(command, args) });
}

for (const command of ["mail_archive_start","mail_archive_pause","mail_archive_status","mail_archive_query","mail_archive_preview_cleanup","mail_archive_cleanup","mail_archive_list","mail_archive_read","mail_archive_export","mail_archive_attachment","mail_archive_remove","mail_list_cached_folders","mail_list_cached_messages","mail_sync_headers","mail_idle_start","mail_idle_stop","mail_sync_folder","mail_sync_all_folders","mail_autoconfig","mail_list_folders","mail_set_folder_subscription","mail_prefetch_message_body","mail_get_message_body","mail_download_attachment","mail_mark_read","mail_send_message","mail_list_filters","mail_save_filters","mail_apply_filters","mail_export_filters","mail_import_filters","mail_get_invite","mail_respond_invite","mail_set_flags","mail_move_messages","mail_copy_messages","mail_delete_messages","mail_search_messages","mail_search_server","mail_store_remote_draft","mail_discard_remote_draft","mail_list_drafts","mail_save_draft","mail_delete_draft","mail_index_cached_contacts","mail_search_contacts","mail_list_address_book","mail_save_address_book_entry","mail_delete_address_book_entry","mail_import_vcards","mail_export_vcards","mail_carddav_sync","mail_send_receipt","mail_list_agenda","mail_caldav_sync","mail_add_invite_to_calendar","mail_test_connection","mail_oauth_authorize","mail_oauth_device_start","mail_oauth_device_complete","mail_clear_cache"]) {
  stubCommandRegistry.register({ domain: "mail", command, handler: (args) => invokeMail(command, args) });
}

for (const command of ["db_append_history","db_list_history","db_delete_history","db_clear_history","db_update_history_tab_name","db_load_query_workspace","db_save_query_workspace","db_close_query_workspace_tabs","db_list_closed_query_workspace_tabs","db_reopen_query_workspace_tab","db_list_saved_queries","db_get_saved_query","db_save_saved_query","db_archive_saved_query","db_delete_saved_query","db_connect","db_ping","db_disconnect","db_list_catalogs","db_list_schemas","db_list_tables","db_describe_table","db_list_foreign_keys","db_list_indexes","db_execute","db_execute_stream","db_cancel","redis_list_keys","redis_get_key","redis_set_key","redis_del_key","redis_exec","hbase_connect","hbase_ping","hbase_disconnect","hbase_list_tables","hbase_describe_table","hbase_execute"]) {
  stubCommandRegistry.register({ domain: "database", command, handler: (args) => invokeDatabase(command, args) });
}

for (const command of ["lanchat_status","lanchat_list_peers","lanchat_get_profile","lanchat_list_conversations","lanchat_list_groups","lanchat_list_messages","lanchat_mark_read","lanchat_open_path","lanchat_send_text","lanchat_send_group_text","lanchat_resend_message","lanchat_update_profile","lanchat_create_group","lanchat_leave_group","lanchat_send_file","lanchat_send_group_file","lanchat_send_dir","lanchat_accept_file","lanchat_reject_file","lanchat_transfer_control","lanchat_send_screenshot","lanchat_send_clipboard_image","lanchat_send_signal","lanchat_signal_group"]) {
  stubCommandRegistry.register({ domain: "lanchat", command, handler: (args) => invokeLanchat(command, args) });
}

for (const command of ["notes_list","notes_get","notes_create","notes_update","notes_delete","notes_toggle_complete","notes_archive","notes_list_tags","notes_upsert_tags","notes_set_steps","notes_get_prefs","notes_set_prefs","notes_list_alerts","notes_ack_alert"]) {
  stubCommandRegistry.register({ domain: "notes", command, handler: (args) => invokeNotes(command, args) });
}

for (const command of ["screenshot_list_displays","screenshot_switch_display","screenshot_overlay_init","screenshot_open_overlay","screenshot_close_overlay","screenshot_capture_full","screenshot_capture_region","screenshot_scroll_surface","screenshot_scroll_plan","screenshot_scroll_status","screenshot_set_scroll_mode","screenshot_stop_scroll_capture","screenshot_recording_status","screenshot_scroll_capture","screenshot_overlay_update","screenshot_save_data_url","screenshot_read_file","screenshot_copy_image","screenshot_set_pin_compact","screenshot_save_image","screenshot_close_pin","screenshot_pin_to_screen","screenshot_pin_init","screenshot_update_pin","screenshot_open_pin_tools","screenshot_pin_tools_init","screenshot_close_pin_tools","screenshot_set_pin_note","screenshot_list_pins","screenshot_board_pins","screenshot_arrange_pins","screenshot_pins_batch","screenshot_focus_pin","screenshot_edit_pin","screenshot_open_editor","screenshot_list_favorites","screenshot_add_favorite","screenshot_remove_favorite","screenshot_favorite_thumbnail","screenshot_pin_favorite","screenshot_ocr","screenshot_auto_redact","screenshot_probe","screenshot_start_recording","screenshot_stop_recording","screenshot_cancel_recording","screenshot_current_recording","screenshot_shortcut_status","screenshot_shortcut_set"]) {
  stubCommandRegistry.register({ domain: "screenshot", command, handler: (args) => invokeScreenshot(command, args) });
}

export { Channel, Resource, PluginListener, addPluginListener, convertFileSrc } from "./commands/runtime";

export { stubPinToolAction } from "./commands/screenshot";
