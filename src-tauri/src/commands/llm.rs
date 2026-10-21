pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::llm::llama_server::sidecar_start,
        crate::llm::llama_server::sidecar_stop,
        crate::llm::llama_server::sidecar_status,
    ];
    handler(invoke)
}
