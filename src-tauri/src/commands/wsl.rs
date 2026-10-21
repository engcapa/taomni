pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![crate::wsl::list_wsl_distros,];
    handler(invoke)
}
