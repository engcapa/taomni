pub(super) fn handle(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        crate::workspace_tooling::maven::workspace_ingest_maven_project,
        crate::workspace_tooling::gradle::workspace_ingest_gradle_project,
    ];
    handler(invoke)
}
