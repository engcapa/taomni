pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![crate::workspace_execution::workspace_execution_model,];
    handler(invoke)
}
