pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::terminal::detach_terminal_output,
        crate::terminal::list_local_shells,
        crate::terminal::list_common_local_directories,
        crate::terminal::record_local_directory_use,
        crate::terminal::detect_x_server,
        crate::terminal::open_local_shell_as_administrator,
        crate::terminal::create_local_terminal,
        crate::terminal::create_command_terminal,
        crate::terminal::create_ssh_terminal,
        crate::terminal::submit_ssh_auth_response,
        crate::terminal::attach_terminal_output,
        crate::terminal::keygen::generate_ssh_key,
        crate::terminal::test_ssh_connection,
        crate::terminal::test_proxy_connection,
        crate::terminal::write_terminal,
        crate::terminal::resize_terminal,
        crate::terminal::send_terminal_signal,
        crate::terminal::close_terminal,
    ];
    handler(invoke)
}
