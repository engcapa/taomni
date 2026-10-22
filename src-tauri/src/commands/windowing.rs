pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::windowing::open_detached_window,
        crate::windowing::close_current_detached_window,
    ];
    handler(invoke)
}
