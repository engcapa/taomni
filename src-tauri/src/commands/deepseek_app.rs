pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::deepseek_app::deepseek_app_send,
        crate::deepseek_app::deepseek_app_stop,
    ];
    handler(invoke)
}
