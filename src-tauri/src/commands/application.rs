pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![crate::exit_app, crate::commands::application::restart_app,];
    handler(invoke)
}

#[tauri::command]
async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    crate::runtime::shutdown::request(app, crate::runtime::shutdown::ExitAction::Restart).await
}
